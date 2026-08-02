import { describe, expect, it } from "vitest";
import { detectPolicyViolations } from "../src/policy.js";
import { extractToolEvents, summarizeEvents } from "../src/transcript.js";
import type { ToolEvent } from "../src/types.js";

const shell = (command: string): ToolEvent => ({
	timestamp: null,
	tool: "shell",
	interface: "shell",
	arguments: { command },
	response: "ok",
	success: true,
	duration_seconds: null,
});
const mcp = (tool: string): ToolEvent => ({
	timestamp: null,
	tool,
	interface: "mcp",
	arguments: {},
	response: {},
	success: true,
	duration_seconds: null,
});

describe("arm policy", () => {
	it("accepts isolated arm calls", () => {
		expect(
			detectPolicyViolations("axi", [shell("blender-axi scene --full")]),
		).toEqual([]);
		expect(
			detectPolicyViolations("mcp", [mcp("mcp__blender__get_scene_info")]),
		).toEqual([]);
	});

	it("detects wrong interfaces and forbidden helpers", () => {
		expect(
			detectPolicyViolations("axi", [mcp("mcp__blender__get_scene_info")]).some(
				(item) => item.rule === "wrong-interface",
			),
		).toBe(true);
		expect(
			detectPolicyViolations("mcp", [shell("blender-axi scene")]).some(
				(item) => item.rule === "wrong-interface",
			),
		).toBe(true);
		expect(
			detectPolicyViolations("axi", [shell("python socket_helper.py")]).length,
		).toBeGreaterThan(0);
	});
});

describe("nested provider transcript", () => {
	it("finds nested tool calls and results", () => {
		const records = [
			{
				message: {
					content: [
						{
							type: "tool_use",
							id: "call-1",
							name: "shell",
							input: { command: "blender-axi --help" },
						},
					],
				},
			},
			{
				event: {
					payload: {
						type: "tool_result",
						tool_use_id: "call-1",
						content: "help",
						is_error: false,
					},
				},
			},
		];
		const events = extractToolEvents(records);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			tool: "shell",
			response: "help",
			success: true,
		});
		expect(summarizeEvents(events)).toMatchObject({
			tool_calls: 1,
			help_calls: 1,
			failed_tool_calls: 0,
		});
	});
});
