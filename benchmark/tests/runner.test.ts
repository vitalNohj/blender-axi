import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatePlan, savePlan } from "../src/plan.js";
import { runSweep, SyntheticAgentAdapter, stopReason } from "../src/runner.js";
import type { AttemptRecord } from "../src/types.js";

const benchmarkRoot = resolve("benchmark");

describe("resume-safe sweep", () => {
  it("appends once and avoids duplicate cells after resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "blend-bench-runner-"));
    const planPath = join(root, "plan.json");
    const runs = join(root, "runs");
    const scenarios = join(root, "scenarios");
    await mkdir(scenarios);
    const plan = await generatePlan(benchmarkRoot, { kind: "selected", taskIds: ["P1"], replicates: 1, seed: 42 });
    await savePlan(planPath, plan);
    const adapter = new SyntheticAgentAdapter(scenarios);
    const first = await runSweep({ benchmarkRoot, planPath, runsRoot: runs, adapter });
    expect(first.attempted).toBe(2);
    const second = await runSweep({ benchmarkRoot, planPath, runsRoot: runs, adapter });
    expect(second).toMatchObject({ attempted: 0, skipped_completed: 2 });
    const lines = (await readFile(join(runs, "results.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => JSON.parse(line).run_id)).size).toBe(2);
  }, 30_000);
});

describe("ceiling stops", () => {
  const config = { prices: {} as never, versions: {}, model: { provider: null, id: null, effort: null, agent_cli: null }, limits: { max_dollars: 1, max_wall_seconds: 100, max_invalid_attempts: 2, max_critical_failures: 1, port_min: 1, port_max: 2 } };
  it("stops on cost, time, invalid attempts, and critical failures", () => {
    const base = { usage: { api_cost_usd: 1 }, validity: { status: "valid" }, outcome: { critical_failure: false } } as unknown as AttemptRecord;
    expect(stopReason([base], config, 0)).toBe("dollar_ceiling");
    expect(stopReason([], config, 100)).toBe("wall_time_ceiling");
    const invalid = { ...base, usage: { api_cost_usd: 0 }, validity: { status: "invalid" } } as AttemptRecord;
    expect(stopReason([invalid, invalid], config, 0)).toBe("invalid_attempt_ceiling");
    const critical = { ...base, usage: { api_cost_usd: 0 }, outcome: { critical_failure: true } } as AttemptRecord;
    expect(stopReason([critical], config, 0)).toBe("critical_failure_ceiling");
  });
});
