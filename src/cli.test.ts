import { afterEach, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { contentPreview, main, sceneSource } from "./cli.js";
import { createSkillMarkdown } from "./skill.js";

afterEach(() => {
	process.exitCode = undefined;
});

describe("cli errors", () => {
	it("formats usage errors with exit code 2", async () => {
		let output = "";
		await main({
			argv: ["render", "north"],
			stdout: {
				write: (chunk) => {
					output += chunk;
				},
			},
		});
		expect(process.exitCode).toBe(2);
		expect(output).toContain("Invalid render angles");
		expect(output).toContain("front,side,back,tq");
	});

	it("shows command help without connecting", async () => {
		let output = "";
		await main({
			argv: ["exec", "--help"],
			stdout: {
				write: (chunk) => {
					output += chunk;
				},
			},
		});
		expect(output).toContain("guaranteed traceback");
		expect(process.exitCode).toBeUndefined();
	});
});

describe("AXI conformance", () => {
	it("renders exact spec-conformant TOON for nested tabular and escaped values", async () => {
		const value = {
			name: 'Scene, "quoted"\nline',
			objects: {
				count: 2,
				items: [
					{ name: "Cube", type: "MESH" },
					{ name: 'Rig, "A"\nroot', type: "ARMATURE" },
				],
			},
			collections: { count: 0, items: [] },
			materials: { count: 1, items: ['Metal, "blue"\ncoat'] },
		};
		const expected = `name: "Scene, \\"quoted\\"\\nline"
objects:
  count: 2
  items[2]{name,type}:
    Cube,MESH
    "Rig, \\"A\\"\\nroot",ARMATURE
collections:
  count: 0
  items: []
materials:
  count: 1
  items[1]: "Metal, \\"blue\\"\\ncoat"`;
		let output = "";
		await runAxiCli({
			argv: ["probe"],
			description: "probe",
			topLevelHelp: "",
			commands: { probe: () => value },
			home: () => value,
			stdout: { write: (chunk) => void (output += chunk) },
		});
		expect(output).toBe(`${expected}\n`);
		expect(decode(expected)).toEqual(value);
	});

	it("truncates long content with total size and a full escape hatch", () => {
		const long = "x".repeat(1600);
		expect(contentPreview(long, false)).toEqual({
			value: `${"x".repeat(1500)}\n... (truncated, 1600 chars total)`,
			truncated: true,
		});
		expect(contentPreview(long, true)).toEqual({
			value: long,
			truncated: false,
		});
	});

	it("keeps scene defaults minimal and expands only requested fields or rows", () => {
		const compact = sceneSource([], false);
		expect(compact).toContain('"name": o.name, "type": o.type');
		expect(compact).toContain("list(C.scene.objects)[:20]");
		expect(compact).not.toContain("vertices");

		const expanded = sceneSource(["visible", "vertices"], true);
		expect(expanded).toContain('"visible": o.visible_get()');
		expect(expanded).toContain('"vertices": len(o.data.vertices)');
		expect(expanded).not.toContain("[:20]");
	});

	it("generates a static skill with only npx command examples", () => {
		const skill = createSkillMarkdown();
		expect(skill).toContain("user-invocable: false");
		expect(skill).toContain("metadata:\n  hermes:");
		for (const line of skill.split("\n")) {
			if (/blender-axi (?:ping|exec|build|render|scene|start|stop|setup)/.test(line))
				expect(line).toContain("npx -y blender-axi");
		}
		expect(skill).not.toContain("session: default");
	});
});
