import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { validateBytes } from "gltf-validator";
import type { CheckDefinition, OracleResult, OutcomeStatus, TaskManifest } from "./types.js";
import { checkTranscriptPolicy } from "./policy.js";
import { fileMetadata, readJson, sha256File, writeJsonAtomic } from "./util.js";

interface SceneObject {
  name: string;
  type: string;
  parent: string | null;
  location: number[];
  scale: number[];
  dimensions: number[];
  matrix_world: number[][];
  bounds_min: number[] | null;
  bounds_max: number[] | null;
  triangles: number;
  materials: Array<string | null>;
  custom_properties: Record<string, unknown>;
}
interface SceneFacts {
  objects: SceneObject[];
  materials: Array<{ name: string; base_color_srgb: number[]; emission_color_srgb: number[] | null; emission_strength: number | null }>;
  totals: { objects: number; meshes: number; triangles: number; materials: number };
  mesh_bounds_min: number[] | null;
  mesh_bounds_max: number[] | null;
}

export interface GradeResult {
  schema_version: "1.0.0";
  task_id: string;
  run_id: string;
  status: OutcomeStatus;
  functional_success: boolean;
  critical_failure: boolean;
  deterministic_structure_0_100: number;
  unity_readiness_0_100: number | null;
  hard_failure_ids: string[];
  oracle_results: OracleResult[];
}

function near(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function vectorNear(actual: number[], expected: number[], tolerance: number): boolean {
  return expected.every((value, index) => near(actual[index] ?? Number.NaN, value, tolerance));
}

function srgbHex(hex: string): number[] {
  const text = hex.replace(/^#/u, "");
  return [0, 2, 4].map((index) => Number.parseInt(text.slice(index, index + 2), 16) / 255);
}

function objectByName(scene: SceneFacts, name: string): SceneObject | undefined {
  return scene.objects.find((object) => object.name === name);
}

function fail(check: CheckDefinition, reason: string, evidencePath: string | null = null): OracleResult {
  return { id: check.id, kind: check.kind, required: check.required, passed: false, points_awarded: 0, points_possible: check.points, reason, evidence_path: evidencePath };
}

function pass(check: CheckDefinition, reason: string, evidencePath: string | null = null): OracleResult {
  return { id: check.id, kind: check.kind, required: check.required, passed: true, points_awarded: check.points, points_possible: check.points, reason, evidence_path: evidencePath };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code, stderr }));
  });
}

async function inspectBlend(blender: string, benchmarkRoot: string, blendPath: string, outputPath: string): Promise<SceneFacts | null> {
  if (!(await exists(blendPath))) return null;
  const result = await run(blender, ["--background", "--factory-startup", blendPath, "--python", join(benchmarkRoot, "fixtures", "inspect_scene.py"), "--", "--output", outputPath, "--allowed-root", join(outputPath, "..")]);
  if (result.code !== 0) return null;
  return await readJson<SceneFacts>(outputPath);
}

