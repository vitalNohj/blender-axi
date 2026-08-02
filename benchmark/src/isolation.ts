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

interface OwnedProcess {
	pid: number;
	role: "blender" | "mcp" | "agent";
	port: number | null;
	started_at: string;
	executable: string;
	run_id: string;
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

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
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
		if (isAlive(processInfo.pid)) process.kill(processInfo.pid, "SIGTERM");
	const deadline = Date.now() + timeoutMilliseconds;
	while (owned.some((entry) => isAlive(entry.pid)) && Date.now() < deadline) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	const survivors = owned.filter((entry) => isAlive(entry.pid));
	for (const processInfo of survivors) process.kill(processInfo.pid, "SIGKILL");
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
	environment.BLENDER_MCP_DISABLE_TELEMETRY = "1";
	environment.BENCHMARK_RUN_DIR = layout.root;
	environment.BENCHMARK_WORKSPACE = layout.workspace;
	environment.BENCHMARK_OUTPUT = layout.output;
	return environment;
}

export async function writeBlenderStartup(
	path: string,
	port: number,
	addonPath: string,
): Promise<void> {
	const content = `import bpy\nimport importlib.util\nfrom pathlib import Path\naddon_path = Path(${JSON.stringify(addonPath)})\nspec = importlib.util.spec_from_file_location("benchmark_blendermcp_addon", addon_path)\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\ntry:\n    existing = getattr(bpy.types, "blendermcp_server", None)\n    if existing:\n        existing.stop()\nexcept Exception:\n    pass\nserver = module.BlenderMCPServer(port=${port})\nserver.start()\nbpy.types.blendermcp_server = server\nprint("BENCHMARK_LISTENER_READY:${port}", flush=True)\n`;
	await writeFile(path, content, { mode: 0o400 });
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
		detached: false,
	});
	if (child.pid === undefined) throw new Error(`Failed to spawn ${role}`);
	await registerOwnedProcess(registryPath, {
		pid: child.pid,
		role,
		port: options.port ?? null,
		started_at: new Date().toISOString(),
		executable,
		run_id: runId,
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
