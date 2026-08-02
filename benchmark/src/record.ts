import { platform, release, arch, cpus, hostname } from "node:os";
import { join } from "node:path";
import type {
	AttemptRecord,
	PlanCell,
	TaskManifest,
	ToolEvent,
} from "./types.js";
import type { GradeResult } from "./grading.js";
import { artifactInventory } from "./grading.js";
import { sha256, sha256File, stableJson } from "./util.js";
import { summarizeEvents } from "./transcript.js";

export interface RecordInput {
	cell: PlanCell;
	task: TaskManifest;
	runId: string;
	runRoot: string;
	fixtureHashBefore: string;
	fixtureHashAfter: string | null;
	baseInstructions: string;
	conditionInstructions: string;
	interfaceSurface: string;
	fullTranscript: string;
	events: ToolEvent[];
	answer: string;
	grade: GradeResult;
	startedAt: string;
	endedAt: string;
	wallSeconds: number;
	port: number;
	versions: Record<string, string | null>;
	usage?: Partial<AttemptRecord["usage"]>;
	cache?: Partial<AttemptRecord["cache"]>;
	timing?: Partial<AttemptRecord["timing"]>;
	validity?: Partial<AttemptRecord["validity"]>;
	blenderPid?: number | null;
	agentPid?: number | null;
	processLogPaths?: string[];
	offlineTokenCount?: (text: string) => number;
}

