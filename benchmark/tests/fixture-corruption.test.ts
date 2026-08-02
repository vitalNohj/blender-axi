import { afterEach, describe, expect, it } from "vitest";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyFixtures } from "../src/fixtures.js";

const benchmarkRoot = resolve("benchmark");

describe("fixture corruption", () => {
	let restorePath: string | null = null;
	let original: Uint8Array | null = null;
	afterEach(async () => {
		if (restorePath && original) {
			await chmod(restorePath, 0o644);
			await writeFile(restorePath, original);
			await chmod(restorePath, 0o444);
		}
		restorePath = null;
		original = null;
	});

	it("detects a changed immutable fixture byte", async () => {
		const valid = await verifyFixtures(benchmarkRoot);
		const entry = valid.index.entries.find((item) => item.task_id === "P1")!;
		restorePath = join(benchmarkRoot, "fixtures", entry.artifact_path);
		original = await readFile(restorePath);
		await chmod(restorePath, 0o644);
		await writeFile(restorePath, Buffer.concat([original, Buffer.from([0])]));
		const corrupt = await verifyFixtures(benchmarkRoot);
		expect(corrupt.ok).toBe(false);
		expect(corrupt.errors).toContain("P1 artifact hash mismatch");
	});
});
