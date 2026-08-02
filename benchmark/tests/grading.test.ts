import { describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTasks, verifyFixtures } from "../src/fixtures.js";
import { gradePreservation, gradeRun, gradeScene } from "../src/grading.js";
import type { SceneFacts, SceneObject } from "../src/grading.js";
import type { CheckDefinition } from "../src/types.js";

const benchmarkRoot = resolve("benchmark");
const blender = "/Applications/Blender.app/Contents/MacOS/Blender";

function object(name: string, values: Partial<SceneObject> = {}): SceneObject {
	return {
		name,
		type: "MESH",
		data_name: name,
		parent: null,
		location: [0, 0, 0],
		rotation_euler: [0, 0, 0],
		scale: [1, 1, 1],
		dimensions: [1, 1, 1],
		matrix_world: [],
		bounds_min: [-0.5, -0.5, 0],
		bounds_max: [0.5, 0.5, 1],
		triangles: 10,
		vertices: 8,
		collider_convex: null,
		forward_y_world: [0, 1, 0],
		materials: [],
		custom_properties: {},
		...values,
	};
}

function scene(objects: SceneObject[]): SceneFacts {
	return {
		unit_system: "METRIC",
		unit_scale: 1,
		objects,
		materials: [],
		totals: {
			objects: objects.length,
			meshes: objects.filter((item) => item.type === "MESH").length,
			triangles: objects.reduce((sum, item) => sum + item.triangles, 0),
			materials: 0,
		},
		mesh_bounds_min: [-0.6, -0.4, 0],
		mesh_bounds_max: [0.6, 0.4, 0.7],
		world: { color: [0, 0, 0] },
		render: { engine: "BLENDER_EEVEE_NEXT" },
		renders_inside_frame: true,
	};
}

describe("manifest scene contracts", () => {
	it("enforces bounds, pivot, convex collider, LOD reduction, and preservation state", () => {
		const crate = scene([
			object("CrateRoot", { type: "EMPTY", location: [0, 0, 0] }),
			object("COLLIDER_Crate", {
				parent: "CrateRoot",
				collider_convex: true,
			}),
		]);
		const check: CheckDefinition = {
			id: "crate-structure",
			kind: "scene",
			required: true,
			points: 1,
			params: {
				root: "CrateRoot",
				bounds: [1.2, 0.8, 0.7],
				bounds_tolerance: 0.02,
				bottom_center_pivot: true,
				required_object: "COLLIDER_Crate",
				collider_convex: true,
				max_material_slots: 3,
				unit_scale: true,
			},
		};
		expect(gradeScene(check, crate, null).passed).toBe(true);
		crate.objects[1]!.collider_convex = false;
		expect(gradeScene(check, crate, null).passed).toBe(false);

		const before = scene([object("Base")]);
		const after = scene([object("Base")]);
		after.world = { color: [1, 1, 1] };
		expect(
			gradePreservation(
				{
					id: "unrelated-preserved",
					kind: "preservation",
					required: true,
					points: 1,
					params: { preserve_all_others: true, allow_changes: [] },
				},
				after,
				before,
				true,
			).passed,
		).toBe(false);
	});
});

describe.runIf(process.platform === "darwin")(
	"deterministic grader calibration",
	() => {
		it("rejects a known-bad unchanged P1 artifact and preserves source", async () => {
			const root = await mkdtemp(join(tmpdir(), "blend-grade-bad-"));
			await mkdir(join(root, "fixture"));
			await mkdir(join(root, "output"));
			await mkdir(join(root, "oracles"));
			await mkdir(join(root, "transcript"));
			const verification = await verifyFixtures(benchmarkRoot);
			const entry = verification.index.entries.find(
				(item) => item.task_id === "P1",
			)!;
			await cp(
				join(benchmarkRoot, "fixtures", entry.artifact_path),
				join(root, "fixture", "micro.blend"),
			);
			await cp(
				join(root, "fixture", "micro.blend"),
				join(root, "output", "micro-result.blend"),
			);
			await writeFile(join(root, "transcript", "interface.jsonl"), "");
			const task = (await loadTasks(benchmarkRoot)).find(
				(item) => item.id === "P1",
			)!;
			const grade = await gradeRun({
				benchmarkRoot,
				runRoot: root,
				runId: "bad",
				task,
				arm: "axi",
				blenderExecutable: blender,
				fixtureHashBefore: entry.artifact_sha256,
			});
			expect(grade.status).toBe("wrong_artifact");
			expect(grade.hard_failure_ids).toContain("crate-structure");
			expect(grade.hard_failure_ids).not.toContain("camera-light-preserved");
		}, 30_000);
	},
);
