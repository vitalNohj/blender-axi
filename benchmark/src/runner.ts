import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import {
	appendJsonl,
	readJson,
	readJsonl,
	redact,
	writeJsonAtomic,
} from "./util.js";
import { loadTasks, verifyFixtures } from "./fixtures.js";
import { assertValidAttempt, assertValidPlan } from "./schema.js";
import {
	assertPortClosed,
	chooseUniquePort,
	cleanupOwnedProcesses,
	cleanupRunRootProcesses,
	createRunLayout,
	sanitizedEnvironment,
	spawnOwned,
	writeBlenderStartup,
} from "./isolation.js";
import { buildAttemptRecord, currentFixtureHash } from "./record.js";
import { detectPolicyViolations } from "./policy.js";
import { gradeRun } from "./grading.js";
import type { GradeResult } from "./grading.js";
import { preflightChecks } from "./preflight.js";
import type {
	AttemptRecord,
	PlanCell,
	SeedPlan,
	TaskManifest,
	ToolEvent,
} from "./types.js";

interface FrozenConfig {
	versions: Record<string, string | null>;
	model: {
		provider: string | null;
		id: string | null;
		effort: string | null;
		agent_cli: string | null;
	};
	limits: {
		max_wall_seconds: number | null;
		max_invalid_attempts: number;
		max_critical_failures: number;
		port_min: number;
		port_max: number;
	};
}
interface ArmsConfig {
	common: { base_instructions: string };
	arms: Record<"axi" | "mcp", { condition_instructions: string }>;
}
interface AgentCommandConfig {
	credential_environment_variables: string[];
}
export interface AgentResult {
	answer: string;
	transcript: string;
	providerRecords: unknown[];
	events: ToolEvent[];
	usage: Partial<AttemptRecord["usage"]>;
	cache: Partial<AttemptRecord["cache"]>;
	agentTurns: number;
	retries: number;
	agentPid: number | null;
	timedOut?: boolean;
}
export interface AgentAdapter {
	run(input: {
		cell: PlanCell;
		task: TaskManifest;
		runRoot: string;
		port: number;
		environment: NodeJS.ProcessEnv;
		baseInstructions: string;
		conditionInstructions: string;
		signal?: AbortSignal;
	}): Promise<AgentResult>;
}

export interface SweepResult {
	attempted: number;
	skipped_completed: number;
	stopped_reason: string | null;
	results_path: string;
}

export function infrastructureFailure(
	task: TaskManifest,
	runId: string,
	error: Error,
): {
	grade: GradeResult;
	validity: { status: "invalid"; invalid_reason: string };
} {
	return {
		grade: {
			schema_version: "1.0.0",
			task_id: task.id,
			run_id: runId,
			status: "infrastructure_invalid",
			functional_success: false,
			critical_failure: false,
			deterministic_structure_0_100: null,
			unity_readiness_0_100: null,
			hard_failure_ids: [],
			oracle_results: [],
		},
		validity: {
			status: "invalid",
			invalid_reason: `infrastructure_error:${error.message}`,
		},
	};
}

// Dollar cost is excluded from this benchmark: the pinned provider does not
// report a usable measured cost. Only a genuine provider-reported figure may
// populate api_cost_usd. A catalog price of 0 means "not reported", not "free",
// and a frozen rate-sheet estimate is a projection rather than a measurement, so
// neither is ever presented as measured cost. Token fields and wall time carry
// the efficiency signal instead.
export function measuredCost(
	usage: Partial<AttemptRecord["usage"]>,
): number | null {
	const reported = usage.api_cost_usd;
	if (typeof reported !== "number" || !Number.isFinite(reported)) return null;
	return reported > 0 ? reported : null;
}

