import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupRunRootProcesses,
	findRunRootProcesses,
	writeBlenderStartup,
} from "../src/isolation.js";
import { detectPolicyViolations } from "../src/policy.js";
import { providerFailure } from "../src/agent-adapter.js";
import type { ToolEvent } from "../src/types.js";

// Behavioral regressions for the four defects diagnosed from the hash-verified
// archive of the interrupted four-cell rerun (artifacts/rerun-final-fbc5f53).
// Each test fails against the pre-repair behaviour and encodes the observed
// evidence rather than the implementation shape.

describe("D1: provider terminal errors are never a valid measured cell", () => {
	// Archive: every assistant message_end carried stopReason "error" with zero
	// content blocks, and the stream ended with auto_retry_end success=false,
	// yet the emitted envelope looked well-formed and the cell scored
	// valid/wrong_artifact.
	const exhausted = [
		{ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } },
		{ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } },
		{
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "Our servers are currently overloaded. Please try again later.",
		},
		{ type: "benchmark_envelope", answer: "", usage: { agent_turns: 12 } },
	];

	it("reports a terminal provider failure from an exhausted retry stream", () => {
		const failure = providerFailure(exhausted);
		expect(failure).not.toBeNull();
		expect(failure?.reason).toContain("overloaded");
	});

	it("reports a terminal failure when every assistant turn errored with no content", () => {
		const withoutRetryRecord = exhausted.filter(
			(record) => record.type !== "auto_retry_end",
		);
		expect(providerFailure(withoutRetryRecord)).not.toBeNull();
	});

	it("does not flag a run that produced a real assistant response", () => {
		const healthy = [
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "end_turn",
					content: [{ type: "text", text: "done" }],
				},
			},
			{ type: "benchmark_envelope", answer: "done", usage: { agent_turns: 4 } },
		];
		expect(providerFailure(healthy)).toBeNull();
	});

	it("does not flag a transient error that a later attempt recovered from", () => {
		const recovered = [
			{ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } },
			{ type: "auto_retry_end", success: true, attempt: 2 },
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "end_turn",
					content: [{ type: "text", text: "ok" }],
				},
			},
			{ type: "benchmark_envelope", answer: "ok", usage: { agent_turns: 6 } },
		];
		expect(providerFailure(recovered)).toBeNull();
	});
});

describe("D2: harness-authored paths must not contaminate the transcript", () => {
	it("keeps the host addon path out of the agent-readable startup script", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-startup-"));
		const startup = join(root, "benchmark-startup.py");
		await writeBlenderStartup(startup, 26926, "/Users/nohj/blender/addon.py");
		const content = await readFile(startup, "utf8");
		expect(content).not.toContain("/Users/");
	});

	it("does not blame the agent for reading a harness-generated file", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-startup-"));
		const startup = join(root, "benchmark-startup.py");
		await writeBlenderStartup(startup, 26926, "/Users/nohj/blender/addon.py");
		const response = await readFile(startup, "utf8");
		// Replays archived interface event 13: agent command is clean, the
		// response is the harness-authored file.
		const event = {
			interface: "shell",
			tool: "shell",
			arguments: { command: "blender-axi exec workspace/benchmark-startup.py" },
			response,
		} as unknown as ToolEvent;
		expect(detectPolicyViolations("axi", [event])).toEqual([]);
	});

	it("still denies a real agent-originated host path", () => {
		const event = {
			interface: "shell",
			tool: "shell",
			arguments: { command: "blender-axi exec /Users/nohj/secret/plan.py" },
			response: "ok",
		} as unknown as ToolEvent;
		const violations = detectPolicyViolations("axi", [event]);
		expect(violations.some((item) => item.rule === "common-deny")).toBe(true);
	});

	it("still denies a host path the agent discovered and echoed back", () => {
		const event = {
			interface: "shell",
			tool: "shell",
			arguments: { command: "blender-axi exec workspace/solve.py" },
			response: "wrote /Users/nohj/Desktop/out.blend",
		} as unknown as ToolEvent;
		const violations = detectPolicyViolations("axi", [event]);
		expect(violations.some((item) => item.rule === "common-deny")).toBe(true);
	});
});

