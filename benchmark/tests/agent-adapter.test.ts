import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommandAgentAdapter } from "../src/agent-adapter.js";
import { loadTasks } from "../src/fixtures.js";
import { sanitizedEnvironment } from "../src/isolation.js";
import { buildAttemptRecord } from "../src/record.js";
import type { GradeResult } from "../src/grading.js";
import type { PlanCell, TaskManifest } from "../src/types.js";

const benchmarkRoot = resolve("benchmark");

const cell: PlanCell = {
	cell_id: "adapter-cell",
	pair_id: "adapter-pair",
	task_id: "P1",
	replicate: 1,
	arm: "axi",
	order_in_pair: 1,
	sequence: "AXI_MCP",
	seed: 1,
	cache_regime: "cold",
	replacement_for: null,
};

const grade: GradeResult = {
	schema_version: "1.0.0",
	task_id: "P1",
	run_id: "adapter-cell",
	status: "wrong_artifact",
	functional_success: false,
	critical_failure: false,
	deterministic_structure_0_100: 0,
	unity_readiness_0_100: null,
	hard_failure_ids: [],
	oracle_results: [],
};

async function harness(script: string): Promise<{
	adapter: CommandAgentAdapter;
	runRoot: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "blend-bench-adapter-"));
	const fakeBenchmarkRoot = join(root, "benchmark");
	await mkdir(join(fakeBenchmarkRoot, "config"), { recursive: true });
	const executable = join(root, "provider.sh");
	await writeFile(executable, script);
	await chmod(executable, 0o755);
	await writeFile(
		join(fakeBenchmarkRoot, "config", "agent-command.json"),
		JSON.stringify({
			protocol: "jsonl-stdout-v1",
			executable,
			common_args: [],
			arm_args: { axi: [], mcp: [] },
			required_fresh_session_args: ["--print"],
			required_disable_ambient_args: ["--no-extensions"],
			credential_environment_variables: [],
		}),
	);
	const runRoot = join(root, "run");
	for (const directory of ["transcript", "logs", "output", "oracles"])
		await mkdir(join(runRoot, directory), { recursive: true });
	await writeFile(join(runRoot, "owned-processes.json"), "[]");
	return { adapter: new CommandAgentAdapter(fakeBenchmarkRoot), runRoot };
}

async function p1(timeoutSeconds: number): Promise<TaskManifest> {
	const task = (await loadTasks(benchmarkRoot)).find((item) => item.id === "P1")!;
	return { ...task, timeout_seconds: timeoutSeconds };
}

async function record(
	task: TaskManifest,
	result: Awaited<ReturnType<CommandAgentAdapter["run"]>>,
	runRoot: string,
) {
	return await buildAttemptRecord({
		cell,
		task,
		runId: cell.cell_id,
		runRoot,
		fixtureHashBefore: "before",
		fixtureHashAfter: null,
		baseInstructions: "base",
		conditionInstructions: "condition",
		interfaceSurface: "surface",
		fullTranscript: result.transcript,
		events: [],
		answer: result.answer,
		grade,
		startedAt: new Date(0).toISOString(),
		endedAt: new Date(1000).toISOString(),
		wallSeconds: 1,
		port: 19001,
		versions: {},
		usage: result.usage,
		cache: result.cache,
		timing: { blender_launch_seconds: null, timed_out: result.timedOut ?? false },
	});
}

