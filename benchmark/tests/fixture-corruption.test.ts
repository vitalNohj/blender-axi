import { describe, expect, it } from "vitest";
import { cp, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyFixtures } from "../src/fixtures.js";

const benchmarkRoot = resolve("benchmark");

// This test used to corrupt the committed fixture in place and restore it in
// afterEach. Any test file running concurrently in another worker observed the
// corrupted bytes and failed with "P1 artifact hash mismatch". Corrupting a
// private copy keeps the assertion identical while removing the shared-state race.
async function isolatedBenchmarkRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "blend-bench-fixtures-"));
	const copy = join(root, "benchmark");
	await cp(benchmarkRoot, copy, { recursive: true });
	return copy;
}

describe("fixture corruption", () => {
	it("detects a changed immutable fixture byte", async () => {
		const root = await isolatedBenchmarkRoot();
		const valid = await verifyFixtures(root);
		expect(valid.ok).toBe(true);
		const entry = valid.index.entries.find((item) => item.task_id === "P1")!;
		const path = join(root, "fixtures", entry.artifact_path);
		const original = await readFile(path);
		await chmod(path, 0o644);
		await writeFile(path, Buffer.concat([original, Buffer.from([0])]));
		const corrupt = await verifyFixtures(root);
		expect(corrupt.ok).toBe(false);
		expect(corrupt.errors).toContain("P1 artifact hash mismatch");
	});

	it("leaves the shared committed fixture untouched for concurrent readers", async () => {
		const root = await isolatedBenchmarkRoot();
		const entry = (await verifyFixtures(root)).index.entries.find(
			(item) => item.task_id === "P1",
		)!;
		const copyPath = join(root, "fixtures", entry.artifact_path);
		await chmod(copyPath, 0o644);
		await writeFile(copyPath, Buffer.from([0]));
		// The shared root a parallel worker would read stays verifiable throughout.
		await expect(verifyFixtures(benchmarkRoot)).resolves.toMatchObject({
			ok: true,
			errors: [],
		});
	});
});
