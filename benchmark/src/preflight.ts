import { access, constants } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { verifyFixtures } from "./fixtures.js";
import { readJson, sha256File } from "./util.js";

interface FrozenConfig {
  versions: Record<string, string | null>;
  model: Record<string, string | null>;
  prices: Record<string, string | number | null>;
  limits: Record<string, number | null>;
}
interface AgentCommand {
  executable: string | null;
  credential_environment_variables: string[];
  required_fresh_session_args: string[];
  required_disable_ambient_args: string[];
}
export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

async function executableVersion(path: string, args = ["--version"]): Promise<string | null> {
  return await new Promise((resolvePromise) => {
    const child = spawn(path, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.once("error", () => resolvePromise(null));
    child.once("exit", (code) => resolvePromise(code === 0 ? output.trim().split(/\r?\n/u)[0] ?? null : null));
  });
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(200);
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    socket.once("timeout", () => { socket.destroy(); resolvePromise(false); });
    socket.once("error", () => resolvePromise(false));
  });
}

export async function preflightChecks(benchmarkRoot: string, options: { live: boolean; blenderExecutable?: string; addonPath?: string }): Promise<Check[]> {
  const config = await readJson<FrozenConfig>(join(benchmarkRoot, "config", "frozen.json"));
  const agent = await readJson<AgentCommand>(join(benchmarkRoot, "config", "agent-command.json"));
  const fixture = await verifyFixtures(benchmarkRoot).catch((error) => ({ ok: false, errors: [(error as Error).message], index: null }));
  const checks: Check[] = [{ id: "fixtures", ok: fixture.ok, detail: fixture.ok ? "P1-P6 fixture hashes verified" : fixture.errors.join("; ") }];
  const blender = options.blenderExecutable ?? process.env.BLENDER_EXECUTABLE ?? "/Applications/Blender.app/Contents/MacOS/Blender";
  const blenderVersion = await executableVersion(blender);
  checks.push({ id: "blender", ok: blenderVersion?.includes("5.2.0 LTS") ?? false, detail: blenderVersion ?? "Blender executable unavailable" });
  if (fixture.index && blenderVersion) checks.push({ id: "blender-hash", ok: (await sha256File(blender)) === fixture.index.blender_executable_sha256, detail: "Blender executable matches fixture generator pin" });
  const addonPath = options.addonPath ?? process.env.BLENDER_MCP_ADDON_PATH ?? "";
  let addonHash: string | null = null;
  try {
    if (addonPath) {
      await access(addonPath, constants.R_OK);
      addonHash = await sha256File(addonPath);
    }
  } catch {
    addonHash = null;
  }
  checks.push({ id: "addon-pin", ok: addonHash === config.versions.addon_sha256, detail: addonHash ? `addon sha256 ${addonHash}` : "BLENDER_MCP_ADDON_PATH unavailable" });
  checks.push({ id: "unity-contract", ok: config.versions.unity_fixture_contract === "unity-urp-fbx-v1" && config.versions.unity_pipeline === "URP", detail: "Unity URP/FBX-first fixture contract encoded" });
  checks.push({ id: "limits", ok: config.limits.max_invalid_attempts !== null && config.limits.max_critical_failures !== null, detail: "Safety invalid and critical ceilings configured" });
  const oracleFiles = ["inspect_scene.py", "roundtrip_import.py", "standardized_render.py"];
  const oracleChecks = await Promise.all(oracleFiles.map(async (name) => {
    try {
      await access(join(benchmarkRoot, "fixtures", name), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }));
  checks.push({ id: "oracles", ok: oracleChecks.every(Boolean), detail: "Deterministic scene, exchange round-trip, and standardized render harnesses are readable" });
  for (const port of [9876]) checks.push({ id: `owned-port-${port}`, ok: !(await canConnect(port)), detail: (await canConnect(port)) ? `Port ${port} has a listener; preflight refuses to touch it` : `Port ${port} is closed` });

  if (options.live) {
    checks.push({ id: "model-pin", ok: Boolean(config.model.provider && config.model.id && config.model.effort && config.model.agent_cli), detail: "Exact provider/model/effort/agent pin required" });
    checks.push({ id: "price-sheet", ok: Object.entries(config.prices).filter(([key]) => key.endsWith("per_million")).every(([, value]) => typeof value === "number"), detail: "Frozen non-null price sheet required" });
    checks.push({ id: "budget", ok: typeof config.limits.max_dollars === "number" && typeof config.limits.max_wall_seconds === "number", detail: "Captain-approved dollar and wall ceilings required" });
    checks.push({ id: "agent-command", ok: Boolean(agent.executable && agent.required_fresh_session_args.length && agent.required_disable_ambient_args.length), detail: "Fresh isolated provider adapter must be frozen" });
    for (const variable of agent.credential_environment_variables) checks.push({ id: `credential-${variable}`, ok: Boolean(process.env[variable]), detail: `${variable} is required and value is not logged` });
    checks.push({ id: "unity-target", ok: Boolean(config.versions.unity_editor), detail: "Exact Unity editor patch required because preflight plan includes only P1/P5, but campaign readiness freezes all pins" });
  }
  return checks;
}
