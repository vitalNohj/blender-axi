import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import type { AttemptRecord } from "./types.js";
import {
	mulberry32,
	readJson,
	readJsonl,
	sha256,
	shuffle,
	writeJsonAtomic,
} from "./util.js";

export interface BlindItem {
	opaque_id: string;
	source_run_id: string;
	source_path: string;
	bundle_path: string;
	duplicate_of: string | null;
}
export interface VisualScore {
	rater_id: string;
	opaque_id: string;
	calibration_complete: boolean;
	brief_adherence: number;
	silhouette_role_readability: number;
	form_proportion: number;
	material_value_readability: number;
	finish_defect_control: number;
	composition_framing: number;
	distinctiveness: number;
	comments: string;
}

async function runStandardizedRender(
	blender: string,
	benchmarkRoot: string,
	blendPath: string,
	outputRoot: string,
	prefix: string,
): Promise<string[]> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(
			blender,
			[
				"--background",
				"--factory-startup",
				blendPath,
				"--python",
				join(benchmarkRoot, "fixtures", "standardized_render.py"),
				"--",
				"--output-dir",
				outputRoot,
				"--prefix",
				prefix,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0
				? resolvePromise()
				: reject(
						new Error(`Standardized render failed: ${stderr.slice(-1000)}`),
					),
		);
	});
	return ["front", "side", "three-quarter"].map(
		(view) => `${prefix}-${view}.png`,
	);
}

function opaqueId(seed: number, index: number): string {
	return sha256(`blind:${seed}:${index}`).slice(0, 12).toUpperCase();
}

export async function createBlindBundles(options: {
	runsRoot: string;
	outputRoot: string;
	seed: number;
	duplicateFraction: number;
	minimumRaters: number;
	benchmarkRoot?: string;
	blenderExecutable?: string;
}): Promise<{ items: BlindItem[]; forms: string[] }> {
	const records = (
		await readJsonl<AttemptRecord>(join(options.runsRoot, "results.jsonl"))
	).filter((record) => record.validity.status === "valid");
	const standardizedRoot = join(options.outputRoot, "standardized-source");
	await mkdir(standardizedRoot, { recursive: true });
	const candidates: Array<{ runId: string; path: string }> = [];
	for (const record of records) {
		const blend = record.artifacts.find(
			(artifact) => artifact.kind === "blend",
		);
		if (blend && options.benchmarkRoot && options.blenderExecutable) {
			const names = await runStandardizedRender(
				options.blenderExecutable,
				options.benchmarkRoot,
				join(options.runsRoot, record.run_id, blend.path),
				standardizedRoot,
				record.run_id,
			);
			for (const name of names)
				candidates.push({
					runId: record.run_id,
					path: join("standardized-source", name),
				});
		} else {
			for (const artifact of record.artifacts)
				if (
					artifact.kind === "render" ||
					extname(artifact.path).toLowerCase() === ".png"
				)
					candidates.push({ runId: record.run_id, path: artifact.path });
		}
	}
	const random = mulberry32(options.seed);
	const shuffled = shuffle(candidates, random);
	const duplicateCount = Math.ceil(shuffled.length * options.duplicateFraction);
	const expanded = [
		...shuffled,
		...shuffle(shuffled, random)
			.slice(0, duplicateCount)
			.map((candidate) => ({ ...candidate })),
	];
	await mkdir(options.outputRoot, { recursive: true });
	const bundleRoot = join(options.outputRoot, "bundles");
	await mkdir(bundleRoot, { recursive: true });
	const items: BlindItem[] = [];
	for (let index = 0; index < expanded.length; index += 1) {
		const candidate = expanded[index]!;
		const id = opaqueId(options.seed, index);
		const duplicateOf =
			index < shuffled.length
				? null
				: (items.find(
						(item) =>
							item.source_run_id === candidate.runId &&
							item.source_path === candidate.path,
					)?.opaque_id ?? null);
		const extension = extname(candidate.path) || ".png";
		const bundlePath = `bundles/${id}${extension}`;
		const sourcePath = candidate.path.startsWith("standardized-source/")
			? join(options.outputRoot, candidate.path)
			: join(options.runsRoot, candidate.runId, candidate.path);
		await cp(sourcePath, join(options.outputRoot, bundlePath));
		items.push({
			opaque_id: id,
			source_run_id: candidate.runId,
			source_path: candidate.path,
			bundle_path: bundlePath,
			duplicate_of: duplicateOf,
		});
	}
	const privateMapping = {
		schema_version: "1.0.0",
		scoring_closed: false,
		items,
	};
	await writeJsonAtomic(
		join(options.outputRoot, "PRIVATE-blind-map.json"),
		privateMapping,
	);
	await writeJsonAtomic(join(options.outputRoot, "public-manifest.json"), {
		schema_version: "1.0.0",
		items: items.map(({ opaque_id, bundle_path }) => ({
			opaque_id,
			bundle_path,
		})),
	});
	const forms: string[] = [];
	const header =
		"rater_id,opaque_id,calibration_complete,brief_adherence,silhouette_role_readability,form_proportion,material_value_readability,finish_defect_control,composition_framing,distinctiveness,comments\n";
	for (let rater = 1; rater <= options.minimumRaters; rater += 1) {
		const path = join(options.outputRoot, `rater-${rater}.csv`);
		const rows = items
			.map((item) => `RATER_${rater},${item.opaque_id},false,,,,,,,,`)
			.join("\n");
		await writeFile(path, `${header}${rows}\n`);
		forms.push(path);
	}
	return { items, forms };
}

