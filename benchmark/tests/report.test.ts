import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVisualScores } from "../src/report.js";

describe("visual score ledger", () => {
	it("keeps the attempt ledger immutable and appends a score sidecar", async () => {
		const root = await mkdtemp(join(tmpdir(), "blend-bench-report-"));
		const results = join(root, "results.jsonl");
		const original = `${JSON.stringify({ run_id: "run-1" })}\n`;
		await writeFile(results, original);
		await applyVisualScores(
			results,
			{ "run-1": { mean: 87, rater_count: 3 } },
			0.91,
		);
		expect(await readFile(results, "utf8")).toBe(original);
		expect(
			JSON.parse(await readFile(join(root, "visual-scores.jsonl"), "utf8")),
		).toMatchObject({ run_id: "run-1", mean: 87, scorer_agreement: 0.91 });
	});
});
