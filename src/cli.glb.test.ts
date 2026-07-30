import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendRequest } from "./protocol.js";
import { RESULT_MARKER } from "./prelude.js";
import { main } from "./cli.js";

vi.mock("./protocol.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./protocol.js")>()),
	sendRequest: vi.fn(),
}));

const PORT = "9876";
let savedPort: string | undefined;

beforeEach(() => {
	savedPort = process.env.BLENDER_AXI_PORT;
	process.env.BLENDER_AXI_PORT = PORT;
});

afterEach(() => {
	vi.resetAllMocks();
	process.exitCode = undefined;
	if (savedPort === undefined) delete process.env.BLENDER_AXI_PORT;
	else process.env.BLENDER_AXI_PORT = savedPort;
});

/**
 * Answers `get_scene_info` then `execute_code`, so the command reaches the real
 * prelude generator and the captured payload is what Blender would run.
 */
function stubListener(artifacts: string[] = []): () => string {
	let code = "";
	vi.mocked(sendRequest).mockImplementation(async (_port, request) => {
		if (request.type === "get_scene_info")
			return { status: "success", result: { object_count: 1 } };
		code = String(request.params.code);
		return {
			status: "success",
			result: {
				result: `${RESULT_MARKER}${JSON.stringify({
					ok: true,
					stdout: "",
					artifacts,
				})}\n`,
			},
		};
	});
	return () => code;
}

async function run(argv: string[]): Promise<string> {
	let output = "";
	await main({ argv, stdout: { write: (chunk) => void (output += chunk) } });
	return output;
}

function buildScript(): string {
	const file = join(
		mkdtempSync(join(tmpdir(), "blender-axi-glb-")),
		"build.py",
	);
	writeFileSync(file, "print('built')\n");
	return file;
}

describe("glb export preserves evaluated geometry", () => {
	it("exports the evaluated mesh for `build --glb`", async () => {
		const code = stubListener(["/tmp/model.glb"]);

		const output = await run([
			"build",
			buildScript(),
			"--glb",
			"/tmp/model.glb",
		]);

		expect(code()).toContain(
			"bpy.ops.export_scene.gltf(filepath=\"/tmp/model.glb\", export_format='GLB', export_apply=True)",
		);
		expect(output).toContain("/tmp/model.glb");
		expect(process.exitCode).toBeUndefined();
	});

	it("never applies or removes modifiers in the editable source", async () => {
		const code = stubListener();

		await run([
			"build",
			buildScript(),
			"--save",
			"/tmp/model.blend",
			"--glb",
			"/tmp/model.glb",
			"--render",
			"front,side",
		]);

		expect(code()).not.toContain("modifier_apply");
		expect(code()).not.toContain("modifiers.clear()");
		expect(code()).not.toContain("modifiers.remove");
		expect(code()).not.toContain("convert(target='MESH')");
	});

	it("keeps every accepted build flag combination on the exporting path", async () => {
		for (const argv of [
			["--glb", "/tmp/model.glb"],
			["--glb", "/tmp/model.glb", "--json"],
			["--save", "/tmp/model.blend", "--glb", "/tmp/model.glb"],
			[
				"--save",
				"/tmp/model.blend",
				"--glb",
				"/tmp/model.glb",
				"--render",
				"front,side,back,tq",
				"--full",
			],
		]) {
			const code = stubListener();
			await run(["build", buildScript(), ...argv]);
			expect(code(), argv.join(" ")).toContain("export_apply=True");
			expect(process.exitCode, argv.join(" ")).toBeUndefined();
			vi.resetAllMocks();
		}
	});

	it("leaves non-exporting commands free of export code", async () => {
		for (const argv of [
			["build", buildScript(), "--save", "/tmp/model.blend"],
			["exec", buildScript()],
			["run", buildScript()],
			["render", "front"],
		]) {
			const code = stubListener();
			await run(argv);
			expect(code(), argv.join(" ")).not.toContain("export_scene.gltf");
			vi.resetAllMocks();
		}
	});
});