function parseCsvLine(line: string): string[] {
	const values: string[] = [];
	let current = "";
	let quoted = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index]!;
		if (character === '"' && line[index + 1] === '"') {
			current += '"';
			index += 1;
		} else if (character === '"') quoted = !quoted;
		else if (character === "," && !quoted) {
			values.push(current);
			current = "";
		} else current += character;
	}
	values.push(current);
	return values;
}

export async function readVisualScores(
	scoringRoot: string,
): Promise<VisualScore[]> {
	const files = (await readdir(scoringRoot)).filter((name) =>
		/^rater-\d+\.csv$/u.test(name),
	);
	const scores: VisualScore[] = [];
	for (const file of files) {
		const lines = (await readFile(join(scoringRoot, file), "utf8"))
			.split(/\r?\n/u)
			.filter(Boolean);
		for (const line of lines.slice(1)) {
			const columns = parseCsvLine(line);
			const score: VisualScore = {
				rater_id: columns[0] ?? "",
				opaque_id: columns[1] ?? "",
				calibration_complete: columns[2] === "true",
				brief_adherence: Number(columns[3]),
				silhouette_role_readability: Number(columns[4]),
				form_proportion: Number(columns[5]),
				material_value_readability: Number(columns[6]),
				finish_defect_control: Number(columns[7]),
				composition_framing: Number(columns[8]),
				distinctiveness: Number(columns[9]),
				comments: columns[10] ?? "",
			};
			if (!score.calibration_complete)
				throw new Error(
					`${file}: calibration_complete must be true before scoring closes`,
				);
			const maximums = [20, 20, 15, 15, 15, 10, 5];
			const values = [
				score.brief_adherence,
				score.silhouette_role_readability,
				score.form_proportion,
				score.material_value_readability,
				score.finish_defect_control,
				score.composition_framing,
				score.distinctiveness,
			];
			if (
				values.some(
					(value, index) =>
						!Number.isFinite(value) || value < 0 || value > maximums[index]!,
				)
			)
				throw new Error(
					`${file}: score outside rubric range for ${score.opaque_id}`,
				);
			scores.push(score);
		}
	}
	return scores;
}

export function aggregateVisualScores(
	scores: VisualScore[],
	minimumRaters: number,
): Record<string, { mean: number; rater_count: number }> {
	const groups = new Map<string, VisualScore[]>();
	for (const score of scores)
		groups.set(score.opaque_id, [
			...(groups.get(score.opaque_id) ?? []),
			score,
		]);
	const output: Record<string, { mean: number; rater_count: number }> = {};
	for (const [id, values] of groups) {
		const distinctRaters = new Set(values.map((value) => value.rater_id)).size;
		if (distinctRaters < minimumRaters)
			throw new Error(
				`${id} has ${distinctRaters} raters, requires ${minimumRaters}`,
			);
		const totals = values.map(
			(value) =>
				value.brief_adherence +
				value.silhouette_role_readability +
				value.form_proportion +
				value.material_value_readability +
				value.finish_defect_control +
				value.composition_framing +
				value.distinctiveness,
		);
		output[id] = {
			mean: totals.reduce((sum, value) => sum + value, 0) / totals.length,
			rater_count: distinctRaters,
		};
	}
	return output;
}

