import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupOwnedProcesses,
	chooseUniquePort,
	registerOwnedProcess,
	sanitizedEnvironment,
} from "../src/isolation.js";
import { redact } from "../src/util.js";

describe("isolation and redaction", () => {
	it("uses a unique closed port and a minimal environment", async () => {
		const port = await chooseUniquePort(23000, 23100, 7);
		expect(port).toBeGreaterThanOrEqual(23000);
		const root = await mkdtemp(join(tmpdir(), "blend-bench-env-"));
		const layout = {
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
		const environment = sanitizedEnvironment(layout, port, {
			PATH: "/bin",
			API_KEY: "secret",
			HOME: "/user",
		});
		expect(environment.API_KEY).toBeUndefined();
		expect(environment.HOME).toBe(join(root, "home"));
		expect(environment.BLENDER_AXI_PORT).toBe(String(port));
	});

	it("kills only registered owned fake processes", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-process-"));
		const registry = join(root, "owned-processes.json");
		await writeFile(registry, "[]\n");
		const child = (await import("node:child_process")).spawn(
			process.execPath,
			["-e", "setInterval(()=>{},1000)"],
			{ stdio: "ignore" },
		);
		expect(child.pid).toBeDefined();
		await registerOwnedProcess(registry, {
			pid: child.pid!,
			role: "agent",
			port: null,
			started_at: new Date().toISOString(),
			executable: process.execPath,
			run_id: "fake",
		});
		await cleanupOwnedProcesses(registry, 2000);
		expect(JSON.parse(await readFile(registry, "utf8"))).toEqual([]);
	});

	it("redacts secret keys and token-shaped values", () => {
		const output = redact({
			Authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
			nested: "sk-abcdefghijklmnopqrstuvwxyz",
			safe: "visible",
		}) as Record<string, unknown>;
		expect(output.Authorization).toBe("[REDACTED]");
		expect(output.nested).toBe("[REDACTED]");
		expect(output.safe).toBe("visible");
	});
});