export function stopReason(
	records: AttemptRecord[],
	config: FrozenConfig,
	elapsedSeconds: number,
): string | null {
	// No dollar ceiling: cost is excluded from this benchmark, so the campaign
	// wall-time limit is the binding spend brake alongside the validity ceilings.
	if (
		config.limits.max_wall_seconds !== null &&
		elapsedSeconds >= config.limits.max_wall_seconds
	)
		return "wall_time_ceiling";
	if (
		records.filter((record) => record.validity.status === "invalid").length >=
		config.limits.max_invalid_attempts
	)
		return "invalid_attempt_ceiling";
	if (
		records.filter((record) => record.outcome.critical_failure).length >=
		config.limits.max_critical_failures
	)
		return "critical_failure_ceiling";
	return null;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function waitForListener(
	port: number,
	timeoutMilliseconds: number,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (Date.now() < deadline) {
		signal?.throwIfAborted();
		const connected = await new Promise<boolean>((resolvePromise) => {
			const socket = createConnection({ host: "127.0.0.1", port });
			socket.setTimeout(200);
			socket.once("connect", () => {
				socket.destroy();
				resolvePromise(true);
			});
			socket.once("timeout", () => {
				socket.destroy();
				resolvePromise(false);
			});
			socket.once("error", () => resolvePromise(false));
		});
		if (connected) return;
		await new Promise<void>((resolvePromise, reject) => {
			const onAbort = (): void => {
				clearTimeout(timer);
				reject(signal?.reason);
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolvePromise();
			}, 100);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	throw new Error(
		`Benchmark Blender listener on port ${port} did not become ready`,
	);
}

export class SyntheticAgentAdapter implements AgentAdapter {
	constructor(private readonly fixtureRoot: string) {}

	async run(input: Parameters<AgentAdapter["run"]>[0]): Promise<AgentResult> {
		const scenarioPath = join(
			this.fixtureRoot,
			`${input.task.id}-${input.cell.arm}.json`,
		);
		const scenario = (await exists(scenarioPath))
			? await readJson<{
					answer?: string;
					transcript?: string;
					events?: ToolEvent[];
					usage?: Partial<AttemptRecord["usage"]>;
					files?: Record<string, string>;
				}>(scenarioPath)
			: {
					answer: "Synthetic run complete",
					transcript: "Synthetic offline benchmark transcript",
					events: [] as ToolEvent[],
					files: {},
				};
		for (const [relativePath, content] of Object.entries(
			scenario.files ?? {},
		)) {
			const path = resolve(input.runRoot, relativePath);
			if (!path.startsWith(`${resolve(input.runRoot)}/`))
				throw new Error(`Synthetic artifact path escapes run: ${relativePath}`);
			await mkdir(join(path, ".."), { recursive: true });
			if (content === "$FIXTURE") {
				const artifact = input.task.fixture.source_artifact;
				if (!artifact) throw new Error("Task has no source fixture");
				await import("node:fs/promises").then(({ copyFile }) =>
					copyFile(join(input.runRoot, "fixture", artifact), path),
				);
			} else await writeFile(path, content, { mode: 0o600 });
		}
		return {
			answer: scenario.answer ?? "Synthetic run complete",
			transcript: scenario.transcript ?? "Synthetic transcript",
			providerRecords: [],
			events: scenario.events ?? [],
			usage: scenario.usage ?? {},
			cache: {},
			agentTurns: 1,
			retries: 0,
			agentPid: null,
			timedOut: false,
		};
	}
}

export async function runSweep(options: {
	benchmarkRoot: string;
	planPath: string;
	runsRoot: string;
	adapter: AgentAdapter;
	blenderExecutable?: string;
	addonPath?: string;
	live?: boolean;
	selectedCells?: string[];
}): Promise<SweepResult> {
	const benchmarkRoot = resolve(options.benchmarkRoot);
	const plan = await readJson<SeedPlan>(options.planPath);
	assertValidPlan(plan);
	if (options.selectedCells) {
		if (options.selectedCells.length === 0)
			throw new Error("Selected-cell execution requires at least one cell ID");
		const selected = new Set(options.selectedCells);
		if (selected.size !== options.selectedCells.length)
			throw new Error("Selected-cell execution contains duplicate cell IDs");
		const known = new Set(plan.cells.map((cell) => cell.cell_id));
		const unknown = options.selectedCells.filter((id) => !known.has(id));
		if (unknown.length)
			throw new Error(`Unknown selected cell IDs: ${unknown.join(", ")}`);
	}
	const config = await readJson<FrozenConfig>(
		join(benchmarkRoot, "config", "frozen.json"),
	);
	const arms = await readJson<ArmsConfig>(
		join(benchmarkRoot, "config", "arms.json"),
	);
	const agentCommand = await readJson<AgentCommandConfig>(
		join(benchmarkRoot, "config", "agent-command.json"),
	);
	if (options.live) {
		const checks = await preflightChecks(benchmarkRoot, {
			live: true,
			blenderExecutable: options.blenderExecutable,
			addonPath: options.addonPath,
		});
		const failures = checks.filter((check) => !check.ok);
		if (failures.length)
			throw new Error(
				`Live pin gate failed: ${failures.map((check) => check.id).join(", ")}`,
			);
	}
	const baseInstructions = await readFile(
		join(benchmarkRoot, arms.common.base_instructions),
		"utf8",
	);
	const tasks = new Map(
		(await loadTasks(benchmarkRoot)).map((task) => [task.id, task]),
	);
	const verification = await verifyFixtures(benchmarkRoot);
	if (!verification.ok)
		throw new Error(`Fixtures invalid: ${verification.errors.join("; ")}`);
	if (verification.index.entries.length !== 6)
		throw new Error("Fixture index must contain P1-P6");
	if (
		plan.manifest_sha256 !==
		(await import("./fixtures.js").then(({ fixtureManifestHash }) =>
			fixtureManifestHash(benchmarkRoot),
		))
	)
		throw new Error("Plan manifest hash does not match current task manifests");
	await mkdir(options.runsRoot, { recursive: true });
	const resultsPath = join(options.runsRoot, "results.jsonl");
	const existing = await readJsonl<AttemptRecord>(resultsPath);
	for (const record of existing) assertValidAttempt(record);
	const completed = new Set(existing.map((record) => record.run_id));
	const plannedIds = new Set(plan.cells.map((cell) => cell.cell_id));
	const replacementTargets = new Set(
		plan.cells
			.map((cell) => cell.replacement_for)
			.filter((value): value is string => value !== null),
	);
	for (const target of replacementTargets) {
		const original = existing.find((record) => record.run_id === target);
		if (!original)
			throw new Error(`Replacement references missing attempt ${target}`);
		if (original.validity.status !== "invalid")
			throw new Error(
				`Replacement target ${target} is not infrastructure-invalid`,
			);
	}
	for (const record of existing) {
		if (
			!plannedIds.has(record.run_id) &&
			record.validity.replacement_run_id === null
		)
			continue;
		if (
			record.validity.replacement_run_id &&
			!plannedIds.has(record.validity.replacement_run_id)
		)
			throw new Error(
				`Attempt ${record.run_id} links unknown replacement ${record.validity.replacement_run_id}`,
			);
	}
	const campaignStart = Date.now();
	const campaignDeadline =
		config.limits.max_wall_seconds === null
			? null
			: campaignStart + config.limits.max_wall_seconds * 1000;
	let skipped = 0;
	let attempted = 0;
	let stoppedReason: string | null = null;

	for (const cell of plan.cells) {
		if (options.selectedCells && !options.selectedCells.includes(cell.cell_id))
			continue;
		if (completed.has(cell.cell_id)) {
			skipped += 1;
			continue;
		}
		stoppedReason = stopReason(
			await readJsonl<AttemptRecord>(resultsPath),
			config,
			(Date.now() - campaignStart) / 1000,
		);
		if (stoppedReason) break;
		const task = tasks.get(cell.task_id);
		if (!task) throw new Error(`Unknown task ${cell.task_id}`);
		const entry = verification.index.entries.find(
			(item) => item.task_id === task.id,
		);
		if (!entry) throw new Error(`Missing fixture index for ${task.id}`);
		const layout = await createRunLayout(
			benchmarkRoot,
			options.runsRoot,
			cell.cell_id,
			task.id,
		);
		const controller = new AbortController();
		let hostSignal: NodeJS.Signals | null = null;
		let campaignExpired = false;
		const signalHandlers = new Map<NodeJS.Signals, () => void>();
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			const handler = (): void => {
				hostSignal ??= signal;
				controller.abort(new Error(`Benchmark interrupted by ${signal}`));
			};
			signalHandlers.set(signal, handler);
			process.once(signal, handler);
		}
		const campaignTimer =
			campaignDeadline === null
				? null
				: setTimeout(() => {
					campaignExpired = true;
					controller.abort(new Error("Benchmark campaign wall-time ceiling reached"));
				}, Math.max(0, campaignDeadline - Date.now()));
		const disposeCellLifecycle = (): void => {
			if (campaignTimer) clearTimeout(campaignTimer);
			for (const [signal, handler] of signalHandlers)
				process.removeListener(signal, handler);
		};
		try {
			const port = await chooseUniquePort(
				config.limits.port_min,
				config.limits.port_max,
				cell.seed,
			);
			const environment = sanitizedEnvironment(
				layout,
				port,
				process.env,
				agentCommand.credential_environment_variables,
			);
			const started = new Date();
			let blenderPid: number | null = null;
			let launchSeconds: number | null = null;
			let agentResult: AgentResult;
			let infrastructureError: Error | null = null;
			try {
				await assertPortClosed(port);
				if (options.live) {
					if (!options.addonPath)
						throw new Error(
							"Live execution requires the exact pinned addon path",
						);
					const blenderExecutable =
						options.blenderExecutable ?? process.env.BLENDER_EXECUTABLE;
					if (!blenderExecutable)
						throw new Error(
							"Live execution requires the pinned Blender executable",
						);
					const startup = join(layout.workspace, "benchmark-startup.py");
					await writeBlenderStartup(startup, port, options.addonPath);
					const launchStarted = process.hrtime.bigint();
					const blender = await spawnOwned(
						layout.processRegistry,
						cell.cell_id,
						"blender",
						blenderExecutable,
						[
							"--factory-startup",
							task.fixture.source_artifact
								? join(layout.fixture, task.fixture.source_artifact)
								: "",
							"--python",
							startup,
						],
						{
							cwd: layout.workspace,
							// The pinned addon path is a host path, so it is handed only to
							// Blender. The agent shares the sanitized environment and must
							// not be able to read it from there or from the startup script.
							env: { ...environment, BENCHMARK_ADDON_PATH: options.addonPath },
							port,
							stdoutPath: join(layout.logs, "blender.stdout.log"),
							stderrPath: join(layout.logs, "blender.stderr.log"),
						},
					);
					blenderPid = blender.pid ?? null;
					await waitForListener(port, 45_000, controller.signal);
					launchSeconds = Number(process.hrtime.bigint() - launchStarted) / 1e9;
				}
				agentResult = await options.adapter.run({
					cell,
					task,
					runRoot: layout.root,
					port,
					environment,
					baseInstructions,
					conditionInstructions: arms.arms[cell.arm].condition_instructions,
					signal: controller.signal,
				});
			} catch (error) {
				infrastructureError = error as Error;
				agentResult = {
					answer: `Agent adapter crashed: ${(error as Error).message}`,
					transcript: String((error as Error).stack ?? error),
					providerRecords: [],
					events: [],
					usage: {},
					cache: {},
					agentTurns: 0,
					retries: 0,
					agentPid: null,
					timedOut: false,
				};
			}
			let cleanupError: unknown;
			try {
				await cleanupOwnedProcesses(layout.processRegistry);
				// The registry only knows about processes the harness spawned. Sweep
				// the run root as well so anything the agent started itself cannot
				// outlive the cell on any exit path.
				await cleanupRunRootProcesses(layout.root);
			} catch (error) {
				cleanupError = error;
			}
			if (hostSignal) {
				disposeCellLifecycle();
				process.kill(process.pid, hostSignal);
				throw new Error(`Benchmark interrupted by ${hostSignal}`);
			}
			if (campaignExpired) {
				stoppedReason = "wall_time_ceiling";
				break;
			}
			if (cleanupError) {
				throw cleanupError;
			}
			const ended = new Date();
			const secrets = Object.entries(process.env)
				.filter(([key]) => /key|token|secret|password/iu.test(key))
				.map(([, value]) => value ?? "");
			const safeAnswer = String(redact(agentResult.answer, secrets));
			const safeTranscript = String(redact(agentResult.transcript, secrets));
			const safeEvents = redact(agentResult.events, secrets) as ToolEvent[];
			await writeFile(join(layout.transcript, "answer.txt"), `${safeAnswer}\n`, {
				mode: 0o600,
			});
			await writeFile(
				join(layout.transcript, "full.txt"),
				`${safeTranscript}\n`,
				{ mode: 0o600 },
			);
			await writeFile(
				join(layout.transcript, "provider.jsonl"),
				agentResult.providerRecords
					.map((record) => JSON.stringify(redact(record, secrets)))
					.join("\n") + (agentResult.providerRecords.length ? "\n" : ""),
				{ mode: 0o600 },
			);
			await writeFile(
				join(layout.transcript, "interface.jsonl"),
				safeEvents.map((event) => JSON.stringify(event)).join("\n") +
					(safeEvents.length ? "\n" : ""),
				{ mode: 0o600 },
			);
			const infrastructure = infrastructureError
				? infrastructureFailure(task, cell.cell_id, infrastructureError)
				: null;
			let grade: GradeResult;
			try {
				grade = infrastructure
					? infrastructure.grade
					: await gradeRun({
							benchmarkRoot,
							runRoot: layout.root,
							runId: cell.cell_id,
							task,
							arm: cell.arm,
							blenderExecutable: options.blenderExecutable,
							fixtureHashBefore: entry.artifact_sha256,
							signal: controller.signal,
						});
			} catch (error) {
				if (hostSignal) {
					disposeCellLifecycle();
					process.kill(process.pid, hostSignal);
					throw new Error(`Benchmark interrupted by ${hostSignal}`);
				}
				if (campaignExpired) {
					stoppedReason = "wall_time_ceiling";
					break;
				}
				throw error;
			}
			if (hostSignal) {
				disposeCellLifecycle();
				process.kill(process.pid, hostSignal);
				throw new Error(`Benchmark interrupted by ${hostSignal}`);
			}
			if (campaignExpired) {
				stoppedReason = "wall_time_ceiling";
				break;
			}
			if (
				detectPolicyViolations(cell.arm, safeEvents).length &&
				grade.status !== "policy_violation"
			)
				throw new Error("Policy grading inconsistency");
			const fixtureAfter = await currentFixtureHash(layout.root, task);
			const cost = measuredCost(agentResult.usage);
			const record = await buildAttemptRecord({
				cell,
				task,
				runId: cell.cell_id,
				runRoot: layout.root,
				fixtureHashBefore: entry.artifact_sha256,
				fixtureHashAfter: fixtureAfter,
				baseInstructions,
				conditionInstructions: arms.arms[cell.arm].condition_instructions,
				interfaceSurface: arms.arms[cell.arm].condition_instructions,
				fullTranscript: safeTranscript,
				events: safeEvents,
				answer: safeAnswer,
				grade,
				validity: infrastructure?.validity,
				startedAt: started.toISOString(),
				endedAt: ended.toISOString(),
				wallSeconds: (ended.getTime() - started.getTime()) / 1000,
				port,
				versions: {
					...config.versions,
					model_provider: config.model.provider,
					model_id: config.model.id,
					effort: config.model.effort,
					agent_cli: config.model.agent_cli,
				},
				usage: {
					...agentResult.usage,
					api_cost_usd: cost,
					pricing_source: cost === null ? null : "provider-reported",
				},
				cache: agentResult.cache,
				timing: {
					blender_launch_seconds: launchSeconds,
					timed_out: agentResult.timedOut ?? false,
				},
				blenderPid,
				agentPid: agentResult.agentPid,
				processLogPaths: [
					"logs/agent.stdout.log",
					"logs/agent.stderr.log",
					"logs/blender.stdout.log",
					"logs/blender.stderr.log",
				],
				offlineTokenCount: (text) => encode(text).length,
			});
			record.trajectory.agent_turns = agentResult.agentTurns;
			record.trajectory.retries = agentResult.retries;
			assertValidAttempt(record);
			await appendJsonl(resultsPath, record);
			await writeJsonAtomic(join(layout.root, "attempt.json"), record);
			attempted += 1;
			if (hostSignal) {
				disposeCellLifecycle();
				process.kill(process.pid, hostSignal);
				throw new Error(`Benchmark interrupted by ${hostSignal}`);
			}
			if (campaignExpired) {
				stoppedReason = "wall_time_ceiling";
				break;
			}
		} finally {
			disposeCellLifecycle();
		}
	}
	return {
		attempted,
		skipped_completed: skipped,
		stopped_reason: stoppedReason,
		results_path: resultsPath,
	};
}