function scoreAgreement(left: VisualScore, right: VisualScore): number {
	const maximums = [20, 20, 15, 15, 15, 10, 5];
	const leftValues = [
		left.brief_adherence,
		left.silhouette_role_readability,
		left.form_proportion,
		left.material_value_readability,
		left.finish_defect_control,
		left.composition_framing,
		left.distinctiveness,
	];
	const rightValues = [
		right.brief_adherence,
		right.silhouette_role_readability,
		right.form_proportion,
		right.material_value_readability,
		right.finish_defect_control,
		right.composition_framing,
		right.distinctiveness,
	];
	return (
		leftValues.reduce(
			(sum, value, index) =>
				sum + 1 - Math.abs(value - rightValues[index]!) / maximums[index]!,
			0,
		) / leftValues.length
	);
}

export function scorerAgreement(
	scores: VisualScore[],
	items: BlindItem[],
): number {
	const byItem = new Map<string, VisualScore[]>();
	for (const score of scores)
		byItem.set(score.opaque_id, [
			...(byItem.get(score.opaque_id) ?? []),
			score,
		]);
	const agreements: number[] = [];
	for (const values of byItem.values())
		for (let left = 0; left < values.length; left += 1)
			for (let right = left + 1; right < values.length; right += 1)
				agreements.push(scoreAgreement(values[left]!, values[right]!));
	for (const duplicate of items.filter((item) => item.duplicate_of !== null)) {
		const original = byItem.get(duplicate.duplicate_of!);
		const repeated = byItem.get(duplicate.opaque_id);
		if (!original || !repeated)
			throw new Error(`Duplicate ${duplicate.opaque_id} is missing scores`);
		for (const first of original) {
			const second = repeated.find((score) => score.rater_id === first.rater_id);
			if (!second)
				throw new Error(
					`Duplicate ${duplicate.opaque_id} is missing rater ${first.rater_id}`,
				);
			agreements.push(scoreAgreement(first, second));
		}
	}
	if (!agreements.length)
		throw new Error("Scorer agreement requires at least two comparable scores");
	return agreements.reduce((sum, value) => sum + value, 0) / agreements.length;
}

export async function closeScoring(
	scoringRoot: string,
	minimumRaters: number,
	minimumAgreement: number,
): Promise<{
	aggregate: Record<string, { mean: number; rater_count: number }>;
	run_scores: Record<string, { mean: number; rater_count: number }>;
	scorer_agreement: number;
}> {
	const mapping = await readJson<{
		scoring_closed: boolean;
		items: BlindItem[];
	}>(join(scoringRoot, "PRIVATE-blind-map.json"));
	if (mapping.scoring_closed) {
		const closed = await readJson<{
			scores: Record<string, { mean: number; rater_count: number }>;
			run_scores: Record<string, { mean: number; rater_count: number }>;
			scorer_agreement: number;
			minimum_agreement: number;
		}>(join(scoringRoot, "aggregate.json"));
		if (
			closed.minimum_agreement !== minimumAgreement ||
			closed.scorer_agreement < minimumAgreement
		)
			throw new Error("Closed visual scoring does not satisfy frozen agreement");
		return {
			aggregate: closed.scores,
			run_scores: closed.run_scores,
			scorer_agreement: closed.scorer_agreement,
		};
	}
	const scores = await readVisualScores(scoringRoot);
	const aggregate = aggregateVisualScores(scores, minimumRaters);
	const agreement = scorerAgreement(scores, mapping.items);
	if (agreement < minimumAgreement)
		throw new Error(
			`Scorer agreement ${agreement.toFixed(3)} is below frozen minimum ${minimumAgreement.toFixed(3)}`,
		);
	const byRun = new Map<string, Array<{ mean: number; rater_count: number }>>();
	for (const item of mapping.items) {
		if (item.duplicate_of !== null) continue;
		const score = aggregate[item.opaque_id];
		if (score)
			byRun.set(item.source_run_id, [
				...(byRun.get(item.source_run_id) ?? []),
				score,
			]);
	}
	const runScores = Object.fromEntries(
		[...byRun].map(([runId, values]) => [
			runId,
			{
				mean:
					values.reduce((sum, value) => sum + value.mean, 0) / values.length,
				rater_count: Math.min(...values.map((value) => value.rater_count)),
			},
		]),
	);
	await writeJsonAtomic(join(scoringRoot, "aggregate.json"), {
		schema_version: "1.0.0",
		scores: aggregate,
		run_scores: runScores,
		scorer_agreement: agreement,
		minimum_agreement: minimumAgreement,
	});
	await writeJsonAtomic(join(scoringRoot, "PRIVATE-blind-map.json"), {
		...mapping,
		scoring_closed: true,
		closed_at: new Date().toISOString(),
	});
	return { aggregate, run_scores: runScores, scorer_agreement: agreement };
}