describe("D3: the isolated listener must serve commands", () => {
	// Archive root cause: the startup script exec_module()'d the addon but never
	// called register(), so the Scene properties the command dispatcher reads
	// (blendermcp_use_polyhaven at addon.py:289) did not exist. Every command
	// failed with "'Scene' object has no attribute 'blendermcp_use_polyhaven'",
	// which made get_scene_info fail and drove --launch to start a second
	// Blender that bound the default port 9876.
	it("registers the addon so the command dispatcher has its scene properties", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-startup-"));
		const startup = join(root, "benchmark-startup.py");
		await writeBlenderStartup(startup, 26926, "/tmp/pinned/addon.py");
		const content = await readFile(startup, "utf8");
		expect(content).toContain("register()");
	});

	it("installs a running server on the isolated port before register() can autostart 9876", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-startup-"));
		const startup = join(root, "benchmark-startup.py");
		await writeBlenderStartup(startup, 26926, "/tmp/pinned/addon.py");
		const content = await readFile(startup, "utf8");
		// The addon's register-time autostart only constructs a server when none
		// is installed, and only starts one that is not already running. Both
		// guards must already be satisfied by the time register() runs, otherwise
		// it binds its default port.
		const construct = content.indexOf("BlenderMCPServer(port=26926)");
		const start = content.indexOf("server.start()");
		const install = content.indexOf("bpy.types.blendermcp_server = server");
		const registerCall = content.indexOf("module.register()");
		expect(construct).toBeGreaterThan(-1);
		expect(registerCall).toBeGreaterThan(start);
		expect(registerCall).toBeGreaterThan(install);
	});

	it("never leaves the default 9876 port in the generated startup script", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-startup-"));
		const startup = join(root, "benchmark-startup.py");
		await writeBlenderStartup(startup, 26926, "/tmp/pinned/addon.py");
		expect(await readFile(startup, "utf8")).not.toContain("9876");
	});
});

describe("D4: agent-launched descendants cannot outlive a cell", () => {
	it("finds a process the harness never registered", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-sweep-"));
		// A Blender the agent's own CLI launched: absent from the registry,
		// present in the run root.
		const found = await findRunRootProcesses(
			root,
			async () => `424242 blender BENCHMARK_RUN_DIR=${root}\n`,
		);
		expect(found).toEqual([424242]);
	});

	it("does not claim an unrelated process using a run-root file", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-sweep-"));
		const found = await findRunRootProcesses(
			root,
			async () => "424242 tail workspace/cell.log\n",
		);
		expect(found).toEqual([]);
	});

	it("does not accept a marker for a different run root", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-sweep-"));
		const found = await findRunRootProcesses(
			root,
			async () => `424242 blender BENCHMARK_RUN_DIR=${root}-other\n`,
		);
		expect(found).toEqual([]);
	});

	it("propagates process inspection failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-sweep-"));
		const failure = new Error("process inspection timed out");
		await expect(
			findRunRootProcesses(root, async () => Promise.reject(failure)),
		).rejects.toBe(failure);
	});

	it("ignores the benchmark process itself", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-sweep-"));
		const found = await findRunRootProcesses(
			root,
			async () => `${process.pid} node BENCHMARK_RUN_DIR=${root}\n`,
		);
		expect(found).toEqual([]);
	});

	it("reports a clean run root when nothing survived", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-sweep-"));
		expect(await cleanupRunRootProcesses(root, async () => "")).toEqual([]);
	});

	it("terminates a real surviving descendant", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-sweep-"));
		const { spawn } = await import("node:child_process");
		const survivor = spawn("sleep", ["30"], { stdio: "ignore" });
		const pid = survivor.pid as number;
		const exited = new Promise<NodeJS.Signals | null>((done) =>
			survivor.once("exit", (_code, signal) => done(signal)),
		);
		const reaped = await cleanupRunRootProcesses(
			root,
			async () => `${pid} sleep BENCHMARK_RUN_DIR=${root}\n`,
		);
		expect(reaped).toEqual([pid]);
		expect(await exited).toBe("SIGTERM");
	});
});
