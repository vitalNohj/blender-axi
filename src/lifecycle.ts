import {
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { requestAddon, type SessionContext } from "./client.js";
import { resolveSessionPidFile } from "./sessions.js";

const DEFAULT_BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender";

function launchExpression(port: number): string {
	return `import bpy\nbpy.context.scene.blendermcp_port=${port}\ndef _start():\n try:\n  bpy.ops.blendermcp.start_server()\n  print("blender-axi: server started on port ${port}")\n except Exception as exc:\n  print("blender-axi: autostart failed: %s" % exc)\n return None\nbpy.app.timers.register(_start, first_interval=0.5)`;
}

export async function launchBlender(context: SessionContext): Promise<number> {
	mkdirSync(context.stateDir, { recursive: true });
	const logPath = join(context.stateDir, "blender.log");
	const log = openSync(logPath, "a");
	const child = spawn(
		process.env.BLENDER_AXI_BLENDER ?? DEFAULT_BLENDER,
		["--python-expr", launchExpression(context.port)],
		{
			detached: true,
			stdio: ["ignore", log, log],
		},
	);
	child.unref();
	if (!child.pid) throw new Error("Blender launch did not return a process ID");
	writeFileSync(resolveSessionPidFile(context.session), `${child.pid}\n`);
	await waitForBlender(context);
	return child.pid;
}

export async function ensureBlender(
	context: SessionContext,
	launch: boolean,
): Promise<void> {
	try {
		await requestAddon(context, "get_scene_info");
	} catch (error) {
		if (!launch) throw error;
		await launchBlender(context);
	}
}

async function waitForBlender(
	context: SessionContext,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await requestAddon(context, "get_scene_info");
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(
		`Blender did not start session "${context.session}" on port ${context.port} within ${timeoutMs}ms`,
		{ cause: lastError },
	);
}

export function stopBlender(context: SessionContext): number | undefined {
	const pidFile = resolveSessionPidFile(context.session);
	let pid: number;
	try {
		pid = Number(readFileSync(pidFile, "utf8").trim());
	} catch {
		return undefined;
	}
	if (!Number.isSafeInteger(pid) || pid <= 0)
		throw new Error(`Invalid Blender PID file: ${pidFile}`);
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	rmSync(pidFile, { force: true });
	return pid;
}
