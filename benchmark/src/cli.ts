import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtures, loadTasks, verifyFixtures } from "./fixtures.js";
import { generatePlan, generatePreflightPlan, savePlan } from "./plan.js";
import { preflightChecks } from "./preflight.js";
import { CommandAgentAdapter } from "./agent-adapter.js";
import { SyntheticAgentAdapter, runSweep } from "./runner.js";
import { gradeRun } from "./grading.js";
import { createBlindBundles, closeScoring } from "./visual.js";
import { applyVisualScores } from "./report.js";
import { generateReports } from "./report.js";
import { readJson, readJsonl } from "./util.js";
import type { AttemptRecord, SeedPlan } from "./types.js";

const BIN = "blender-axi-bench";
const DEFAULT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

interface Parsed {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parse(args: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) positionals.push(arg);
    else {
      const [name, inline] = arg.split("=", 2);
      if (inline !== undefined) flags.set(name, inline);
      else if (args[index + 1] && !args[index + 1]!.startsWith("--")) flags.set(name, args[++index]!);
      else flags.set(name, true);
    }
  }
  return { positionals, flags };
}

function allowed(parsed: Parsed, names: string[]): void {
  const valid = new Set(["--help", ...names]);
  for (const name of parsed.flags.keys()) if (!valid.has(name)) throw new UsageError(`unknown flag ${name}; valid flags: ${[...valid].join(", ")}`);
}
function stringFlag(parsed: Parsed, name: string, fallback?: string): string {
  const value = parsed.flags.get(name);
  if (value === true) throw new UsageError(`${name} requires a value`);
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new UsageError(`${name} is required`);
}
function numberFlag(parsed: Parsed, name: string, fallback: number): number {
  const value = parsed.flags.get(name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new UsageError(`${name} must be a number`);
  return number;
}
function boolFlag(parsed: Parsed, name: string): boolean {
  const value = parsed.flags.get(name);
  if (value === undefined) return false;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new UsageError(`${name} must be true or false`);
}
function listFlag(parsed: Parsed, name: string): string[] | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UsageError(`${name} requires comma-separated values`);
  return value.split(",").map((item: string) => item.trim()).filter(Boolean);
}
class UsageError extends Error {}

function print(value: Record<string, unknown>): void {
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      console.log(`${key}[${item.length}]:`);
      item.forEach((entry) => console.log(`  ${typeof entry === "string" ? entry : JSON.stringify(entry)}`));
    } else console.log(`${key}: ${typeof item === "object" && item !== null ? JSON.stringify(item) : String(item)}`);
  }
}

const HELP = `bin: ${BIN}
description: Build, isolate, execute, grade, blind-score, and analyze the pinned blender-axi versus BlenderMCP study.
commands[8]:
  fixtures create|verify
  plan preflight|pilot|selected
  preflight check|execute
  run selected
  simulate
  grade
  visual bundle|close
  report
help[2]:
  Run \`${BIN} <command> --help\` for command-specific flags
  Live model execution occurs only with \`${BIN} preflight execute\` or \`${BIN} run selected\``;