function gradeScene(check: CheckDefinition, scene: SceneFacts | null, start: SceneFacts | null): OracleResult {
  if (!scene) return fail(check, "Result scene is unavailable or cannot reopen");
  const params = check.params ?? {};
  if (check.id === "crate-structure") {
    const object = objectByName(scene, String(params.object));
    if (!object) return fail(check, `Missing ${String(params.object)}`);
    const tolerance = Number(params.dimension_tolerance);
    const material = scene.materials.find((item) => item.name === params.material);
    const expectedColor = srgbHex(String(params.base_color_srgb_hex));
    const reasons = [
      scene.objects.filter((item) => item.name === params.object).length === Number(params.count),
      vectorNear(object.dimensions, params.dimensions as number[], tolerance),
      object.bounds_min !== null && near(object.bounds_min[2]!, Number(params.min_z), Number(params.min_z_tolerance)),
      vectorNear(object.scale, params.scale as number[], 0.0001),
      object.materials.length === 1 && object.materials[0] === params.material,
      material !== undefined && vectorNear(material.base_color_srgb, expectedColor, Number(params.color_tolerance)),
    ];
    return reasons.every(Boolean) ? pass(check, "Crate dimensions, grounding, scale, and material pass") : fail(check, "Crate scene facts differ from contract");
  }
  if (check.id === "mast-height") {
    const before = start && objectByName(start, String(params.object));
    const after = objectByName(scene, String(params.object));
    if (!before || !after || !before.bounds_min || !after.bounds_min) return fail(check, "Mast facts unavailable");
    const tolerance = Number(params.tolerance);
    return near(after.dimensions[2]!, before.dimensions[2]! * Number(params.height_ratio), tolerance) && near(after.bounds_min[2]!, before.bounds_min[2]!, tolerance)
      ? pass(check, "Mast is 30% taller with fixed bottom")
      : fail(check, "Mast height or bottom changed incorrectly");
  }
  if (check.id === "lamp-emission") {
    const lamp = objectByName(scene, String(params.object));
    const material = lamp?.materials[0] ? scene.materials.find((item) => item.name === lamp.materials[0]) : undefined;
    const expected = srgbHex(String(params.emission_srgb_hex));
    return material?.emission_color_srgb && vectorNear(material.emission_color_srgb, expected, Number(params.tolerance)) && near(material.emission_strength ?? Number.NaN, Number(params.strength), Number(params.tolerance))
      ? pass(check, "Lamp emission color and strength pass")
      : fail(check, "Lamp emission differs from contract");
  }
  if (check.id === "recovery-scene") {
    const required = objectByName(scene, String(params.required_object));
    const forbiddenObjects = (params.forbidden_objects as string[]).some((name) => objectByName(scene, name));
    return required && !forbiddenObjects ? pass(check, "RecoveredPart exists without partial object") : fail(check, "Recovery result has missing or half-built objects");
  }
  if (["crate-structure", "mast-height", "lamp-emission", "recovery-scene"].includes(check.id)) return fail(check, "Unhandled scene oracle");

  const rootName = String(params.root ?? "");
  const root = rootName ? objectByName(scene, rootName) : undefined;
  if (rootName && !root) return fail(check, `Missing root ${rootName}`);
  if (Array.isArray(params.required_objects) && !(params.required_objects as string[]).every((name) => objectByName(scene, name))) return fail(check, "Required named objects are missing");
  if (Array.isArray(params.required_name_patterns)) {
    for (const pattern of params.required_name_patterns as string[]) if (!scene.objects.some((item) => item.name.includes(pattern))) return fail(check, `Missing semantic part ${pattern}`);
  }
  if (params.required_name_pattern && !scene.objects.some((item) => item.name.startsWith(String(params.required_name_pattern)))) return fail(check, `Missing ${String(params.required_name_pattern)} object`);
  if (params.max_triangles && scene.totals.triangles > Number(params.max_triangles)) return fail(check, "Triangle budget exceeded");
  if (params.min_triangles && scene.totals.triangles < Number(params.min_triangles)) return fail(check, "Triangle count below minimum");
  if (params.max_materials && scene.totals.materials > Number(params.max_materials)) return fail(check, "Material budget exceeded");
  if (params.no_armature && scene.objects.some((item) => item.type === "ARMATURE")) return fail(check, "Unexpected armature");
  if (params.no_negative_scale && scene.objects.some((item) => item.scale.some((value) => value < 0))) return fail(check, "Negative scale found");
  if (params.unit_scale && scene.objects.filter((item) => item.type === "MESH").some((item) => !vectorNear(item.scale, [1, 1, 1], 0.0001))) return fail(check, "Unapplied scale found");
  return pass(check, "Scene structural contract passes");
}

function gradePreservation(check: CheckDefinition, scene: SceneFacts | null, start: SceneFacts | null, fixtureUnchanged: boolean): OracleResult {
  if (!fixtureUnchanged) return fail(check, "Immutable source fixture hash changed");
  if (!scene || !start) return fail(check, "Scene preservation evidence unavailable");
  const params = check.params ?? {};
  if (params.preserve_all_others) {
    const allowed = new Set(params.allow_changes as string[]);
    const serialize = (object: SceneObject) => JSON.stringify(object);
    for (const before of start.objects) {
      if (allowed.has(before.name)) continue;
      const after = objectByName(scene, before.name);
      if (!after || serialize(before) !== serialize(after)) return fail(check, `Unexpected change to ${before.name}`);
    }
    return pass(check, "All unrelated scene objects are unchanged");
  }
  for (const name of (params.objects as string[] | undefined) ?? []) {
    const before = objectByName(start, name);
    const after = objectByName(scene, name);
    if (!before || !after) return fail(check, `Preserved object ${name} missing`);
    for (const field of (params.fields as string[] | undefined) ?? []) {
      if (JSON.stringify(before[field as keyof SceneObject]) !== JSON.stringify(after[field as keyof SceneObject])) return fail(check, `${name}.${field} changed`);
    }
    if (params.custom_properties && JSON.stringify(after.custom_properties) !== JSON.stringify(params.custom_properties)) return fail(check, `${name} custom properties changed`);
  }
  return pass(check, "Fixture and required dirty state are preserved");
}

