import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError, installSessionStartHooks, runAxiCli } from "axi-sdk-js";
import {
	defaultRenderDirectory,
	executeSource,
	readPythonSource,
	requestAddon,
	type SessionContext,
} from "./client.js";
import { flagString, parseArgs, requirePositionals, usage } from "./args.js";
import { ensureBlender, launchBlender, stopBlender } from "./lifecycle.js";
import {
	resolveSessionName,
	resolveSessionPort,
	resolveSessionStateDir,
} from "./sessions.js";

export const DESCRIPTION =
	"Drive Blender through its stock BlenderMCP TCP addon with isolated sessions, one-request builds, tracebacks, and camera renders.";

export const TOP_HELP = `usage: blender-axi [command] [args] [flags]
commands[8]:
  (none)=connection status, ping, exec, build, render, scene, start, stop, setup
flags[5]:
  --launch (start Blender only when needed), --json, --full, --help, -v/-V/--version
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
	ping: `usage: blender-axi ping [--launch] [--json]
Confirm the session's Blender addon is listening.
flags[2]: --launch (default false), --json (default false)
examples[2]: blender-axi ping, blender-axi ping --launch
`,
	exec: `usage: blender-axi exec <file|-> [--launch] [--json] [--full]
Execute Python with guaranteed traceback and pre-failure stdout capture.
flags[3]: --launch (default false), --json (default false), --full (do not truncate output)
examples[2]: blender-axi exec script.py, cat script.py | blender-axi exec -
`,
	build: `usage: blender-axi build <file> [--save <path>] [--render <front,side,back,tq>] [--glb <path>] [--launch] [--json] [--full]
Build, save, export, and render in one socket round-trip.
flags[6]: --save <path>, --render <angles>, --glb <path>, --launch, --json, --full
examples[2]: blender-axi build build.py --save /tmp/model.blend, blender-axi build build.py --render front,side --glb /tmp/model.glb
`,
	render: `usage: blender-axi render <front,side,back,tq> [--out <dir>] [--res <WxH>] [--launch] [--json] [--full]
Write camera renders to PNG files.
flags[5]: --out <dir> (default cwd), --res <WxH> (keep scene resolution), --launch, --json, --full
examples[2]: blender-axi render front,side, blender-axi render tq --out /tmp/renders --res 880x1180
`,
	scene: `usage: blender-axi scene [--fields <name,type,visible,selected,vertices>] [--full] [--launch] [--json]
Show aggregate object, mesh, triangle, material, and collection counts.
flags[4]: --fields <fields> (include object detail with selected columns), --full (include all objects with name,type), --launch, --json
examples[2]: blender-axi scene, blender-axi scene --fields name,type,vertices
`,
	start: `usage: blender-axi start [--json]
Launch a Blender GUI owned by this session and wait for its addon port.
flags[1]: --json (default false)
examples[2]: blender-axi start, BLENDER_AXI_SESSION=worker-1 blender-axi start
`,
	stop: `usage: blender-axi stop [--json]
Stop only the Blender process previously launched by this session.
flags[1]: --json (default false)
examples[2]: blender-axi stop, BLENDER_AXI_SESSION=worker-1 blender-axi stop
`,
	setup: `usage: blender-axi setup hooks
