import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError, installSessionStartHooks, runAxiCli } from "axi-sdk-js";
import { defaultRenderDirectory, executeSource, readPythonSource, requestAddon, type SessionContext } from "./client.js";
import { flagString, parseArgs, requirePositionals, usage } from "./args.js";
import { ensureBlender, launchBlender, stopBlender } from "./lifecycle.js";
import { resolveSessionName, resolveSessionPort, resolveSessionStateDir } from "./sessions.js";

export const DESCRIPTION = "Drive Blender through its stock BlenderMCP TCP addon with isolated sessions, atomic builds, tracebacks, and camera renders.";

export const TOP_HELP = `usage: blender-axi [command] [args] [flags]
commands[8]:
  (none)=connection status, ping, exec, build, render, scene, start, stop, setup
flags[4]:
  --launch (start Blender only when needed), --json, --help, -v/-V/--version
session env[2]:
  BLENDER_AXI_SESSION, BLENDER_AXI_PORT
examples:
  blender-axi ping
  blender-axi exec script.py
  blender-axi build build.py --save /tmp/model.blend --render front,side --glb /tmp/model.glb
  blender-axi render front,side --out /tmp/renders --res 880x1180
  blender-axi start
  blender-axi setup hooks
`;

export const COMMAND_HELP: Record<string, string> = {
  ping: "usage: blender-axi ping [--launch] [--json]\nConfirm the session's Blender addon is listening.\n",
  exec: "usage: blender-axi exec <file|-> [--launch] [--json]\nExecute Python with guaranteed traceback and pre-failure stdout capture.\n",
  build: "usage: blender-axi build <file> [--save <path>] [--render <front,side,back,tq>] [--glb <path>] [--launch] [--json]\nBuild, save, export, and render atomically in one socket round-trip.\n",
  render: "usage: blender-axi render <front,side,back,tq> [--out <dir>] [--res <WxH>] [--launch] [--json]\nWrite camera renders to PNG files.\n",
  scene: "usage: blender-axi scene [--launch] [--json]\nShow object, collection, and material counts and object summaries.\n",
  start: "usage: blender-axi start [--json]\nLaunch a Blender GUI owned by this session and wait for its addon port.\n",
  stop: "usage: blender-axi stop [--json]\nStop only the Blender process previously launched by this session.\n",
  setup: "usage: blender-axi setup hooks\nInstall or repair SessionStart hooks for Claude Code, Codex, and OpenCode.\n",
};

const ANGLES = new Set(["front", "side", "back", "tq"]);

type AxiRenderable = string | Record<string, unknown>;
type SessionCommand = (args: string[], context: SessionContext) => Promise<AxiRenderable> | AxiRenderable;
type Command = (args: string[]) => Promise<AxiRenderable> | AxiRenderable;

function withContext(command: SessionCommand): Command {
  return (args) => command(args, resolveContext());
}

function jsonOr(value: Record<string, unknown>, json: boolean, text: string): AxiRenderable {
  return json ? JSON.stringify(value) : text;
}

function parseCommon(args: string[], valueFlags: string[] = []) {
  return parseArgs(args, valueFlags, ["--json", "--launch"]);
}

function parseAngles(value: string): string[] {
  const angles = value.split(",").filter(Boolean);
  if (!angles.length || angles.some((angle) => !ANGLES.has(angle))) {
    throw usage(`Invalid render angles "${value}"`, ["Use a comma-separated subset of front,side,back,tq"]);
  }
  return angles;
}

function parseResolution(value?: string): { width: number; height: number } | undefined {
  if (!value) return undefined;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw usage(`Invalid resolution "${value}"`, ["Use WIDTHxHEIGHT, for example 880x1180"]);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1 || width > 16384 || height > 16384) {
    throw usage(`Invalid resolution "${value}"`, ["Width and height must each be 1-16384"]);
  }
  return { width, height };
}

async function connected(context: SessionContext, launch: boolean): Promise<void> {
  await ensureBlender(context, launch);
}

const pingCommand: SessionCommand = async (args, context) => {
  const parsed = parseCommon(args);
  requirePositionals(parsed, 0, "blender-axi ping [--launch] [--json]");
  await connected(context, parsed.flags.has("--launch"));
  const value = { ok: true, session: context.session, port: context.port };
  return jsonOr(value, parsed.flags.has("--json"), `ok: true\nsession: ${context.session}\nport: ${context.port}`);
};

const execCommand: SessionCommand = async (args, context) => {
  const parsed = parseCommon(args);
  const [file] = requirePositionals(parsed, 1, "blender-axi exec <file|->");
  await connected(context, parsed.flags.has("--launch"));
  const { source, filename } = readPythonSource(file);
  return executionOutput(await executeSource(context, source, { filename }), parsed.flags.has("--json"));
};

const buildCommand: SessionCommand = async (args, context) => {
  const parsed = parseCommon(args, ["--save", "--render", "--glb"]);
  const [file] = requirePositionals(parsed, 1, "blender-axi build <file>");
  const save = flagString(parsed, "--save");
  const glb = flagString(parsed, "--glb");
  const renderValue = flagString(parsed, "--render");
  const renderAngles = renderValue ? parseAngles(renderValue) : undefined;
  await connected(context, parsed.flags.has("--launch"));
  const { source, filename } = readPythonSource(file);
  return executionOutput(
    await executeSource(context, source, {
      filename,
      save,
      glb,
      renderAngles,
      renderOutDir: defaultRenderDirectory(save),
    }),
    parsed.flags.has("--json"),
  );
};