async function gradeGltf(check: CheckDefinition, path: string): Promise<OracleResult> {
  if (!(await exists(path))) return fail(check, `Missing GLB ${path}`);
  try {
    const report = await validateBytes(new Uint8Array(await readFile(path)), { maxIssues: 100 });
    const errors = report.issues.numErrors;
    return errors <= Number(check.params?.max_errors ?? 0) ? pass(check, `glTF validator reported ${errors} errors`) : fail(check, `glTF validator reported ${errors} errors`);
  } catch (error) {
    return fail(check, `glTF validation failed: ${(error as Error).message}`);
  }
}

async function gradeRoundTrip(check: CheckDefinition, blender: string, benchmarkRoot: string, artifactPath: string, evidencePath: string): Promise<OracleResult> {
  if (!(await exists(artifactPath))) return fail(check, `Missing round-trip artifact ${artifactPath}`);
  const result = await run(blender, ["--background", "--factory-startup", "--python", join(benchmarkRoot, "fixtures", "roundtrip_import.py"), "--", "--input", artifactPath, "--output", evidencePath, "--allowed-root", join(evidencePath, "..", "..")]);
  if (result.code !== 0 || !(await exists(evidencePath))) return fail(check, `Pinned Blender round-trip process failed: ${result.stderr.slice(-500)}`, evidencePath);
  const evidence = await readJson<{ ok: boolean; objects: string[]; meshes: number; error: string | null }>(evidencePath);
  if (!evidence.ok || evidence.meshes < 1) return fail(check, evidence.error ?? "Round-trip imported no mesh", evidencePath);
  const required = (check.params?.required_objects as string[] | undefined) ?? [];
  if (required.length && !required.every((name) => evidence.objects.some((object) => object === name || object.startsWith(name)))) return fail(check, "Round-trip misses required named objects", evidencePath);
  return pass(check, `Pinned Blender round-trip imported ${evidence.meshes} mesh objects`, evidencePath);
}

async function gradeFirstFailure(check: CheckDefinition, interfacePath: string): Promise<OracleResult> {
  if (!(await exists(interfacePath))) return fail(check, "Missing interface transcript");
  const text = await readFile(interfacePath, "utf8");
  const params = check.params ?? {};
  const progress = [...text.matchAll(/progress \d{2}\/80/gu)].length;
  const hasFunction = text.includes(String(params.function));
  const expectedLine = Number(params.line);
  const hasLine = text
    .split(/\r?\n/u)
    .some((line) => line.includes(`line ${expectedLine},`) || line.includes(`line ${expectedLine} `) || line.endsWith(`line ${expectedLine}`));
  return progress >= Number(params.progress_line_count) && hasFunction && hasLine
    ? pass(check, "First failure includes progress, exact function, and source line", interfacePath)
    : fail(check, "First failure evidence is incomplete", interfacePath);
}

