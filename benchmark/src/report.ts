import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AnalysisReport, Interval, MetricSummary } from "./analysis.js";
import type { AttemptRecord } from "./types.js";
import { analyze } from "./analysis.js";
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from "./util.js";

interface VisualScoreRecord {
	schema_version: "1.0.0";
	run_id: string;
	mean: number;
	rater_count: number;
	scorer_agreement: number;
	visual_scores_path: string;
}

function number(value: number | null, digits = 3): string {
	return value === null ? "NA" : value.toFixed(digits);
}
function interval(value: Interval): string {
	return value.estimate === null
		? "NA"
		: `${number(value.estimate)} [${number(value.lower)}, ${number(value.upper)}]`;
}
function metric(value: MetricSummary): string {
	return value.n
		? `n=${value.n}, median=${number(value.median)}, mean=${number(value.mean)}, IQR=${number(value.q1)}-${number(value.q3)}`
		: "n=0";
}

export function markdownReport(report: AnalysisReport): string {
	const lines = [
		"# blender-axi versus BlenderMCP benchmark report",
		"",
		"> Generated from append-only attempt records. Capability-exclusive tasks are excluded from shared-quality estimates. Quality and efficiency remain separate.",
		"",
		"## Integrity and coverage",
		"",
		`- Attempts: ${report.counts.total_attempts}`,
		`- Valid: ${report.counts.valid_attempts}`,
		`- Invalid retained: ${report.counts.invalid_attempts}`,
		`- Shared valid: ${report.counts.shared_valid_attempts}`,
		`- Capability-exclusive valid, reported separately: ${report.counts.exclusive_valid_attempts}`,
		"",
		"## Primary non-inferiority and superiority gates",
		"",
		"| Outcome | Frozen margin | Result | Paired clustered interval |",
		"|---|---:|---|---|",
		...Object.entries(report.non_inferiority).map(
			([name, result]) =>
				`| ${name} | ${result.margin} | ${result.result} | ${interval(result.interval)} |`,
		),
		"",
		"Deterministic, visual, and Unity quality are not collapsed into an efficiency score. Missing visual or Unity measurements remain inconclusive.",
		"",
		"## Arm summaries",
		"",
	];
	for (const [arm, value] of Object.entries(report.arms)) {
		lines.push(
			`### ${arm.toUpperCase()}`,
			"",
			`- Outcomes: \`${JSON.stringify(value.outcomes)}\``,
			`- Functional success: ${interval(value.success)}`,
			`- Deterministic score: ${metric(value.deterministic_score)}`,
			`- Blinded visual score: ${metric(value.visual_score)}`,
			`- Unity readiness: ${metric(value.unity_score)}`,
			`- Provider input tokens: ${metric(value.input_tokens)}`,
			`- Provider-reported cost USD (excluded from conclusions): ${metric(value.cost_usd)}`,
			`- Wall seconds: ${metric(value.wall_seconds)}`,
			`- Marginal interface surface bytes: ${metric(value.interface_surface_bytes)}`,
			"",
		);
	}
	lines.push(
		"## Per-task outcomes and pass^k",
		"",
		"| Task | Arm | n | Solved | pass@1 | pass@2 | pass@3 | pass@4 | pass@5 | Outcomes |",
		"|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
	);
	for (const task of report.tasks)
		lines.push(
			`| ${task.task_id} | ${task.arm} | ${task.n} | ${task.successes} | ${number(task.pass_at_k["1"] ?? null)} | ${number(task.pass_at_k["2"] ?? null)} | ${number(task.pass_at_k["3"] ?? null)} | ${number(task.pass_at_k["4"] ?? null)} | ${number(task.pass_at_k["5"] ?? null)} | \`${JSON.stringify(task.outcomes)}\` |`,
		);
	lines.push(
		"",
		"## Paired AXI minus MCP estimates",
		"",
		`- Functional: ${interval(report.paired.functional_axi_minus_mcp)}`,
		`- Deterministic score: ${interval(report.paired.deterministic_axi_minus_mcp)}`,
		`- Blinded visual: ${interval(report.paired.visual_axi_minus_mcp)}`,
		`- Unity readiness: ${interval(report.paired.unity_axi_minus_mcp)}`,
		`- Input token ratio AXI/MCP: ${interval(report.paired.input_token_ratio_axi_over_mcp)}`,
		`- Provider-reported cost ratio AXI/MCP (excluded from conclusions): ${interval(report.paired.cost_ratio_axi_over_mcp)}`,
		"",
		"## Error composition",
		"",
		`\`${JSON.stringify(report.errors)}\``,
		"",
		"## Cache views",
		"",
	);
	for (const [regime, arms] of Object.entries(report.cache_views))
		for (const [arm, summary] of Object.entries(arms))
			lines.push(
				`- ${regime} ${arm} provider-reported cost: ${metric(summary)}`,
			);
	lines.push(
		"",
		"## Interpretation boundaries",
		"",
		"- Dollar cost is excluded from this benchmark. Cost appears only when the provider reports a strictly positive figure; it is never derived from a catalog price of zero or a frozen rate sheet, so NA means unmeasured rather than free. Token counts and wall time carry the efficiency comparison.",
		"- A final agent claim never overrides deterministic failure.",
		"- Infrastructure-invalid attempts remain in raw results but are excluded from primary estimates.",
		"- Unsupported viewport and third-party service capabilities must be reported separately.",
		"- Residual LLM judging, if added, is optional, blinded, archived, and cannot override hard checks.",
		"",
	);
	return lines.join("\n");
}

