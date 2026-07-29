import { afterEach, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { contentPreview, executionOutput, main, sceneSource } from "./cli.js";
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

	it("renders execution text with real newlines while preserving JSON", () => {
		const result = {
			ok: false as const,
			error: "missing object",
			stdout_before_failure: "before\n",
			traceback:
				'Traceback (most recent call last):\n  File "broken.py", line 1\nKeyError: nope\n',
		};
		const rendered = executionOutput(result, false, false);
		expect(rendered).toContain(
			'traceback: |\n  Traceback (most recent call last):\n    File "broken.py", line 1\n  KeyError: nope',
		);
		expect(rendered).not.toContain("\\n");
		expect(JSON.parse(executionOutput(result, true, false) as string)).toEqual(
			result,
		);
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

	it("defaults scene output to aggregates and opts into object rows", () => {
		const compact = sceneSource([], false);
		expect(compact).toContain("_blender_axi_scene_summary()");
		expect(compact).not.toContain('"items"');

		const expanded = sceneSource(["visible", "vertices"], false);
		expect(expanded).toContain('"visible": o.visible_get()');
		expect(expanded).toContain('"vertices": len(o.data.vertices)');
		expect(expanded).toContain('for o in C.scene.objects');

		const full = sceneSource([], true);
		expect(full).toContain('"name": o.name, "type": o.type');
	});

	it("includes aggregate scene state in successful build output", () => {
		const rendered = executionOutput(
			{
				ok: true,
				stdout: "built\n",
				artifacts: ["/tmp/a.blend"],
				scene: {
					objects: 3,
					meshes: 1,
					triangles: 12,
					materials: 2,
					collections: 1,
				},
			},
			false,
			false,
		);
		expect(rendered).toContain("scene:\n  objects: 3\n  meshes: 1\n  triangles: 12");
	});

	it("generates a static skill with only npx command examples", () => {
		const skill = createSkillMarkdown();
		expect(skill).toContain("user-invocable: false");
		expect(skill).toContain("metadata:\n  hermes:");
		for (const line of skill.split("\n")) {
			if (
				/blender-axi (?:ping|exec|build|render|scene|start|stop|setup)/.test(
					line,
				)
			)
				expect(line).toContain("npx -y blender-axi");
		}
		expect(skill).not.toContain("session: default");
	});
});