Install or repair SessionStart hooks for Claude Code, Codex, and OpenCode.
flags[0]:
examples[2]: blender-axi setup hooks, npx -y blender-axi setup hooks
`,
};

const ANGLES = new Set(["front", "side", "back", "tq"]);
const SCENE_FIELDS: Record<string, string> = {
	name: "o.name",
	type: "o.type",
	visible: "o.visible_get()",
	selected: "o.select_get()",
	vertices: "len(o.data.vertices) if o.type == 'MESH' else None",
};
const CONTENT_PREVIEW_LIMIT = 1500;

type AxiRenderable = string | Record<string, unknown>;
type SessionCommand = (
	args: string[],
	context: SessionContext,
) => Promise<AxiRenderable> | AxiRenderable;
type Command = (args: string[]) => Promise<AxiRenderable> | AxiRenderable;

function withContext(command: SessionCommand): Command {
	return (args) => command(args, resolveContext());
}

function jsonOr(value: Record<string, unknown>, json: boolean): AxiRenderable {
	return json ? JSON.stringify(value) : value;
}

const parseCommon = parseArgs;

function parseAngles(value: string): string[] {
	const angles = value.split(",").filter(Boolean);
	if (!angles.length || angles.some((angle) => !ANGLES.has(angle))) {
		throw usage(`Invalid render angles "${value}"`, [
			"Use a comma-separated subset of front,side,back,tq",
		]);
	}
	return angles;
}

function parseResolution(
	value?: string,
): { width: number; height: number } | undefined {
	if (!value) return undefined;
	const match = /^(\d+)x(\d+)$/.exec(value);
	if (!match)
		throw usage(`Invalid resolution "${value}"`, [
			"Use WIDTHxHEIGHT, for example 880x1180",
		]);
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (width < 1 || height < 1 || width > 16384 || height > 16384) {
		throw usage(`Invalid resolution "${value}"`, [
			"Width and height must each be 1-16384",
		]);
	}
	return { width, height };
}

async function connected(
	context: SessionContext,
	launch: boolean,
): Promise<void> {
	await ensureBlender(context, launch);
}

const pingCommand: SessionCommand = async (args, context) => {
	const parsed = parseCommon(args, [], ["--json", "--launch"]);
	requirePositionals(parsed, 0, "blender-axi ping [--launch] [--json]");
	await connected(context, parsed.flags.has("--launch"));
	const value = { ok: true, session: context.session, port: context.port };
	return jsonOr(value, parsed.flags.has("--json"));
};

const execCommand: SessionCommand = async (args, context) => {
	const parsed = parseCommon(args, [], ["--json", "--launch", "--full"]);
	const [file] = requirePositionals(parsed, 1, "blender-axi exec <file|->");
	await connected(context, parsed.flags.has("--launch"));
	const { source, filename } = readPythonSource(file);
	return executionOutput(
		await executeSource(context, source, { filename }),
		parsed.flags.has("--json"),
		parsed.flags.has("--full"),
	);
};

const buildCommand: SessionCommand = async (args, context) => {
	const parsed = parseCommon(
		args,
		["--save", "--render", "--glb"],
		["--json", "--launch", "--full"],
	);
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
			summarize: true,
		}),
		parsed.flags.has("--json"),
		parsed.flags.has("--full"),
	);
};

const renderCommand: SessionCommand = async (args, context) => {
	const parsed = parseCommon(
		args,
		["--out", "--res"],
		["--json", "--launch", "--full"],
	);
	const [angleValue] = requirePositionals(
		parsed,
		1,
		"blender-axi render <angles>",
	);
	await connected(context, parsed.flags.has("--launch"));
	return executionOutput(
		await executeSource(context, "", {
			filename: "<blender-axi-render>",
			renderAngles: parseAngles(angleValue),
			renderOutDir: flagString(parsed, "--out") ?? process.cwd(),
			resolution: parseResolution(flagString(parsed, "--res")),
		}),
		parsed.flags.has("--json"),
		parsed.flags.has("--full"),
	);
};

export function sceneSource(fields: string[], full: boolean): string {
	const objectFields = fields
		.map((field) => `${JSON.stringify(field)}: ${SCENE_FIELDS[field]}`)
		.join(", ");
	const details = full || fields.length;
	return `_summary = _blender_axi_scene_summary()