const renderCommand: SessionCommand = async (args, context) => {
  const parsed = parseCommon(args, ["--out", "--res"]);
  const [angleValue] = requirePositionals(parsed, 1, "blender-axi render <angles>");
  await connected(context, parsed.flags.has("--launch"));
  return executionOutput(
    await executeSource(context, "", {
      filename: "<blender-axi-render>",
      renderAngles: parseAngles(angleValue),
      renderOutDir: flagString(parsed, "--out") ?? process.cwd(),
      resolution: parseResolution(flagString(parsed, "--res")),
    }),
    parsed.flags.has("--json"),
  );
};

const sceneCommand: SessionCommand = async (args, context) => {
  const parsed = parseCommon(args);
  requirePositionals(parsed, 0, "blender-axi scene");
  await connected(context, parsed.flags.has("--launch"));
  const result = await executeSource(
    context,
    `print(json.dumps({
  "name": C.scene.name,
  "objects": {"count": len(C.scene.objects), "items": [{"name": o.name, "type": o.type} for o in list(C.scene.objects)[:20]]},
  "collections": {"count": len(D.collections), "items": [c.name for c in list(D.collections)[:20]]},
  "materials": {"count": len(D.materials), "items": [m.name for m in list(D.materials)[:20]]}
}))`,
    { filename: "<blender-axi-scene>" },
  );
  if (!result.ok) return executionOutput(result, parsed.flags.has("--json"));
  let summary: Record<string, unknown>;
  try {
    summary = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error("Blender scene summary was invalid JSON");
  }
  return parsed.flags.has("--json") ? JSON.stringify(summary) : summary;
};

const startCommand: SessionCommand = async (args, context) => {
  const parsed = parseCommon(args, []);
  requirePositionals(parsed, 0, "blender-axi start");
  try {
    await requestAddon(context, "get_scene_info");
    return jsonOr({ ok: true, status: "already-running", session: context.session, port: context.port }, parsed.flags.has("--json"), `status: already-running\nsession: ${context.session}\nport: ${context.port}`);
  } catch {
    const pid = await launchBlender(context);
    return jsonOr({ ok: true, status: "started", pid, session: context.session, port: context.port }, parsed.flags.has("--json"), `status: started\npid: ${pid}\nsession: ${context.session}\nport: ${context.port}`);
  }
};

const stopCommand: SessionCommand = (args, context) => {
  const parsed = parseCommon(args, []);
  requirePositionals(parsed, 0, "blender-axi stop");
  const pid = stopBlender(context);
  const status = pid ? "stopped" : "not-owned";
  return jsonOr({ ok: true, status, ...(pid ? { pid } : {}) }, parsed.flags.has("--json"), pid ? `status: stopped\npid: ${pid}` : "status: not-owned\nmessage: no Blender process was launched by this session");
};

const setupCommand: Command = (args) => {
  if (args.length !== 1 || args[0] !== "hooks") {
    throw new AxiError("Unknown setup action", "VALIDATION_ERROR", ["Run `blender-axi setup hooks`"]);
  }
  const failures: string[] = [];
  installSessionStartHooks({ onError: (message) => failures.push(message) });
  return failures.length
    ? { hooks: { status: "partial", integrations: ["Claude Code", "Codex", "OpenCode"], failures } }
    : { hooks: { status: "installed", integrations: ["Claude Code", "Codex", "OpenCode"] } };
};

function executionOutput(result: Awaited<ReturnType<typeof executeSource>>, json: boolean): AxiRenderable {
  if (!result.ok) {
    process.exitCode = 1;
    return json
      ? JSON.stringify(result)
      : `ok: false\nerror: ${result.error}\nstdout_before_failure: |\n${indent(result.stdout_before_failure)}\ntraceback: |\n${indent(result.traceback)}`;
  }
  if (json) return JSON.stringify(result);
  const chunks = [result.stdout.trimEnd()];
  if (result.artifacts.length) chunks.push(`artifacts[${result.artifacts.length}]:\n${result.artifacts.map((path) => `  - ${path}`).join("\n")}`);
  return chunks.filter(Boolean).join("\n");
}

function indent(value: string): string {
  return value.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}

const COMMANDS: Record<string, Command> = {
  ping: withContext(pingCommand),
  exec: withContext(execCommand),
  run: withContext(execCommand),
  build: withContext(buildCommand),
  render: withContext(renderCommand),
  scene: withContext(sceneCommand),
  start: withContext(startCommand),
  stop: withContext(stopCommand),
  setup: setupCommand,
};

export async function main(options: { argv?: string[]; stdout?: { write(chunk: string): unknown } } = {}): Promise<void> {
  await runAxiCli<SessionContext>({
    argv: options.argv,
    description: DESCRIPTION,
    version: readPackageVersion(),
    topLevelHelp: TOP_HELP,
    commands: COMMANDS,
    home: withContext(pingCommand),
    getCommandHelp: (command) => COMMAND_HELP[command === "run" ? "exec" : command],
    ...(options.stdout ? { stdout: options.stdout } : {}),
  });
}

function resolveContext(): SessionContext {
  const session = resolveSessionName();
  return { session, port: resolveSessionPort(session), stateDir: resolveSessionStateDir(session) };
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "blender-axi" && parsed.version) return parsed.version;
    } catch {
    }
  }
  throw new Error("Could not determine blender-axi package version");
}
