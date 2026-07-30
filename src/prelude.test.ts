import { describe, expect, it } from "vitest";
import {
	generatePrelude,
	parseExecutionOutput,
	RESULT_MARKER,
} from "./prelude.js";

describe("prelude", () => {
	it("captures traceback and stdout against the stock addon", () => {
		const code = generatePrelude("print('before')\nraise ValueError('bad')", {
			filename: "/tmp/test.py",
		});
		expect(code).toContain("traceback.format_exc()");
		expect(code).toContain("stdout_before_failure");
		expect(code).toContain(
			"_blender_axi_compile(\"print('before')\\nraise ValueError('bad')\", \"/tmp/test.py\")",
		);
	});

	it("normalizes all four bpy quirks", () => {
		const code = generatePrelude("", { glb: "/tmp/a.glb" });
		expect(code).toContain("C.view_layer.objects.active");
		expect(code).toContain("_exportable.select_set(True)");
		expect(code).toContain("if _sc.world is None");
		expect(code).toContain("properties['engine'].enum_items");
	});

	it("restores context during and after an in-memory file reset", () => {
		const code = generatePrelude("bpy.ops.wm.read_homefile(use_empty=True)", {
			save: "/tmp/a.blend",
			glb: "/tmp/a.glb",
		});
		expect(code).toContain(
			"class _BlenderAxiResetTransformer(ast.NodeTransformer)",
		);
		expect(code).toContain(
			"node.func = ast.copy_location(ast.Name(id='_blender_axi_read_homefile_and_normalize'",
		);
		expect(code).toContain("exec(_blender_axi_compile(");
		expect(code).toContain("C.temp_override(window=_window)");
		expect(code).toContain(
			"_blender_axi_normalize_scene()\n        with redirect_stdout",
		);
		expect(
			code.indexOf(
				"_blender_axi_normalize_scene()\n        with redirect_stdout",
			),
		).toBeLessThan(code.indexOf("save_as_mainfile"));
	});

	it("creates a fallback camera when a reset scene has meshes but no camera", () => {
		const code = generatePrelude("", {
			renderAngles: ["front"],
			renderOutDir: "/tmp",
		});
		expect(code).toContain("if _cam is None:");
		expect(code).toContain('D.cameras.new("Camera")');
		expect(code).toContain("_sc.camera = _cam");
		expect(code).toContain("if not any(o.type == 'LIGHT'");
		expect(code).toContain("if not _mesh_objects:");
	});

	it("exports evaluated geometry without applying modifiers to the source", () => {
		const code = generatePrelude("", { glb: "/tmp/a.glb" });
		expect(code).toContain(
			"bpy.ops.export_scene.gltf(filepath=\"/tmp/a.glb\", export_format='GLB', export_apply=True)",
		);
		expect(code).not.toContain("object.modifier_apply");
		expect(code).not.toContain("modifiers.clear()");
		expect(code).not.toContain("modifiers.remove");
	});

	it("orders save before glb export and rendering", () => {
		const code = generatePrelude("", {
			save: "/tmp/a.blend",
			glb: "/tmp/a.glb",
			renderAngles: ["front"],
			renderOutDir: "/tmp",
		});
		expect(code.indexOf("save_as_mainfile")).toBeLessThan(
			code.indexOf("export_scene.gltf"),
		);
		expect(code.indexOf("save_as_mainfile")).toBeLessThan(
			code.indexOf("bpy.ops.render.render"),
		);
		expect(code).toContain("with redirect_stdout(io.StringIO())");
	});

	it("parses success and failure envelopes", () => {
		expect(
			parseExecutionOutput(
				`${RESULT_MARKER}{"ok":true,"stdout":"hi","artifacts":[],"scene":{"objects":3,"meshes":1,"triangles":12,"materials":2,"collections":1}}\n`,
			),
		).toEqual({
			ok: true,
			stdout: "hi",
			artifacts: [],
			scene: {
				objects: 3,
				meshes: 1,
				triangles: 12,
				materials: 2,
				collections: 1,
			},
		});
		expect(
			parseExecutionOutput(
				`${RESULT_MARKER}{"ok":false,"error":"bad","traceback":"Traceback","stdout_before_failure":"before"}\n`,
			),
		).toMatchObject({ ok: false, traceback: "Traceback" });
	});

	it("preserves definitive empty success output", () => {
		expect(
			parseExecutionOutput(
				`${RESULT_MARKER}{"ok":true,"stdout":"","artifacts":[]}\n`,
			),
		).toEqual({ ok: true, stdout: "", artifacts: [] });
	});
});