_summary["name"] = C.scene.name
${details ? `_summary["items"] = [{${objectFields || '"name": o.name, "type": o.type'}} for o in C.scene.objects]` : `_summary["help"] = [f"Run \`blender-axi scene --full\` to show all {_summary['objects']} objects"]`}
print(json.dumps(_summary))`;
}

function sceneFields(value?: string): string[] {
	if (!value) return [];
	const fields = [...new Set(value.split(",").filter(Boolean))];
	const invalid = fields.filter((field) => !(field in SCENE_FIELDS));
	if (invalid.length) {
		throw usage(`Unknown scene field(s): ${invalid.join(",")}`, [
			`Valid fields: ${Object.keys(SCENE_FIELDS).join(",")}`,
		]);
	}
	return fields;
}

const sceneCommand: SessionCommand = async (args, context) => {
	const parsed = parseCommon(
		args,
		["--fields"],
		["--json", "--launch", "--full"],
	);
	requirePositionals(parsed, 0, "blender-axi scene");
	const fields = sceneFields(flagString(parsed, "--fields"));
	const full = parsed.flags.has("--full");
	await connected(context, parsed.flags.has("--launch"));
	const result = await executeSource(context, sceneSource(fields, full), {
		filename: "<blender-axi-scene>",
	});
	if (!result.ok)
		return executionOutput(result, parsed.flags.has("--json"), full);
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
		return jsonOr(
			{
				ok: true,
				status: "already-running",
				session: context.session,
				port: context.port,
			},
			parsed.flags.has("--json"),
		);
	} catch {
		const pid = await launchBlender(context);
		return jsonOr(
			{
				ok: true,
				status: "started",
				pid,
				session: context.session,
				port: context.port,
			},
			parsed.flags.has("--json"),
		);
	}
};

const stopCommand: SessionCommand = (args, context) => {
	const parsed = parseCommon(args, []);
	requirePositionals(parsed, 0, "blender-axi stop");
	const pid = stopBlender(context);
	const status = pid ? "stopped" : "not-owned";
	return jsonOr(
		{
			ok: true,
			status,
			...(pid ? { pid } : {}),
			...(!pid
				? { message: "no Blender process was launched by this session" }
				: {}),
		},
		parsed.flags.has("--json"),
	);
};

const setupCommand: Command = (args) => {
	if (args.length !== 1 || args[0] !== "hooks") {
		throw new AxiError("Unknown setup action", "VALIDATION_ERROR", [
			"Run `blender-axi setup hooks`",
		]);
	}
	const failures: string[] = [];
	installSessionStartHooks({ onError: (message) => failures.push(message) });
	return failures.length
		? {
				hooks: {
					status: "partial",
					integrations: ["Claude Code", "Codex", "OpenCode"],
					failures,
				},
			}
		: {
				hooks: {
					status: "installed",
					integrations: ["Claude Code", "Codex", "OpenCode"],
				},
			};
};

export function contentPreview(value: string, full: boolean) {
	if (full || value.length <= CONTENT_PREVIEW_LIMIT)
		return { value, truncated: false };
	return {
		value: `${value.slice(0, CONTENT_PREVIEW_LIMIT)}\n... (truncated, ${value.length} chars total)`,
		truncated: true,
	};
}

export function executionOutput(
	result: Awaited<ReturnType<typeof executeSource>>,
	json: boolean,
	full: boolean,
): AxiRenderable {
	if (!result.ok) {
		process.exitCode = 1;
		const stdout = contentPreview(result.stdout_before_failure, full);
		const traceback = contentPreview(result.traceback, full);
		const help =
			stdout.truncated || traceback.truncated
				? "Re-run the command with `--full` to show complete failure output"
				: undefined;
		const output = {
			...result,
			stdout_before_failure: stdout.value,
			traceback: traceback.value,
			...(help && { help: [help] }),
		};
		if (json) return JSON.stringify(output);
		return [
			"ok: false",
			`error: ${JSON.stringify(result.error)}`,
			multilineField("stdout_before_failure", stdout.value),
			multilineField("traceback", traceback.value),
			...(help ? [`help[1]: ${help}`] : []),
		].join("\n");
	}
	const stdout = contentPreview(result.stdout, full);
	const help = stdout.truncated
		? "Re-run the command with `--full` to show complete stdout"
		: undefined;
	const output = {
		...result,
		stdout: stdout.value,
		...(help && { help: [help] }),
	};
	if (json) return JSON.stringify(output);
	return [
		"ok: true",
		multilineField("stdout", stdout.value),
		`artifacts[${result.artifacts.length}]:${result.artifacts.length ? `\n${result.artifacts.map((path) => `  - ${JSON.stringify(path)}`).join("\n")}` : " []"}`,
		...(result.scene
			? [
					`scene:`,
					...Object.entries(result.scene).map(
						([key, value]) => `  ${key}: ${value}`,
					),
				]
			: []),
		...(help ? [`help[1]: ${help}`] : []),
	].join("\n");
}

function multilineField(name: string, value: string): string {
	const lines = value.replaceAll("\r\n", "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return `${name}: |${lines.length ? `\n${lines.map((line) => `  ${line}`).join("\n")}` : ""}`;
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

export async function main(
	options: { argv?: string[]; stdout?: { write(chunk: string): unknown } } = {},
): Promise<void> {
	await runAxiCli<SessionContext>({
		argv: options.argv,
		description: DESCRIPTION,
		version: readPackageVersion(),
		topLevelHelp: TOP_HELP,
		commands: COMMANDS,
		home: withContext(pingCommand),
		getCommandHelp: (command) =>
			COMMAND_HELP[command === "run" ? "exec" : command],
		...(options.stdout ? { stdout: options.stdout } : {}),
	});
}

function resolveContext(): SessionContext {
	const session = resolveSessionName();
	return {
		session,
		port: resolveSessionPort(session),
		stateDir: resolveSessionStateDir(session),
	};
}

function readPackageVersion(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [
		join(here, "..", "package.json"),
		join(here, "..", "..", "package.json"),
	]) {
		if (!existsSync(candidate)) continue;
		try {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
				name?: string;
				version?: string;
			};
			if (parsed.name === "blender-axi" && parsed.version)
				return parsed.version;
		} catch {}
	}
	throw new Error("Could not determine blender-axi package version");
}