export async function gradeRun(options: {
  benchmarkRoot: string;
  runRoot: string;
  runId: string;
  task: TaskManifest;
  arm: "axi" | "mcp";
  blenderExecutable?: string;
  fixtureHashBefore: string;
}): Promise<GradeResult> {
  const { benchmarkRoot, runRoot, runId, task, arm } = options;
  const blender = options.blenderExecutable ?? process.env.BLENDER_EXECUTABLE ?? "/Applications/Blender.app/Contents/MacOS/Blender";
  const fixtureArtifact = task.fixture.source_artifact ? join(runRoot, "fixture", task.fixture.source_artifact) : "";
  const fixtureHashAfter = fixtureArtifact && (await exists(fixtureArtifact)) ? await sha256File(fixtureArtifact) : "missing";
  const resultBlend = task.required_artifacts.find((artifact) => artifact.kind === "blend");
  const resultBlendPath = resultBlend ? join(runRoot, resultBlend.path) : "";
  const startPath = join(runRoot, "oracles", "start-scene.json");
  const resultPath = join(runRoot, "oracles", "result-scene.json");
  const start = fixtureArtifact ? await inspectBlend(blender, benchmarkRoot, fixtureArtifact, startPath) : null;
  const result = resultBlendPath ? await inspectBlend(blender, benchmarkRoot, resultBlendPath, resultPath) : null;
  const interfacePath = join(runRoot, "transcript", "interface.jsonl");
  const violations = await checkTranscriptPolicy(arm, interfacePath);
  const oracleResults: OracleResult[] = [];

  if (violations.length) {
    oracleResults.push({ id: "policy", kind: "artifact", required: true, passed: false, points_awarded: 0, points_possible: 0, reason: violations.map((item) => item.detail).join("; "), evidence_path: interfacePath });
  }

  for (const check of task.deterministic_oracles) {
    if (check.kind === "artifact") {
      const paths = check.params?.path ? [String(check.params.path)] : task.required_artifacts.filter((artifact) => artifact.kind !== "oracle_json").map((artifact) => artifact.path);
      const missing: string[] = [];
      for (const path of paths) if (!(await exists(join(runRoot, path)))) missing.push(path);
      oracleResults.push(missing.length ? fail(check, `Missing artifacts: ${missing.join(", ")}`) : pass(check, "Required artifacts exist"));
    } else if (check.kind === "reopen") {
      oracleResults.push(result ? pass(check, "Blend file reopens in a fresh factory-startup process", resultPath) : fail(check, "Blend file does not reopen", resultPath));
    } else if (check.kind === "scene") {
      oracleResults.push(gradeScene(check, result, start));
    } else if (check.kind === "preservation") {
      oracleResults.push(gradePreservation(check, result, start, fixtureHashAfter === options.fixtureHashBefore));
    } else if (check.kind === "gltf") {
      const glb = task.required_artifacts.find((artifact) => artifact.kind === "glb");
      oracleResults.push(glb ? await gradeGltf(check, join(runRoot, glb.path)) : fail(check, "Manifest has no GLB artifact"));
    } else if (check.kind === "first_failure") {
      oracleResults.push(await gradeFirstFailure(check, interfacePath));
    } else if (check.kind === "fbx_roundtrip") {
      const extension = String(check.params?.format ?? "fbx");
      const artifact = task.required_artifacts.find((item) => item.kind === extension || (extension === "glb" && item.kind === "glb"));
      const evidencePath = join(runRoot, "oracles", `${extension}-roundtrip.json`);
      oracleResults.push(artifact ? await gradeRoundTrip(check, blender, benchmarkRoot, join(runRoot, artifact.path), evidencePath) : fail(check, `Manifest has no ${extension.toUpperCase()} artifact`));
    } else if (check.kind === "unity") {
      const unityEvidence = join(runRoot, "oracles", "unity.json");
      if (!(await exists(unityEvidence))) oracleResults.push({ ...fail(check, "Unity editor unavailable or Unity grading not executed"), passed: null });
      else {
        const unity = await readJson<{ passed: boolean; score: number; reason: string }>(unityEvidence);
        oracleResults.push(unity.passed ? pass(check, unity.reason, unityEvidence) : fail(check, unity.reason, unityEvidence));
      }
    }
  }

  const hardFailures = oracleResults.filter((result) => result.required && result.passed === false).map((result) => result.id);
  const availablePoints = oracleResults.filter((result) => result.kind !== "unity").reduce((sum, result) => sum + result.points_possible, 0);
  const awardedPoints = oracleResults.filter((result) => result.kind !== "unity").reduce((sum, result) => sum + result.points_awarded, 0);
  const unityResult = oracleResults.find((result) => result.kind === "unity");
  const policyViolation = violations.length > 0;
  const dataLoss = fixtureHashAfter !== options.fixtureHashBefore;
  let status: OutcomeStatus = hardFailures.length === 0 ? "solved" : "wrong_artifact";
  if (policyViolation) status = "policy_violation";
  else if (dataLoss) status = "damaging_failure";
  else if (task.id === "P6" && unityResult?.passed === null && hardFailures.every((id) => id === "unity-readiness")) status = "deferred";
  const grade: GradeResult = {
    schema_version: "1.0.0",
    task_id: task.id,
    run_id: runId,
    status,
    functional_success: status === "solved",
    critical_failure: status === "damaging_failure" || status === "policy_violation",
    deterministic_structure_0_100: availablePoints ? (100 * awardedPoints) / availablePoints : 0,
    unity_readiness_0_100: unityResult?.passed === null ? null : unityResult ? (100 * unityResult.points_awarded) / unityResult.points_possible : null,
    hard_failure_ids: hardFailures,
    oracle_results: oracleResults,
  };
  await writeJsonAtomic(join(runRoot, "oracles", "grade.json"), grade);
  return grade;
}

export async function artifactInventory(runRoot: string, task: TaskManifest): Promise<Array<{ kind: string; path: string; sha256: string; bytes: number; valid: boolean | null }>> {
  const output = [];
  for (const artifact of task.required_artifacts) {
    const path = join(runRoot, artifact.path);
    if (!(await exists(path))) continue;
    const metadata = await fileMetadata(path);
    output.push({ kind: artifact.kind, path: artifact.path, ...metadata, valid: null });
  }
  return output;
}
