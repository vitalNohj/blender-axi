import { describe, expect, it } from "vitest";
import {
	defaultPortForSession,
	resolveSessionName,
	resolveSessionPort,
	resolveSessionStateDir,
	validateSessionName,
} from "./sessions.js";

describe("sessions", () => {
	it("uses the legacy port for the default session", () => {
		expect(defaultPortForSession("default")).toBe(9876);
	});

	it("derives stable isolated ports and state directories", () => {
		expect(defaultPortForSession("worker-1")).toBe(
			defaultPortForSession("worker-1"),
		);
		expect(defaultPortForSession("worker-1")).not.toBe(9876);
		expect(defaultPortForSession("worker-1")).not.toBe(
			defaultPortForSession("worker-2"),
		);
		expect(resolveSessionStateDir("worker-1", "/tmp/home")).toBe(
			"/tmp/home/.blender-axi/sessions/worker-1",
		);
	});

	it.each(["../x", "a/b", "...", "x y", "x$", "a".repeat(65)])(
		"rejects unsafe name %s",
		(name) => {
			expect(() => validateSessionName(name)).toThrow(
				/Invalid BLENDER_AXI_SESSION/,
			);
		},
	);

	it("resolves environment overrides strictly", () => {
		expect(resolveSessionName({ BLENDER_AXI_SESSION: " test " })).toBe("test");
		expect(resolveSessionPort("test", { BLENDER_AXI_PORT: "12000" })).toBe(
			12000,
		);
		expect(() =>
			resolveSessionPort("test", { BLENDER_AXI_PORT: "12x" }),
		).toThrow(/Invalid BLENDER_AXI_PORT/);
		expect(() =>
			resolveSessionPort("test", { BLENDER_AXI_PORT: "70000" }),
		).toThrow(/Invalid BLENDER_AXI_PORT/);
	});
});
