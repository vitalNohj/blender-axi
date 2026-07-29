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
			"compile(\"print('before')\\nraise ValueError('bad')\", \"/tmp/test.py\", 'exec')",
		);
	});

	it("normalizes all four bpy quirks", () => {
		const code = generatePrelude("", { glb: "/tmp/a.glb" });
		expect(code).toContain("C.view_layer.objects.active");
		expect(code).toContain("_exportable.select_set(True)");
		expect(code).toContain("if _sc.world is None");
		expect(code).toContain("properties['engine'].enum_items");
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
				`${RESULT_MARKER}{"ok":true,"stdout":"hi","artifacts":[]}\n`,
			),
		).toEqual({ ok: true, stdout: "hi", artifacts: [] });
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
