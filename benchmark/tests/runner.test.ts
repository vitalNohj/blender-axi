import { describe, expect, it } from "vitest";
import { access, cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatePlan, savePlan } from "../src/plan.js";
import {
	infrastructureFailure,
	measuredCost,
	runSweep,
	SyntheticAgentAdapter,
	stopReason,
} from "../src/runner.js";
import type { AgentAdapter } from "../src/runner.js";
import type { AttemptRecord } from "../src/types.js";

const benchmarkRoot = resolve("benchmark");

describe("resume-safe sweep", () => {
	it("appends once and avoids duplicate cells after resume", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-runner-"));
		const planPath = join(root, "plan.json");
		const runs = join(root, "runs");
		const scenarios = join(root, "scenarios");
		await mkdir(scenarios);
		const plan = await generatePlan(benchmarkRoot, {
			kind: "selected",
			taskIds: ["P1"],
			replicates: 1,
			seed: 42,
		});
		await savePlan(planPath, plan);
		const adapter = new SyntheticAgentAdapter(scenarios);
		const first = await runSweep({
			benchmarkRoot,
			planPath,
			runsRoot: runs,
			adapter,
		});
		expect(first.attempted).toBe(2);
		const second = await runSweep({
			benchmarkRoot,
			planPath,
			runsRoot: runs,
			adapter,
		});
		expect(second).toMatchObject({ attempted: 0, skipped_completed: 2 });
		const lines = (await readFile(join(runs, "results.jsonl"), "utf8"))
			.trim()
			.split("\n");
		expect(lines).toHaveLength(2);
		expect(new Set(lines.map((line) => JSON.parse(line).run_id)).size).toBe(2);
	}, 30_000);

	it("rejects unknown selected cells before creating campaign state", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-selected-"));
		const planPath = join(root, "plan.json");
		const runs = join(root, "runs");
		await savePlan(
			planPath,
			await generatePlan(benchmarkRoot, {
				kind: "selected",
				taskIds: ["P1"],
				replicates: 1,
				seed: 42,
			}),
		);
		await expect(
			runSweep({
				benchmarkRoot,
				planPath,
				runsRoot: runs,
				selectedCells: ["missing"],
				adapter: new SyntheticAgentAdapter(root),
			}),
		).rejects.toThrow(/Unknown selected cell/u);
		await expect(access(runs)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("records provider launch failures as infrastructure-invalid", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-invalid-"));
		const planPath = join(root, "plan.json");
		const runs = join(root, "runs");
		const plan = await generatePlan(benchmarkRoot, {
			kind: "selected",
			taskIds: ["P1"],
			replicates: 1,
			seed: 42,
		});
		await savePlan(planPath, plan);
		const adapter: AgentAdapter = {
			async run() {
				throw new Error("provider unavailable");
			},
		};
		await runSweep({
			benchmarkRoot,
			planPath,
			runsRoot: runs,
			selectedCells: [plan.cells[0]!.cell_id],
			adapter,
		});
		const [record] = (await readFile(join(runs, "results.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as AttemptRecord);
		expect(record).toMatchObject({
			validity: { status: "invalid" },
			outcome: { status: "infrastructure_invalid", failure_stage: "infrastructure" },
			scores: { deterministic_structure_0_100: null },
		});
	}, 30_000);
});

describe("ceiling stops", () => {
	const config = {
		versions: {},
		model: { provider: null, id: null, effort: null, agent_cli: null },
		limits: {
			max_wall_seconds: 100,
			max_invalid_attempts: 2,
			max_critical_failures: 1,
			port_min: 1,
			port_max: 2,
		},
	};
	it("stops on wall time, invalid attempts, and critical failures", () => {
		const base = {
			usage: { api_cost_usd: null },
			validity: { status: "valid" },
			outcome: { critical_failure: false },
		} as unknown as AttemptRecord;
		expect(stopReason([base], config, 0)).toBeNull();
		expect(stopReason([], config, 100)).toBe("wall_time_ceiling");
		const invalid = {
			...base,
			validity: { status: "invalid" },
		} as AttemptRecord;
		expect(stopReason([invalid, invalid], config, 0)).toBe(
			"invalid_attempt_ceiling",
		);
		const critical = {
			...base,
			outcome: { critical_failure: true },
		} as AttemptRecord;
		expect(stopReason([critical], config, 0)).toBe("critical_failure_ceiling");
	});

	it("never stops on a dollar ceiling because cost is excluded", () => {
		const expensive = {
			usage: { api_cost_usd: 1000 },
			validity: { status: "valid" },
			outcome: { critical_failure: false },
		} as unknown as AttemptRecord;
		expect(stopReason([expensive, expensive], config, 0)).toBeNull();
	});

	it("aborts the active cell at the campaign wall-time deadline", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-campaign-wall-"));
		const isolatedBenchmark = join(root, "benchmark");
		await cp(benchmarkRoot, isolatedBenchmark, { recursive: true });
		const frozenPath = join(isolatedBenchmark, "config", "frozen.json");
		const frozen = JSON.parse(await readFile(frozenPath, "utf8")) as {
			limits: { max_wall_seconds: number };
		};
		frozen.limits.max_wall_seconds = 0.2;
		await writeFile(frozenPath, `${JSON.stringify(frozen, null, 2)}\n`);
		const planPath = join(root, "plan.json");
		const plan = await generatePlan(isolatedBenchmark, {
			kind: "selected",
			taskIds: ["P1"],
			replicates: 1,
			seed: 42,
		});
		await savePlan(planPath, plan);
		let aborted = false;
		const adapter: AgentAdapter = {
			async run(input) {
				await new Promise<void>((_resolvePromise, reject) => {
					input.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(input.signal?.reason);
						},
						{ once: true },
					);
				});
				throw new Error("unreachable");
			},
		};
		const result = await runSweep({
			benchmarkRoot: isolatedBenchmark,
			planPath,
			runsRoot: join(root, "runs"),
			selectedCells: [plan.cells[0]!.cell_id],
			adapter,
		});
		expect(aborted).toBe(true);
		expect(result).toMatchObject({
			attempted: 0,
			stopped_reason: "wall_time_ceiling",
		});
	}, 10_000);
});

describe("measured cost only", () => {
	it("reports a genuine provider-reported cost", () => {
		expect(measuredCost({ api_cost_usd: 0.42 })).toBe(0.42);
	});

	it("never presents a zero catalog price as a measured cost", () => {
		expect(measuredCost({ api_cost_usd: 0 })).toBeNull();
	});

	it("stays honestly null when the provider reports nothing", () => {
		expect(measuredCost({})).toBeNull();
		expect(measuredCost({ api_cost_usd: null })).toBeNull();
	});

	it("never derives a cost from token counts and a frozen rate sheet", () => {
		expect(
			measuredCost({
				provider_input_tokens_uncached: 100_000,
				provider_output_tokens: 50_000,
				provider_reasoning_tokens: 25_000,
			}),
		).toBeNull();
	});
});

describe("infrastructure capture", () => {
	it("produces invalid status and null unavailable metrics", async () => {
		const task = (await import("../src/fixtures.js").then(({ loadTasks }) =>
			loadTasks(benchmarkRoot),
		)).find((item) => item.id === "P1")!;
		expect(infrastructureFailure(task, "run", new Error("provider failed"))).toMatchObject({
			grade: {
				status: "infrastructure_invalid",
				deterministic_structure_0_100: null,
			},
			validity: {
				status: "invalid",
				invalid_reason: "infrastructure_error:provider failed",
			},
		});
	});
});
