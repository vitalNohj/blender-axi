export type Arm = "axi" | "mcp";
export type CacheRegime = "cold" | "warm";
export type ValidityStatus = "valid" | "invalid";
export type OutcomeStatus =
	| "solved"
	| "wrong_artifact"
	| "damaging_failure"
	| "deferred"
	| "budget_exhausted"
	| "crashed"
	| "policy_violation"
	| "infrastructure_invalid";

export interface CheckDefinition {
	id: string;
	kind:
		| "artifact"
		| "scene"
		| "preservation"
		| "reopen"
		| "gltf"
		| "fbx_roundtrip"
		| "unity"
		| "first_failure";
	required: boolean;
	points: number;
	params?: Record<string, unknown>;
}

export interface TaskManifest {
	schema_version: "1.0.0";
	id: string;
	version: string;
	category: string;
	capability_scope: "shared" | "exclusive";
	timeout_class: "micro" | "standard" | "extended";
	timeout_seconds: number;
	prompt: string;
	fixture: {
		contract: string;
		source_artifact: string | null;
		immutable_sha256: string;
		read_only: true;
	};
	required_artifacts: Array<{ kind: string; path: string }>;
	deterministic_oracles: CheckDefinition[];
	unity?: {
		fixture_contract_version: string;
		editor_version: string | null;
		pipeline: "URP";
		primary_format: "FBX";
		secondary_format: "GLB";
		requires_environment_preflight: true;
		required_checks: string[];
	};
}

export interface PlanCell {
	cell_id: string;
	pair_id: string;
	task_id: string;
	replicate: number;
	arm: Arm;
	order_in_pair: 1 | 2;
	sequence: "AXI_MCP" | "MCP_AXI";
	seed: number;
	cache_regime: CacheRegime;
	replacement_for: string | null;
}

export interface SeedPlan {
	schema_version: "1.0.0";
	study_id: string;
	kind: "preflight" | "pilot" | "selected";
	created_at: string;
	randomization_seed: number;
	manifest_sha256: string;
	cells: PlanCell[];
}

export interface ToolEvent {
	timestamp: string | null;
	tool: string;
	interface: "shell" | "mcp" | "unknown";
	arguments: unknown;
	response: unknown;
	success: boolean | null;
	duration_seconds: number | null;
}

export interface OracleResult {
	id: string;
	kind: CheckDefinition["kind"];
	required: boolean;
	passed: boolean | null;
	points_awarded: number;
	points_possible: number;
	reason: string;
	evidence_path: string | null;
}

export interface AttemptRecord {
	schema_version: "1.0.0";
	study_id: string;
	run_id: string;
	pair_id: string;
	task_id: string;
	task_category: string;
	capability_scope: "shared" | "exclusive";
	replicate: number;
	arm: Arm;
	randomization: {
		seed: number;
		order_in_pair: 1 | 2;
		sequence: "AXI_MCP" | "MCP_AXI";
	};
	validity: {
		status: ValidityStatus;
		invalid_reason: string | null;
		replacement_for: string | null;
		replacement_run_id: string | null;
		policy_violation: boolean;
	};
	versions: Record<string, string | null>;
	inputs: {
		base_system_sha256: string;
		condition_instructions_sha256: string;
		task_prompt_sha256: string;
		fixture_sha256_before: string;
		fixture_sha256_after: string | null;
		oracle_manifest_sha256: string;
		total_first_turn_context_bytes: number;
		total_first_turn_context_offline_tokens: number | null;
		marginal_interface_surface_bytes: number;
		marginal_interface_surface_offline_tokens: number | null;
	};
	cache: {
		regime: CacheRegime;
		provider_cache_key_or_observation: string | null;
		creation_tokens: number | null;
		read_tokens: number | null;
	};
	usage: {
		provider_input_tokens_total: number | null;
		provider_input_tokens_uncached: number | null;
		provider_output_tokens: number | null;
		provider_reasoning_tokens: number | null;
		offline_tokens_total: number | null;
		tool_argument_bytes: number;
		tool_argument_offline_tokens: number | null;
		tool_response_bytes: number;
		tool_response_offline_tokens: number | null;
		api_cost_usd: number | null;
		pricing_source: string | null;
	};
	trajectory: {
		agent_turns: number;
		tool_calls: number;
		failed_tool_calls: number;
		help_calls: number;
		retries: number;
		blender_launches: number;
		human_interventions: number;
		answer_path: string;
		transcript_path: string;
		provider_stream_path: string;
		interface_stream_path: string;
	};
	timing: {
		started_at: string;
		ended_at: string;
		wall_seconds: number;
		blender_launch_seconds: number | null;
		interface_ready_seconds: number | null;
		blender_request_seconds: number | null;
		unity_import_seconds: number | null;
		timeout_seconds: number;
		timed_out: boolean;
	};
	outcome: {
		status: OutcomeStatus;
		functional_success: boolean;
		critical_failure: boolean;
		failure_type: string | null;
		failure_stage: string | null;
		data_loss: boolean;
		agent_claimed_success: boolean | null;
		oracle_pass: boolean | null;
	};
	scores: {
		deterministic_structure_0_100: number | null;
		visual_blinded_0_100: number | null;
		unity_readiness_0_100: number | null;
		visual_rater_count: number;
		scorer_agreement: number | null;
	};
	artifacts: Array<{
		kind: string;
		path: string;
		sha256: string;
		bytes: number;
		valid: boolean | null;
	}>;
	oracles: {
		results: OracleResult[];
		visual_scores_path: string | null;
		unity_import_path: string | null;
	};
	environment: {
		machine_id: string;
		os: string;
		cpu: string;
		gpu: string | null;
		render_device: string;
		network_policy: "provider-only";
		port: number;
		run_directory: string;
		blender_pid: number | null;
		agent_pid: number | null;
		process_log_paths: string[];
	};
	notes: string[];
}