export async function buildAttemptRecord(
	input: RecordInput,
): Promise<AttemptRecord> {
	const eventSummary = summarizeEvents(input.events);
	const firstTurn = `${input.baseInstructions}\n${input.conditionInstructions}\n${input.task.prompt}\n${input.interfaceSurface}`;
	const tokenCount = input.offlineTokenCount;
	const artifacts = await artifactInventory(input.runRoot, input.task);
	const machine = sha256(`${hostname()}|${platform()}|${arch()}`).slice(0, 16);
	const policyViolation = input.grade.status === "policy_violation";
	const fixtureAfter = input.fixtureHashAfter ?? input.fixtureHashBefore;
	const validityStatus =
		input.validity?.status ?? (policyViolation ? "invalid" : "valid");
	const invalidReason =
		input.validity?.invalid_reason ??
		(policyViolation ? "wrong_interface_or_policy_violation" : null);
	return {
		schema_version: "1.0.0",
		study_id: "blender-axi-vs-blendermcp-1",
		run_id: input.runId,
		pair_id: input.cell.pair_id,
		task_id: input.task.id,
		task_category: input.task.category,
		capability_scope: input.task.capability_scope,
		replicate: input.cell.replicate,
		arm: input.cell.arm,
		randomization: {
			seed: input.cell.seed,
			order_in_pair: input.cell.order_in_pair,
			sequence: input.cell.sequence,
		},
		validity: {
			status: validityStatus,
			invalid_reason: invalidReason,
			replacement_for:
				input.validity?.replacement_for ?? input.cell.replacement_for,
			replacement_run_id: input.validity?.replacement_run_id ?? null,
			policy_violation: policyViolation,
		},
		versions: input.versions,
		inputs: {
			base_system_sha256: sha256(input.baseInstructions),
			condition_instructions_sha256: sha256(input.conditionInstructions),
			task_prompt_sha256: sha256(input.task.prompt),
			fixture_sha256_before: input.fixtureHashBefore,
			fixture_sha256_after: input.fixtureHashAfter,
			oracle_manifest_sha256: sha256(
				stableJson(input.task.deterministic_oracles),
			),
			total_first_turn_context_bytes: Buffer.byteLength(firstTurn),
			total_first_turn_context_offline_tokens: tokenCount
				? tokenCount(firstTurn)
				: null,
			marginal_interface_surface_bytes: Buffer.byteLength(
				input.interfaceSurface,
			),
			marginal_interface_surface_offline_tokens: tokenCount
				? tokenCount(input.interfaceSurface)
				: null,
		},
		cache: {
			regime: input.cell.cache_regime,
			provider_cache_key_or_observation:
				input.cache?.provider_cache_key_or_observation ?? null,
			creation_tokens: input.cache?.creation_tokens ?? null,
			read_tokens: input.cache?.read_tokens ?? null,
		},
		usage: {
			provider_input_tokens_total:
				input.usage?.provider_input_tokens_total ?? null,
			provider_input_tokens_uncached:
				input.usage?.provider_input_tokens_uncached ?? null,
			provider_output_tokens: input.usage?.provider_output_tokens ?? null,
			provider_reasoning_tokens: input.usage?.provider_reasoning_tokens ?? null,
			offline_tokens_total: tokenCount
				? tokenCount(input.fullTranscript)
				: null,
			tool_argument_bytes: eventSummary.argument_bytes,
			tool_argument_offline_tokens: tokenCount
				? tokenCount(
						input.events
							.map((event) => JSON.stringify(event.arguments))
							.join("\n"),
					)
				: null,
			tool_response_bytes: eventSummary.response_bytes,
			tool_response_offline_tokens: tokenCount
				? tokenCount(
						input.events
							.map((event) => JSON.stringify(event.response))
							.join("\n"),
					)
				: null,
			api_cost_usd: input.usage?.api_cost_usd ?? null,
			pricing_source: input.usage?.pricing_source ?? null,
		},
		trajectory: {
			agent_turns:
				input.usage && "agent_turns" in input.usage
					? Number(input.usage.agent_turns)
					: 0,
			tool_calls: eventSummary.tool_calls,
			failed_tool_calls: eventSummary.failed_tool_calls,
			help_calls: eventSummary.help_calls,
			retries: 0,
			blender_launches: input.blenderPid ? 1 : 0,
			human_interventions: 0,
			answer_path: "transcript/answer.txt",
			transcript_path: "transcript/full.txt",
			provider_stream_path: "transcript/provider.jsonl",
			interface_stream_path: "transcript/interface.jsonl",
		},
		timing: {
			started_at: input.startedAt,
			ended_at: input.endedAt,
			wall_seconds: input.wallSeconds,
			blender_launch_seconds: input.timing?.blender_launch_seconds ?? null,
			interface_ready_seconds: input.timing?.interface_ready_seconds ?? null,
			blender_request_seconds: input.timing?.blender_request_seconds ?? null,
			unity_import_seconds: input.timing?.unity_import_seconds ?? null,
			timeout_seconds: input.task.timeout_seconds,
			timed_out: input.timing?.timed_out ?? false,
		},
		outcome: {
			status: input.grade.status,
			functional_success: input.grade.functional_success,
			critical_failure: input.grade.critical_failure,
			failure_type: input.grade.functional_success ? null : input.grade.status,
			failure_stage: input.grade.functional_success
				? null
				: input.grade.status === "infrastructure_invalid"
					? "infrastructure"
					: "deterministic_grading",
			data_loss: input.grade.status === "damaging_failure",
			agent_claimed_success: /(?:done|complete|success)/iu.test(input.answer),
			oracle_pass: input.grade.functional_success,
		},
		scores: {
			deterministic_structure_0_100: input.grade.deterministic_structure_0_100,
			visual_blinded_0_100: null,
			unity_readiness_0_100: input.grade.unity_readiness_0_100,
			visual_rater_count: 0,
			scorer_agreement: null,
		},
		artifacts,
		oracles: {
			results: input.grade.oracle_results,
			visual_scores_path: null,
			unity_import_path: null,
		},
		environment: {
			machine_id: machine,
			os: `${platform()} ${release()} ${arch()}`,
			cpu: cpus()[0]?.model ?? "unknown",
			gpu: null,
			render_device: "CPU",
			network_policy: "provider-only",
			port: input.port,
			run_directory: input.runRoot,
			blender_pid: input.blenderPid ?? null,
			agent_pid: input.agentPid ?? null,
			process_log_paths: input.processLogPaths ?? [],
		},
		notes: [],
	};
}

export async function currentFixtureHash(
	runRoot: string,
	task: TaskManifest,
): Promise<string | null> {
	if (!task.fixture.source_artifact) return null;
	try {
		return await sha256File(
			join(runRoot, "fixture", task.fixture.source_artifact),
		);
	} catch {
		return null;
	}
}
