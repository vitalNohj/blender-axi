import { describe, expect, it } from "vitest";
import { clusteredPairedBootstrap, passAtK, summarize, wilson } from "../src/analysis.js";
import type { AttemptRecord } from "../src/types.js";

function record(task: string, pair: string, arm: "axi" | "mcp", success: boolean, score: number, cost: number): AttemptRecord {
  return {
    schema_version: "1.0.0", study_id: "blender-axi-vs-blendermcp-1", run_id: `${pair}-${arm}`, pair_id: pair, task_id: task, task_category: "test", capability_scope: "shared", replicate: 1, arm,
    randomization: { seed: 1, order_in_pair: arm === "axi" ? 1 : 2, sequence: "AXI_MCP" }, validity: { status: "valid", invalid_reason: null, replacement_for: null, replacement_run_id: null, policy_violation: false }, versions: {},
    inputs: { base_system_sha256: "a", condition_instructions_sha256: "b", task_prompt_sha256: "c", fixture_sha256_before: "d", fixture_sha256_after: "d", oracle_manifest_sha256: "e", total_first_turn_context_bytes: 1, total_first_turn_context_offline_tokens: 1, marginal_interface_surface_bytes: arm === "axi" ? 10 : 20, marginal_interface_surface_offline_tokens: 1 },
    cache: { regime: "cold", provider_cache_key_or_observation: null, creation_tokens: null, read_tokens: null }, usage: { provider_input_tokens_total: cost * 100, provider_input_tokens_uncached: null, provider_output_tokens: null, provider_reasoning_tokens: null, offline_tokens_total: null, tool_argument_bytes: 0, tool_argument_offline_tokens: null, tool_response_bytes: 0, tool_response_offline_tokens: null, api_cost_usd: cost, pricing_source: "test" },
    trajectory: { agent_turns: 1, tool_calls: 0, failed_tool_calls: 0, help_calls: 0, retries: 0, blender_launches: 1, human_interventions: 0, answer_path: "", transcript_path: "", provider_stream_path: "", interface_stream_path: "" }, timing: { started_at: "", ended_at: "", wall_seconds: cost, blender_launch_seconds: null, interface_ready_seconds: null, blender_request_seconds: null, unity_import_seconds: null, timeout_seconds: 1, timed_out: false },
    outcome: { status: success ? "solved" : "wrong_artifact", functional_success: success, critical_failure: false, failure_type: null, failure_stage: null, data_loss: false, agent_claimed_success: null, oracle_pass: success }, scores: { deterministic_structure_0_100: score, visual_blinded_0_100: null, unity_readiness_0_100: null, visual_rater_count: 0, scorer_agreement: null }, artifacts: [], oracles: { results: [], visual_scores_path: null, unity_import_path: null }, environment: { machine_id: "x", os: "x", cpu: "x", gpu: null, render_device: "CPU", network_policy: "provider-only", port: 1, run_directory: "", blender_pid: null, agent_pid: null, process_log_paths: [] }, notes: [],
  };
}

describe("statistics", () => {
  it("matches pass@k and summary golden values", () => {
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4);
    expect(passAtK(5, 2, 2)).toBeCloseTo(0.7);
    expect(passAtK(5, 2, 5)).toBe(1);
    expect(summarize([1, 2, 3, null])).toMatchObject({ n: 3, mean: 2, median: 2, minimum: 1, maximum: 3 });
    expect(wilson(0, 0).estimate).toBeNull();
  });

  it("task-clustered paired bootstrap preserves a constant delta", () => {
    const rows = [record("P1", "a", "axi", true, 90, 1), record("P1", "a", "mcp", true, 80, 2), record("P2", "b", "axi", true, 70, 2), record("P2", "b", "mcp", false, 60, 4)];
    const delta = clusteredPairedBootstrap(rows, (row) => row.scores.deterministic_structure_0_100, { samples: 1000, seed: 1 });
    expect(delta).toEqual({ estimate: 10, lower: 10, upper: 10 });
    const ratio = clusteredPairedBootstrap(rows, (row) => row.usage.api_cost_usd, { samples: 1000, seed: 1, ratio: true });
    expect(ratio).toEqual({ estimate: 0.5, lower: 0.5, upper: 0.5 });
  });
});
