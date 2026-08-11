import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupOwnedProcesses,
	chooseUniquePort,
	registerOwnedProcess,
	registerSpawnedProcess,
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
		}, ["API_KEY"]);
		expect(environment.API_KEY).toBe("secret");
		expect(
			sanitizedEnvironment(layout, port, { API_KEY: "secret" }).API_KEY,
		).toBeUndefined();
		expect(environment.HOME).toBe(join(root, "home"));
		expect(environment.BLENDER_AXI_PORT).toBe(String(port));
	});

	it("does not leak an interpreter-bearing HOME into the MCP arm", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-uvhome-"));
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
		// uvx resolves its managed interpreter and cache under HOME. Each cell gets
		// a fresh empty HOME, so an unpinned uvx falls back to the system python
		// and cannot satisfy the pinned server's requires-python floor. The staged
		// launcher must therefore carry explicit pins rather than inherit them.
		const environment = sanitizedEnvironment(
			layout,
			24_311,
			{
				PATH: "/bin",
				HOME: "/Users/someone",
				UV_CACHE_DIR: "/Users/someone/.cache/uv",
				UV_PYTHON_INSTALL_DIR: "/Users/someone/.local/share/uv/python",
			},
			[],
		);
		expect(environment.HOME).toBe(join(root, "home"));
		expect(environment.HOME).not.toBe("/Users/someone");
		expect(environment.UV_CACHE_DIR).toBeUndefined();
		expect(environment.UV_PYTHON_INSTALL_DIR).toBeUndefined();
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

	it("kills a spawned process when ownership registration fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-register-failure-"));
		const child = (await import("node:child_process")).spawn(
			process.execPath,
			["-e", "setInterval(()=>{},1000)"],
			{ stdio: "ignore", detached: true },
		);
		expect(child.pid).toBeDefined();
		await expect(
			registerSpawnedProcess(join(root, "missing", "owned-processes.json"), child, {
				role: "agent",
				port: null,
				started_at: new Date().toISOString(),
				executable: process.execPath,
				run_id: "registration-failure",
				process_group: true,
			}),
		).rejects.toThrow(/owned-process registry/u);
		expect(() => process.kill(child.pid!, 0)).toThrow();
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