describe("adapter timeout propagation", () => {
	it("records a real timeout as timed_out in the public attempt record", async () => {
		const { adapter, runRoot } = await harness(
			[
				"#!/bin/sh",
				"cat > /dev/null",
				'echo \x27{"type":"benchmark_envelope","answer":"partial","usage":{"provider_output_tokens":7,"agent_turns":1}}\x27',
				"sleep 30",
			].join("\n"),
		);
		const task = await p1(2);
		const result = await adapter.run({
			cell,
			task,
			runRoot,
			port: 19001,
			environment: { ...process.env },
			baseInstructions: "base",
			conditionInstructions: "condition",
		});
		expect(result.timedOut).toBe(true);
		expect(result.answer).toContain("[benchmark timeout]");
		const attempt = await record(task, result, runRoot);
		expect(attempt.timing.timed_out).toBe(true);
		expect(attempt.timing.timeout_seconds).toBe(2);
		// A timeout must not silently discard the usage the provider did report.
		expect(attempt.usage.provider_output_tokens).toBe(7);
	}, 30_000);

	it("records a clean completion as not timed out", async () => {
		const { adapter, runRoot } = await harness(
			[
				"#!/bin/sh",
				"cat > /dev/null",
				'echo \x27{"type":"benchmark_envelope","answer":"done","usage":{"provider_output_tokens":11,"agent_turns":1}}\x27',
			].join("\n"),
		);
		const task = await p1(30);
		const result = await adapter.run({
			cell,
			task,
			runRoot,
			port: 19001,
			environment: { ...process.env },
			baseInstructions: "base",
			conditionInstructions: "condition",
		});
		expect(result.timedOut).toBe(false);
		expect(result.answer).not.toContain("[benchmark timeout]");
		const attempt = await record(task, result, runRoot);
		expect(attempt.timing.timed_out).toBe(false);
		expect(attempt.usage.provider_output_tokens).toBe(11);
	}, 30_000);
});

describe("provider process-tree cleanup", () => {
	it("leaves no surviving grandchild after a timeout", async () => {
		const { adapter, runRoot } = await harness(
			[
				"#!/bin/sh",
				"cat > /dev/null",
				// Stand-in for the pinned BlenderMCP server the wrapper spawns.
				"sleep 120 &",
				'echo "{\\"grandchild_pid\\":$!}" >&2',
				"sleep 120",
			].join("\n"),
		);
		const task = await p1(2);
		const result = await adapter.run({
			cell,
			task,
			runRoot,
			port: 19001,
			environment: { ...process.env },
			baseInstructions: "base",
			conditionInstructions: "condition",
		});
		expect(result.timedOut).toBe(true);
		const stderr = await readFile(join(runRoot, "logs", "agent.stderr.log"), "utf8");
		const grandchild = Number(
			(JSON.parse(stderr.trim().split("\n")[0]!) as { grandchild_pid: number })
				.grandchild_pid,
		);
		expect(Number.isInteger(grandchild)).toBe(true);
		await new Promise((done) => setTimeout(done, 500));
		const alive = (() => {
			try {
				process.kill(grandchild, 0);
				return true;
			} catch {
				return false;
			}
		})();
		expect(alive).toBe(false);
	}, 30_000);

	it("leaves no surviving grandchild after an external abort", async () => {
		const { adapter, runRoot } = await harness(
			[
				"#!/bin/sh",
				"cat > /dev/null",
				"sleep 120 &",
				'echo "{\\"grandchild_pid\\":$!}" >&2',
				"sleep 120",
			].join("\n"),
		);
		const controller = new AbortController();
		const run = adapter.run({
			cell,
			task: await p1(30),
			runRoot,
			port: 19001,
			environment: { ...process.env },
			baseInstructions: "base",
			conditionInstructions: "condition",
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(new Error("host interrupt")), 250);
		await expect(run).rejects.toThrow("host interrupt");
		const stderr = await readFile(join(runRoot, "logs", "agent.stderr.log"), "utf8");
		const grandchild = Number(
			(JSON.parse(stderr.trim().split("\n")[0]!) as { grandchild_pid: number })
				.grandchild_pid,
		);
		expect(() => process.kill(grandchild, 0)).toThrow();
	}, 10_000);
});

describe("pinned BlenderMCP server addressing", () => {
	it("points the MCP server at the isolated cell port, not the default 9876", () => {
		const layout = {
			root: "/tmp/run",
			fixture: "/tmp/run/fixture",
			workspace: "/tmp/run/workspace",
			output: "/tmp/run/output",
			logs: "/tmp/run/logs",
			transcript: "/tmp/run/transcript",
			artifacts: "/tmp/run/artifacts",
			oracles: "/tmp/run/oracles",
			processRegistry: "/tmp/run/owned-processes.json",
		};
		const environment = sanitizedEnvironment(layout, 26926, {}, []);
		expect(environment.BLENDER_PORT).toBe("26926");
		expect(environment.BLENDER_HOST).toBe("127.0.0.1");
		expect(environment.BLENDER_PORT).not.toBe("9876");
		// Both interfaces must address the same isolated Blender instance.
		expect(environment.BLENDER_PORT).toBe(environment.BLENDER_AXI_PORT);
	});
});
