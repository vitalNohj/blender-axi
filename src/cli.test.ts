import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import {
	COMMAND_HELP,
	TOP_HELP,
	contentPreview,
	executionOutput,
	filterTraceback,
	main,
	sceneSource,
} from "./cli.js";
import { createSkillMarkdown } from "./skill.js";

/**
 * A port no Blender listener can answer on, so validation-ordering assertions
 * prove the CLI rejects usage errors before it ever reaches the network.
 */
const DEAD_PORT = "59999";
let savedPort: string | undefined;

beforeEach(() => {
	savedPort = process.env.BLENDER_AXI_PORT;
	process.env.BLENDER_AXI_PORT = DEAD_PORT;
});

afterEach(() => {
	process.exitCode = undefined;
	if (savedPort === undefined) delete process.env.BLENDER_AXI_PORT;
	else process.env.BLENDER_AXI_PORT = savedPort;
});

async function run(argv: string[]): Promise<string> {
	let output = "";
	await main({
		argv,
		stdout: {
			write: (chunk) => {
				output += chunk;
			},
		},
	});
	return output;
}

describe("cli errors", () => {
	it("formats usage errors with exit code 2", async () => {
		const output = await run(["render", "north"]);
		expect(process.exitCode).toBe(2);
		expect(output).toContain("Invalid render angles");
		expect(output).toContain("front,side,back,tq");
	});

	it("validates render angles, resolution, and scene fields before connecting", async () => {
		for (const argv of [
			["render", "north"],
			["render", "front", "--res", "12x"],
			["scene", "--fields", "bogus"],
		]) {
			const output = await run(argv);
			expect(process.exitCode, argv.join(" ")).toBe(2);
			expect(output).toContain("VALIDATION_ERROR");
			expect(output).not.toContain("No Blender addon answered");
			process.exitCode = undefined;
		}
	});

	it("makes an unreachable Blender listener actionable", async () => {
		const output = await run(["ping"]);
		expect(process.exitCode).toBe(1);
		expect(output).toContain(`on port ${DEAD_PORT}`);
		expect(output).not.toContain("UNKNOWN");
		expect(output).toContain("blender-axi start");
		expect(output).toContain("--launch");
	});

	it("shows command help without connecting", async () => {
		const output = await run(["exec", "--help"]);
		expect(output).toContain("guaranteed traceback");
		expect(process.exitCode).toBeUndefined();
	});

	it("keeps `run` as a public alias of `exec`", async () => {
		expect(await run(["run", "--help"])).toBe(COMMAND_HELP.exec);
		expect(process.exitCode).toBeUndefined();
		// The alias resolves to a real command, not the unknown-command path.
		const output = await run(["run", "script.py"]);
		expect(output).not.toContain("Unknown command");
		expect(output).toContain("No Blender addon answered");
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

	it("truncates success stdout from the head and failure fields from the tail", () => {
		const long = `HEAD${"x".repeat(1600)}TAIL`;
		const head = contentPreview(long, false, "head");
		expect(head).toEqual({
			value: `${long.slice(0, 1500)}\n... (truncated, 1608 chars total)`,
			truncated: true,
		});
		expect(head.value).toContain("HEAD");
		expect(head.value).not.toContain("TAIL");
		const tail = contentPreview(long, false, "tail");
		expect(tail).toEqual({
			value: `... (truncated, 1608 chars total)\n${long.slice(-1500)}`,
			truncated: true,
		});
		expect(tail.value).not.toContain("HEAD");
		expect(tail.value).toContain("TAIL");
		expect(contentPreview(long, true, "head")).toEqual({
			value: long,
			truncated: false,
		});
		expect(contentPreview(long, true, "tail")).toEqual({
			value: long,
			truncated: false,
		});
		expect(contentPreview("short", false, "head")).toEqual({
			value: "short",
			truncated: false,
		});

		const success = executionOutput(
			{ ok: true, stdout: long, artifacts: [] },
			false,
			false,
		) as string;
		expect(success).toContain("HEAD");
		expect(success).not.toContain("TAIL");
		const failure = executionOutput(
			{
				ok: false,
				error: "failed",
				stdout_before_failure: long,
				traceback: long,
			},
			false,
			false,
		) as string;
		expect(failure).not.toContain("HEAD");
		expect(failure).toContain("TAIL");
	});

	it("strips the internal prelude frame and caret decoration from tracebacks", () => {
		const raw = `Traceback (most recent call last):
  File "<string>", line 56, in <module>
    exec(_blender_axi_compile(user, "/tmp/user_build.py"), globals(), globals())
    ~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/tmp/build.py", line 12, in <module>
    build_part(i)
    ~~~~~~~~~~^^^
  File "/tmp/build.py", line 4, in bevel_edges
    raise RuntimeError("bevel failed")
  File "<string>", line 1, in <module>
    raise RuntimeError("nested exec failed")
RuntimeError: bevel failed
`;
		const filtered = filterTraceback(raw);
		expect(filtered).toContain('File "<string>", line 1, in <module>');
		expect(filtered).toContain('raise RuntimeError("nested exec failed")');
		expect(filtered).not.toContain("_blender_axi_compile");
		expect(filtered).not.toMatch(/^[\s~^]+$/m);
		expect(filtered).toContain('File "/tmp/build.py", line 12, in <module>');
		expect(filtered).toContain('File "/tmp/build.py", line 4, in bevel_edges');
		expect(filtered).toContain("build_part(i)");
		expect(filtered).toContain("Traceback (most recent call last):");
		expect(filtered).toContain("RuntimeError: bevel failed");

		// Failure output is actually wired through the filter.
		const rendered = executionOutput(
			{
				ok: false,
				error: "bevel failed",
				traceback: raw,
				stdout_before_failure: "",
			},
			false,
			false,
		) as string;
		expect(rendered).toContain('File "<string>", line 1, in <module>');
		expect(rendered).not.toContain("_blender_axi_compile");
		expect(rendered).toContain("RuntimeError: bevel failed");

		const withoutSourceLine = raw.replace(
			'    exec(_blender_axi_compile(user, "/tmp/user_build.py"), globals(), globals())\n',
			"",
		);
		expect(filterTraceback(withoutSourceLine)).not.toContain(
			'File "<string>", line 56, in <module>',
		);
		expect(filterTraceback(withoutSourceLine)).toContain(
			'File "<string>", line 1, in <module>',
		);
	});

	it("defaults scene output to aggregates and opts into object rows", () => {
		const compact = sceneSource([], false);
		expect(compact).toContain("_blender_axi_scene_summary()");
		expect(compact).not.toContain('"items"');
		expect(compact).toContain("blender-axi scene --full");

		const expanded = sceneSource(["visible", "vertices"], false);
		expect(expanded).toContain('"visible": o.visible_get()');
		expect(expanded).toContain('"vertices": len(o.data.vertices)');
		expect(expanded).toContain("for o in C.scene.objects");

		const full = sceneSource([], true);
		expect(full).toContain('"name": o.name, "type": o.type');
	});

	it("identifies scene --fields rows by name and lets --full win over --fields", () => {
		// --fields alone: name is prepended so rows are always joinable.
		expect(sceneSource(["vertices"], false)).toContain(
			'{"name": o.name, "vertices": len(o.data.vertices)',
		);
		// An explicitly requested name is not duplicated, and order is preserved.
		expect(sceneSource(["name", "vertices"], false)).toContain(
			'{"name": o.name, "vertices": len(o.data.vertices)',
		);
		expect(sceneSource(["type", "name"], false)).toContain(
			'{"type": o.type, "name": o.name}',
		);
		// --full returns the complete full-detail schema, including with --fields.
		const combined = sceneSource(["vertices"], true);
		expect(combined).toContain('{"name": o.name, "type": o.type}');
		expect(combined).not.toContain("vertices");
		expect(combined).toBe(sceneSource([], true));
	});

	it("omits empty artifacts and reports non-empty ones as valid TOON", () => {
		const empty = executionOutput(
			{ ok: true, stdout: "", artifacts: [] },
			false,
			false,
		) as string;
		expect(empty).not.toContain("artifacts");
		expect(decode(empty)).toEqual({ ok: true, stdout: "|" });

		const filled = executionOutput(
			{ ok: true, stdout: "", artifacts: ["/tmp/a.blend", "/tmp/b.glb"] },
			false,
			false,
		) as string;
		expect(decode(filled)).toEqual({
			ok: true,
			stdout: "|",
			artifacts: ["/tmp/a.blend", "/tmp/b.glb"],
		});
		expect(
			JSON.parse(
				executionOutput(
					{ ok: true, stdout: "", artifacts: [] },
					true,
					false,
				) as string,
			),
		).toEqual({ ok: true, stdout: "" });

		expect(
			JSON.parse(
				executionOutput(
					{ ok: true, stdout: "", artifacts: ["/tmp/a.blend"] },
					true,
					false,
				) as string,
			),
		).toEqual({ ok: true, stdout: "", artifacts: ["/tmp/a.blend"] });
	});

	it("lists every registered command in valid TOON top-level help", async () => {
		const decoded = decode(TOP_HELP) as {
			commands: string[];
			flags: string[];
			examples: string[];
		};
		expect(decoded.commands).toEqual([
			"(none)=connection status",
			"ping",
			"exec",
			"run=alias of exec",
			"build",
			"render",
			"scene",
			"start",
			"stop",
			"setup",
		]);
		// Every documented command resolves to a real one.
		for (const entry of decoded.commands.slice(1)) {
			const name = entry.split("=")[0];
			expect(await run([name, "--help"]), name).not.toContain(
				"Unknown command",
			);
		}
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
		expect(rendered).toContain(
			"scene:\n  objects: 3\n  meshes: 1\n  triangles: 12",
		);
	});

	it("generates a static skill with installed binary command examples", () => {
		const skill = createSkillMarkdown();
		const packageRunnerForBlenderAxi =
			/\b(?:npx|bunx|bun[ \t]+x|npm[ \t]+exec|pnpm[ \t]+(?:dlx|exec)|yarn[ \t]+(?:dlx|exec))\b[^\r\n]*?[ \t='"](?:npm:)?blender-axi(?![A-Za-z0-9._-])/;

		expect(skill).toContain("user-invocable: false");
		expect(skill).toContain("metadata:\n  hermes:");
		expect(skill).toContain("usage: blender-axi");
		expect(skill).not.toMatch(packageRunnerForBlenderAxi);
		expect(skill).not.toContain("session: default");

		for (const command of [
			"npx blender-axi ping",
			"npx -y blender-axi ping",
			"npx --yes blender-axi ping",
			"npx -q blender-axi ping",
			"npx -p blender-axi blender-axi ping",
			"npx --package=blender-axi unrelated-cli",
			"npx -p npm:blender-axi unrelated-cli",
			"npx --package unrelated-cli npm:blender-axi ping",
			"bunx blender-axi ping",
			"bun x --silent blender-axi ping",
			"npm exec blender-axi -- ping",
			"npm exec --package=blender-axi -- unrelated-cli",
			"pnpm dlx blender-axi ping",
			"pnpm exec -- blender-axi ping",
			"yarn dlx blender-axi ping",
			"yarn exec --verbose blender-axi ping",
		]) {
			expect(command).toMatch(packageRunnerForBlenderAxi);
		}
		for (const command of [
			"blender-axi ping",
			"npx -y unrelated-cli",
			"npx --yes unrelated-cli blender-axi-helper",
			"bunx unrelated-cli",
			"bun x unrelated-cli",
			"npm exec unrelated-cli",
			"pnpm dlx unrelated-cli",
			"pnpm exec unrelated-cli",
			"yarn dlx unrelated-cli",
			"yarn exec unrelated-cli",
			"npx unrelated-cli\nblender-axi ping",
		]) {
			expect(command).not.toMatch(packageRunnerForBlenderAxi);
		}
	});
});
