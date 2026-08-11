import { constants } from "node:fs";
import {
	access,
	chmod,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { materializeReadOnlyFixture } from "./fixtures.js";
import { assertInside, writeJsonAtomic } from "./util.js";

export interface RunLayout {
	root: string;
	fixture: string;
	workspace: string;
	output: string;
	logs: string;
	transcript: string;
	artifacts: string;
	oracles: string;
	processRegistry: string;
}

export interface OwnedProcess {
	pid: number;
	role: "blender" | "mcp" | "agent";
	port: number | null;
	started_at: string;
	executable: string;
	run_id: string;
	// Set when the process was spawned as its own group leader, so teardown must
	// signal the whole group to reap grandchildren such as the pinned BlenderMCP
	// server and the Blender process it drives.
	process_group?: boolean;
}

export async function createRunLayout(
	benchmarkRoot: string,
	runsRoot: string,
	runId: string,
	taskId: string,
): Promise<RunLayout> {
	const safeRunsRoot = resolve(runsRoot);
	const root = assertInside(safeRunsRoot, join(safeRunsRoot, runId));
	try {
		await access(root, constants.F_OK);
		throw new Error(`Run directory already exists: ${root}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const layout: RunLayout = {
		root,
		fixture: join(root, "fixture"),
		workspace: join(root, "workspace"),
		output: join(root, "output"),
		logs: join(root, "logs"),
		transcript: join(root, "transcript"),
		artifacts: join(root, "artifacts"),
		oracles: join(root, "oracles"),
		processRegistry: join(root, "owned-processes.json"),
	};
	await mkdir(root, { recursive: false, mode: 0o700 });
	for (const directory of [
		layout.workspace,
		layout.output,
		layout.logs,
		layout.transcript,
		layout.artifacts,
		layout.oracles,
	]) {
		await mkdir(directory, { mode: 0o700 });
	}
	await materializeReadOnlyFixture(benchmarkRoot, taskId, layout.fixture);
	await writeJsonAtomic(layout.processRegistry, []);
	return layout;
}

async function listenable(port: number): Promise<boolean> {
	return await new Promise((resolvePromise) => {
		const server = createServer();
		server.unref();
		server.once("error", () => resolvePromise(false));
		server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
			server.close(() => resolvePromise(true)),
		);
	});
}

export async function chooseUniquePort(
	minimum: number,
	maximum: number,
	seed: number,
): Promise<number> {
	const span = maximum - minimum + 1;
	for (let offset = 0; offset < span; offset += 1) {
		const port = minimum + ((seed + offset * 7919) % span);
		if (await listenable(port)) return port;
	}
	throw new Error(`No free benchmark port in ${minimum}-${maximum}`);
}

export async function assertPortClosed(port: number): Promise<void> {
	if (!(await listenable(port)))
		throw new Error(`Port ${port} is already in use`);
}

export async function registerOwnedProcess(
	path: string,
	process: OwnedProcess,
): Promise<void> {
	let current: OwnedProcess[];
	try {
		current = JSON.parse(await readFile(path, "utf8")) as OwnedProcess[];
	} catch (error) {
		throw new Error(
			`Cannot read owned-process registry ${path}: ${(error as Error).message}`,
			{ cause: error },
		);
	}
	current.push(process);
	await writeJsonAtomic(path, current);
}

export async function registerSpawnedProcess(
	path: string,
	child: ReturnType<typeof spawn>,
	processInfo: Omit<OwnedProcess, "pid">,
): Promise<OwnedProcess> {
	if (child.pid === undefined)
		throw new Error(`Failed to spawn ${processInfo.role}`);
	const owned = { ...processInfo, pid: child.pid };
	try {
		await registerOwnedProcess(path, owned);
		return owned;
	} catch (error) {
		const exit = new Promise<void>((resolvePromise) =>
			child.once("exit", () => resolvePromise()),
		);
		signalProcess(owned, "SIGKILL");
		if (child.exitCode === null && child.signalCode === null)
			await exit;
		throw error;
	}
}

function signalProcess(entry: OwnedProcess, signal: NodeJS.Signals): void {
	try {
		process.kill(entry.process_group ? -entry.pid : entry.pid, signal);
	} catch {
		// Already exited; there is nothing left to signal.
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// Processes the agent starts itself are unregistrable by construction: only
// harness spawn sites call spawnOwned/registerSpawnedProcess. The first live
// rerun ended with an empty registry while a Blender the agent's CLI had
// launched still held port 9876, so the registry alone cannot guarantee a clean
// cell. Sweeping by run root catches those descendants regardless of who
// spawned them, without touching unrelated processes on the host.
export async function findRunRootProcesses(
	runRoot: string,
	inspect: (root: string) => Promise<string> = defaultProcessInspector,
): Promise<number[]> {
	const listing = await inspect(runRoot).catch(() => "");
	const pids = new Set<number>();
	for (const line of listing.split("\n")) {
		const pid = Number.parseInt(line.trim().split(/\s+/u)[0] ?? "", 10);
		if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
	}
	return [...pids];
}

async function defaultProcessInspector(runRoot: string): Promise<string> {
	const { execFile } = await import("node:child_process");
	return new Promise((resolvePromise) => {
		// lsof reports every process with a file or cwd inside the run root,
		// which is exactly the set a cell is allowed to leave behind: none.
		execFile(
			"lsof",
			["-t", "+D", runRoot],
			{ timeout: 10_000 },
			(_error, stdout) => resolvePromise(stdout ?? ""),
		);
	});
}

export async function cleanupRunRootProcesses(
	runRoot: string,
	inspect?: (root: string) => Promise<string>,
): Promise<number[]> {
	const pids = await findRunRootProcesses(runRoot, inspect);
	const reaped: number[] = [];
	for (const pid of pids) {
		if (!isAlive(pid)) continue;
		reaped.push(pid);
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already exited between the scan and the signal.
		}
	}
	if (!reaped.length) return reaped;
	const deadline = Date.now() + 5_000;
	while (reaped.some((pid) => isAlive(pid)) && Date.now() < deadline)
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	for (const pid of reaped) {
		if (!isAlive(pid)) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already exited during the grace period.
		}
	}
	return reaped;
}

export async function cleanupOwnedProcesses(
	registryPath: string,
	timeoutMilliseconds = 15_000,
): Promise<void> {
	let owned: OwnedProcess[];
	try {
		owned = JSON.parse(await readFile(registryPath, "utf8")) as OwnedProcess[];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const processInfo of owned)
		if (isAlive(processInfo.pid)) signalProcess(processInfo, "SIGTERM");
	const deadline = Date.now() + timeoutMilliseconds;
	while (owned.some((entry) => isAlive(entry.pid)) && Date.now() < deadline) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	const survivors = owned.filter((entry) => isAlive(entry.pid));
	for (const processInfo of survivors) signalProcess(processInfo, "SIGKILL");
	// Sweep the groups unconditionally: a leader can exit while the BlenderMCP
	// server or Blender process it spawned is still running and holding a port.
	for (const processInfo of owned)
		if (processInfo.process_group) signalProcess(processInfo, "SIGKILL");
	for (const processInfo of owned)
		if (processInfo.port !== null) await assertPortClosed(processInfo.port);
	await writeJsonAtomic(registryPath, []);
}

export function sanitizedEnvironment(
	layout: RunLayout,
	port: number,
	inherited: NodeJS.ProcessEnv = process.env,
	credentialEnvironmentVariables: string[] = [],
): NodeJS.ProcessEnv {
	const allow = ["PATH", "TMPDIR", ...credentialEnvironmentVariables];
	const environment: NodeJS.ProcessEnv = {};
	for (const key of allow)
		if (inherited[key] !== undefined) environment[key] = inherited[key];
	environment.HOME = join(layout.root, "home");
	environment.BLENDER_AXI_PORT = String(port);
	environment.BLENDER_AXI_STATE_DIR = join(layout.root, "state");
	// The stock BlenderMCP server connects to BLENDER_HOST/BLENDER_PORT and
	// otherwise falls back to localhost:9876. Each cell drives its own Blender on
	// a unique isolated port, so without these the MCP arm would either fail to
	// connect or reach an unrelated external Blender on 9876.
	environment.BLENDER_HOST = "127.0.0.1";
	environment.BLENDER_PORT = String(port);
	environment.BLENDER_MCP_DISABLE_TELEMETRY = "1";
	environment.BENCHMARK_RUN_DIR = layout.root;
	environment.BENCHMARK_WORKSPACE = layout.workspace;
	environment.BENCHMARK_OUTPUT = layout.output;
	return environment;
}

// The startup script runs inside the agent's workspace, so anything it
// contains can surface in the agent's tool transcript. Embedding the pinned
// addon's absolute host path made a harness-authored "/Users/" string appear in
// a tool response and cost a cell a policy violation the agent did not cause.
// The path is passed through the Blender process environment instead, which
// keeps the real deny rule intact for genuinely agent-originated host paths.
//
// The script also has to register the addon, not merely import it. Loading the
// module alone leaves the Scene properties unregistered, and the addon's
// command dispatcher reads scene.blendermcp_use_polyhaven before dispatching
// any handler, so every command failed with "'Scene' object has no attribute
// 'blendermcp_use_polyhaven'". That made the AXI probe fail against a healthy
// listener and drove --launch to start a second Blender on the default port.
// The pinned server is created and started before register() so the addon's
// register-time autostart finds a running server and cannot bind 9876.
export async function writeBlenderStartup(
	path: string,
	port: number,
	addonPath: string,
): Promise<void> {
	if (!addonPath.startsWith("/"))
		throw new Error(
			"The pinned addon path must be absolute so the startup script can resolve it",
		);
	const lines = [
		"import bpy",
		"import importlib.util",
		"import os",
		"from pathlib import Path",
		// Resolved from the Blender process environment so the host path never
		// reaches the agent-readable script or, through it, the tool transcript.
		'addon_path = Path(os.environ["BENCHMARK_ADDON_PATH"])',
		'spec = importlib.util.spec_from_file_location("benchmark_blendermcp_addon", addon_path)',
		"module = importlib.util.module_from_spec(spec)",
		"spec.loader.exec_module(module)",
		"try:",
		'    existing = getattr(bpy.types, "blendermcp_server", None)',
		"    if existing:",
		"        existing.stop()",
		"except Exception:",
		"    pass",
		// Install the pinned server before register() runs. The addon auto-starts
		// at register time and would otherwise construct its own server on the
		// default port; finding one already running makes that a no-op.
		`server = module.BlenderMCPServer(port=${port})`,
		"server.start()",
		"bpy.types.blendermcp_server = server",
		// register() defines the Scene properties the addon's command dispatcher
		// reads before dispatching any handler. Without it every command fails
		// with "'Scene' object has no attribute 'blendermcp_use_polyhaven'".
		"module.register()",
		'scene = getattr(bpy.context, "scene", None)',
		"if scene is not None:",
		`    scene.blendermcp_port = ${port}`,
		`print("BENCHMARK_LISTENER_READY:${port}", flush=True)`,
	];
	await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o400 });
}

export async function spawnOwned(
	registryPath: string,
	runId: string,
	role: OwnedProcess["role"],
	executable: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		port?: number;
		stdoutPath: string;
		stderrPath: string;
	},
): Promise<ReturnType<typeof spawn>> {
	const stdout = await import("node:fs").then(({ openSync }) =>
		openSync(options.stdoutPath, "a", 0o600),
	);
	const stderr = await import("node:fs").then(({ openSync }) =>
		openSync(options.stderrPath, "a", 0o600),
	);
	const child = spawn(executable, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", stdout, stderr],
		detached: true,
	});
	await registerSpawnedProcess(registryPath, child, {
		role,
		port: options.port ?? null,
		started_at: new Date().toISOString(),
		executable,
		run_id: runId,
		process_group: true,
	});
	return child;
}

export async function removeRunLayout(
	runsRoot: string,
	runId: string,
): Promise<void> {
	const target = assertInside(
		resolve(runsRoot),
		join(resolve(runsRoot), runId),
	);
	await chmod(join(target, "fixture"), 0o700).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		},
	);
	await rm(target, { recursive: true, force: true });
}

export async function lockFixture(layout: RunLayout): Promise<void> {
	await chmod(layout.fixture, 0o555);
}
