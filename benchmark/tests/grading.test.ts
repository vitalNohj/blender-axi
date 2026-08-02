import { describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTasks, verifyFixtures } from "../src/fixtures.js";
import { gradeRun } from "../src/grading.js";

const benchmarkRoot = resolve("benchmark");
const blender = "/Applications/Blender.app/Contents/MacOS/Blender";

describe.runIf(process.platform === "darwin")("deterministic grader calibration", () => {
  it("rejects a known-bad unchanged P1 artifact and preserves source", async () => {
    const root = await mkdtemp(join(tmpdir(), "blend-grade-bad-"));
    await mkdir(join(root, "fixture"));
    await mkdir(join(root, "output"));
    await mkdir(join(root, "oracles"));
    await mkdir(join(root, "transcript"));
    const verification = await verifyFixtures(benchmarkRoot);
    const entry = verification.index.entries.find((item) => item.task_id === "P1")!;
    await cp(join(benchmarkRoot, "fixtures", entry.artifact_path), join(root, "fixture", "micro.blend"));
    await cp(join(root, "fixture", "micro.blend"), join(root, "output", "micro-result.blend"));
    await writeFile(join(root, "transcript", "interface.jsonl"), "");
    const task = (await loadTasks(benchmarkRoot)).find((item) => item.id === "P1")!;
    const grade = await gradeRun({ benchmarkRoot, runRoot: root, runId: "bad", task, arm: "axi", blenderExecutable: blender, fixtureHashBefore: entry.artifact_sha256 });
    expect(grade.status).toBe("wrong_artifact");
    expect(grade.hard_failure_ids).toContain("crate-structure");
    expect(grade.hard_failure_ids).not.toContain("camera-light-preserved");
  }, 30_000);
});