function commandHelp(command: string): string {
  const help: Record<string, string> = {
    fixtures: `${BIN} fixtures create --blender <path> [--force]\n${BIN} fixtures verify`,
    plan: `${BIN} plan preflight --output <path> [--seed 4103]\n${BIN} plan pilot --output <path> [--seed 4103] [--replicates 5]\n${BIN} plan selected --tasks P1,P2 --output <path> [--seed 4103] [--replicates 1]`,
    preflight: `${BIN} preflight check [--blender <path>] [--addon <path>]\n${BIN} preflight execute --plan <preflight.json> --runs <dir> --blender <path> --addon <path>\nThe execute form is the explicit four-paid-run command and refuses unless every pin, fixture, oracle, limit, credential, and isolation check passes.`,
    run: `${BIN} run selected --plan <path> --runs <dir> --cells <id,id> --blender <path> --addon <path>`,
    simulate: `${BIN} simulate --plan <path> --runs <dir> [--scenarios <dir>] [--cells <id,id>]`,
    grade: `${BIN} grade --runs <dir> [--run-id <id>] [--blender <path>]`,
    visual: `${BIN} visual bundle --runs <dir> --output <dir> --blender <path> [--seed 9001]\n${BIN} visual close --scoring <dir> --results <results.jsonl>`,
    report: `${BIN} report --results <results.jsonl> --output <dir>`,
  };
  return help[command] ?? HELP;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parse(argv);
  const [command, subcommand] = parsed.positionals;
  if (!command) {
    console.log(HELP);
    return 0;
  }
  if (parsed.flags.has("--help")) {
    console.log(commandHelp(command));
    return 0;
  }
  const benchmarkRoot = resolve(stringFlag(parsed, "--benchmark-root", DEFAULT_ROOT));

  if (command === "fixtures") {
    allowed(parsed, ["--benchmark-root", "--blender", "--force"]);
    if (subcommand === "create") {
      const blender = stringFlag(parsed, "--blender", process.env.BLENDER_EXECUTABLE ?? "/Applications/Blender.app/Contents/MacOS/Blender");
      const index = await createFixtures(benchmarkRoot, blender, { force: boolFlag(parsed, "--force") });
      print({ ok: true, fixtures: index.entries.length, manifest_sha256: index.manifest_sha256 });
      return 0;
    }
    if (subcommand === "verify") {
      const result = await verifyFixtures(benchmarkRoot);
      print({ ok: result.ok, fixtures: result.index.entries.length, errors: result.errors });
      return result.ok ? 0 : 1;
    }
    throw new UsageError("fixtures requires create or verify");
  }

  if (command === "plan") {
    allowed(parsed, ["--benchmark-root", "--output", "--seed", "--replicates", "--tasks"]);
    const output = stringFlag(parsed, "--output");
    const seed = numberFlag(parsed, "--seed", 4103);
    let plan: SeedPlan;
    if (subcommand === "preflight") plan = await generatePreflightPlan(benchmarkRoot, seed);
    else if (subcommand === "pilot") plan = await generatePlan(benchmarkRoot, { kind: "pilot", taskIds: ["P1", "P2", "P3", "P4", "P5", "P6"], replicates: numberFlag(parsed, "--replicates", 5), seed });
    else if (subcommand === "selected") plan = await generatePlan(benchmarkRoot, { kind: "selected", taskIds: listFlag(parsed, "--tasks") ?? ["P1"], replicates: numberFlag(parsed, "--replicates", 1), seed });
    else throw new UsageError("plan requires preflight, pilot, or selected");
    await savePlan(output, plan);
    print({ ok: true, plan: output, cells: plan.cells.length, randomization_seed: seed, sequences: plan.cells.filter((cell) => cell.order_in_pair === 1).map((cell) => `${cell.task_id}:${cell.sequence}`) });
    return 0;
  }

  if (command === "preflight") {
    allowed(parsed, ["--benchmark-root", "--plan", "--runs", "--blender", "--addon"]);
    const live = subcommand === "execute";
    if (!live && subcommand !== "check") throw new UsageError("preflight requires check or execute");
    const checks = await preflightChecks(benchmarkRoot, { live, blenderExecutable: parsed.flags.get("--blender") as string | undefined, addonPath: parsed.flags.get("--addon") as string | undefined });
    const failures = checks.filter((check) => !check.ok);
    print({ ok: failures.length === 0, mode: live ? "live-four-run" : "offline-check", checks, failures: failures.map((check) => check.id) });
    if (failures.length) return 1;
    if (live) {
      const planPath = stringFlag(parsed, "--plan");
      const plan = await readJson<SeedPlan>(planPath);
      if (plan.kind !== "preflight" || plan.cells.length !== 4 || new Set(plan.cells.map((cell) => cell.task_id)).size !== 2 || !plan.cells.some((cell) => cell.task_id === "P1") || !plan.cells.some((cell) => cell.task_id === "P5")) throw new Error("Live preflight plan must contain exactly P1 and P5 once per arm");
      const result = await runSweep({ benchmarkRoot, planPath, runsRoot: stringFlag(parsed, "--runs"), adapter: new CommandAgentAdapter(benchmarkRoot), blenderExecutable: stringFlag(parsed, "--blender"), addonPath: stringFlag(parsed, "--addon"), live: true });
      print({ ok: result.stopped_reason === null, ...result });
    }
    return 0;
  }

  if (command === "run") {
    allowed(parsed, ["--benchmark-root", "--plan", "--runs", "--cells", "--blender", "--addon"]);
    if (subcommand !== "selected") throw new UsageError("run requires selected; full unbounded campaigns are intentionally unavailable");
    const result = await runSweep({ benchmarkRoot, planPath: stringFlag(parsed, "--plan"), runsRoot: stringFlag(parsed, "--runs"), selectedCells: listFlag(parsed, "--cells"), adapter: new CommandAgentAdapter(benchmarkRoot), blenderExecutable: stringFlag(parsed, "--blender"), addonPath: stringFlag(parsed, "--addon"), live: true });
    print({ ok: result.stopped_reason === null, ...result });
    return result.stopped_reason ? 1 : 0;
  }

  if (command === "simulate") {
    allowed(parsed, ["--benchmark-root", "--plan", "--runs", "--scenarios", "--cells", "--blender"]);
    const scenarios = stringFlag(parsed, "--scenarios", join(benchmarkRoot, "fixtures", "calibration", "synthetic"));
    const result = await runSweep({ benchmarkRoot, planPath: stringFlag(parsed, "--plan"), runsRoot: stringFlag(parsed, "--runs"), selectedCells: listFlag(parsed, "--cells"), adapter: new SyntheticAgentAdapter(scenarios), blenderExecutable: parsed.flags.get("--blender") as string | undefined });
    print({ ok: true, ...result });
    return 0;
  }

  if (command === "grade") {
    allowed(parsed, ["--benchmark-root", "--runs", "--run-id", "--blender"]);
    const runs = stringFlag(parsed, "--runs");
    const records = await readJsonl<AttemptRecord>(join(runs, "results.jsonl"));
    const ids = parsed.flags.has("--run-id") ? [stringFlag(parsed, "--run-id")] : records.map((record) => record.run_id);
    const tasks = new Map((await loadTasks(benchmarkRoot)).map((task) => [task.id, task]));
    const grades = [];
    for (const id of ids) {
      const record = records.find((item) => item.run_id === id);
      if (!record) throw new Error(`Unknown run ${id}`);
      const task = tasks.get(record.task_id)!;
      grades.push(await gradeRun({ benchmarkRoot, runRoot: join(runs, id), runId: id, task, arm: record.arm, blenderExecutable: parsed.flags.get("--blender") as string | undefined, fixtureHashBefore: record.inputs.fixture_sha256_before }));
    }
    print({ ok: true, graded: grades.length, outcomes: grades.map((grade) => `${grade.run_id}:${grade.status}`) });
    return 0;
  }

  if (command === "visual") {
    allowed(parsed, ["--benchmark-root", "--runs", "--output", "--scoring", "--seed", "--blender", "--results"]);
    const config = await readJson<{ visual: { duplicate_fraction: number; minimum_raters: number } }>(join(benchmarkRoot, "config", "frozen.json"));
    if (subcommand === "bundle") {
      const result = await createBlindBundles({ runsRoot: stringFlag(parsed, "--runs"), outputRoot: stringFlag(parsed, "--output"), seed: numberFlag(parsed, "--seed", 9001), duplicateFraction: config.visual.duplicate_fraction, minimumRaters: config.visual.minimum_raters, benchmarkRoot, blenderExecutable: stringFlag(parsed, "--blender", process.env.BLENDER_EXECUTABLE ?? "/Applications/Blender.app/Contents/MacOS/Blender") });
      print({ ok: true, blinded_items: result.items.length, forms: result.forms });
      return 0;
    }
    if (subcommand === "close") {
      const result = await closeScoring(stringFlag(parsed, "--scoring"), config.visual.minimum_raters);
      await applyVisualScores(stringFlag(parsed, "--results"), result.run_scores);
      print({ ok: true, scored_items: Object.keys(result.aggregate).length, scored_runs: Object.keys(result.run_scores).length });
      return 0;
    }
    throw new UsageError("visual requires bundle or close");
  }

  if (command === "report") {
    allowed(parsed, ["--benchmark-root", "--results", "--output"]);
    const report = await generateReports(benchmarkRoot, stringFlag(parsed, "--results"), stringFlag(parsed, "--output"));
    print({ ok: true, attempts: report.counts.total_attempts, valid: report.counts.valid_attempts, output: stringFlag(parsed, "--output") });
    return 0;
  }
  throw new UsageError(`unknown command ${command}`);
}

export async function runCli(): Promise<void> {
  try {
    process.exitCode = await main();
  } catch (error) {
    const usage = error instanceof UsageError;
    print({ error: (error as Error).message, help: usage ? `Run ${BIN} --help` : "Inspect benchmark logs and configuration" });
    process.exitCode = usage ? 2 : 1;
  }
}