export function htmlReport(markdown: string): string {
	const escaped = markdown
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Blender benchmark report</title><style>body{max-width:1100px;margin:2rem auto;padding:0 1rem;font:15px/1.55 system-ui;color:#171717}pre{white-space:pre-wrap;background:#f6f6f6;padding:1rem;border:1px solid #ddd}</style></head><body><pre>${escaped}</pre></body></html>\n`;
}

export async function applyVisualScores(
	resultsPath: string,
	runScores: Record<string, { mean: number; rater_count: number }>,
	scorerAgreement: number,
): Promise<void> {
	const records = await readJsonl<AttemptRecord>(resultsPath);
	const known = new Set(records.map((record) => record.run_id));
	for (const runId of Object.keys(runScores))
		if (!known.has(runId))
			throw new Error(`Visual score references unknown run ${runId}`);
	const scorePath = join(dirname(resultsPath), "visual-scores.jsonl");
	const existing = await readJsonl<VisualScoreRecord>(scorePath);
	const alreadyScored = new Map(existing.map((record) => [record.run_id, record]));
	for (const [runId, score] of Object.entries(runScores)) {
		const prior = alreadyScored.get(runId);
		if (prior) {
			if (
				prior.mean !== score.mean ||
				prior.rater_count !== score.rater_count ||
				prior.scorer_agreement !== scorerAgreement
			)
				throw new Error(`Conflicting visual score already exists for run ${runId}`);
			continue;
		}
		await appendJsonl(scorePath, {
			schema_version: "1.0.0",
			run_id: runId,
			mean: score.mean,
			rater_count: score.rater_count,
			scorer_agreement: scorerAgreement,
			visual_scores_path: "scoring/aggregate.json",
		});
	}
}

export async function generateReports(
	benchmarkRoot: string,
	resultsPath: string,
	outputRoot: string,
): Promise<AnalysisReport> {
	const attempts = await readJsonl<AttemptRecord>(resultsPath);
	const visualScores = await readJsonl<VisualScoreRecord>(
		join(dirname(resultsPath), "visual-scores.jsonl"),
	);
	const visualByRun = new Map(visualScores.map((score) => [score.run_id, score]));
	const records = attempts.map((record) => {
		const visual = visualByRun.get(record.run_id);
		return visual
			? {
					...record,
					scores: {
						...record.scores,
						visual_blinded_0_100: visual.mean,
						visual_rater_count: visual.rater_count,
						scorer_agreement: visual.scorer_agreement,
					},
					oracles: {
						...record.oracles,
						visual_scores_path: visual.visual_scores_path,
					},
				}
			: record;
	});
	const config = await readJson<{
		bootstrap: { samples: number; seed: number };
		margins: Record<string, number>;
	}>(join(benchmarkRoot, "config", "frozen.json"));
	const report = analyze(records, config);
	await mkdir(outputRoot, { recursive: true });
	await writeJsonAtomic(join(outputRoot, "report.json"), report);
	const markdown = markdownReport(report);
	await writeFile(join(outputRoot, "report.md"), `${markdown}\n`);
	await writeFile(join(outputRoot, "report.html"), htmlReport(markdown));
	const summary = [
		"task_id,arm,n,successes,pass_at_1,outcomes",
		...report.tasks.map(
			(task) =>
				`${task.task_id},${task.arm},${task.n},${task.successes},${task.pass_at_k["1"] ?? ""},${JSON.stringify(task.outcomes).replaceAll(",", ";")}`,
		),
	].join("\n");
	await writeFile(join(outputRoot, "summary.csv"), `${summary}\n`);
	return report;
}
