import type { AttemptRecord } from "./types.js";
import { mulberry32 } from "./util.js";

export interface Interval {
	estimate: number | null;
	lower: number | null;
	upper: number | null;
}
export interface MetricSummary {
	n: number;
	mean: number | null;
	median: number | null;
	standard_deviation: number | null;
	q1: number | null;
	q3: number | null;
	minimum: number | null;
	maximum: number | null;
}

function sorted(values: number[]): number[] {
	return [...values].sort((a, b) => a - b);
}

export function quantile(values: number[], probability: number): number | null {
	if (!values.length) return null;
	const items = sorted(values);
	const index = (items.length - 1) * probability;
	const lower = Math.floor(index);
	const fraction = index - lower;
	return (
		items[lower]! +
		fraction * ((items[lower + 1] ?? items[lower]!) - items[lower]!)
	);
}

export function summarize(values: Array<number | null>): MetricSummary {
	const usable = values.filter(
		(value): value is number => value !== null && Number.isFinite(value),
	);
	const mean = usable.length
		? usable.reduce((sum, value) => sum + value, 0) / usable.length
		: null;
	const variance =
		usable.length > 1 && mean !== null
			? usable.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
				(usable.length - 1)
			: null;
	return {
		n: usable.length,
		mean,
		median: quantile(usable, 0.5),
		standard_deviation: variance === null ? null : Math.sqrt(variance),
		q1: quantile(usable, 0.25),
		q3: quantile(usable, 0.75),
		minimum: usable.length ? Math.min(...usable) : null,
		maximum: usable.length ? Math.max(...usable) : null,
	};
}

export function passAtK(
	n: number,
	successes: number,
	k: number,
): number | null {
	if (n <= 0 || successes < 0 || successes > n || k <= 0 || k > n) return null;
	if (n - successes < k) return 1;
	let miss = 1;
	for (let index = 0; index < k; index += 1)
		miss *= (n - successes - index) / (n - index);
	return 1 - miss;
}

export function wilson(
	successes: number,
	n: number,
	confidence = 0.95,
): Interval {
	if (!n) return { estimate: null, lower: null, upper: null };
	const z = confidence === 0.95 ? 1.959963984540054 : 1.959963984540054;
	const estimate = successes / n;
	const denominator = 1 + (z * z) / n;
	const center = (estimate + (z * z) / (2 * n)) / denominator;
	const half =
		(z / denominator) *
		Math.sqrt((estimate * (1 - estimate)) / n + (z * z) / (4 * n * n));
	return { estimate, lower: center - half, upper: center + half };
}

interface PairValue {
	task: string;
	pair: string;
	axi: number;
	mcp: number;
}

function pairedValues(
	records: AttemptRecord[],
	metric: (record: AttemptRecord) => number | null,
): PairValue[] {
	const valid = records.filter((record) => record.validity.status === "valid");
	const groups = new Map<string, AttemptRecord[]>();
	for (const record of valid)
		groups.set(record.pair_id, [...(groups.get(record.pair_id) ?? []), record]);
	const output: PairValue[] = [];
	for (const [pair, values] of groups) {
		const axi = values.find((record) => record.arm === "axi");
		const mcp = values.find((record) => record.arm === "mcp");
		if (!axi || !mcp) continue;
		const axiValue = metric(axi);
		const mcpValue = metric(mcp);
		if (axiValue === null || mcpValue === null) continue;
		output.push({ task: axi.task_id, pair, axi: axiValue, mcp: mcpValue });
	}
	return output;
}

export function clusteredPairedBootstrap(
	records: AttemptRecord[],
	metric: (record: AttemptRecord) => number | null,
	options: { samples: number; seed: number; ratio?: boolean } = {
		samples: 10_000,
		seed: 872341,
	},
): Interval {
	const pairs = pairedValues(records, metric);
	if (!pairs.length) return { estimate: null, lower: null, upper: null };
	const taskMap = new Map<string, PairValue[]>();
	for (const pair of pairs)
		taskMap.set(pair.task, [...(taskMap.get(pair.task) ?? []), pair]);
	const tasks = [...taskMap.keys()];
	const statistic = (sample: PairValue[]): number => {
		const perTask = new Map<string, number[]>();
		for (const pair of sample) {
			const value = options.ratio ? pair.axi / pair.mcp : pair.axi - pair.mcp;
			perTask.set(pair.task, [...(perTask.get(pair.task) ?? []), value]);
		}
		return (
			[...perTask.values()].reduce(
				(sum, values) => sum + (quantile(values, 0.5) ?? 0),
				0,
			) / perTask.size
		);
	};
	const estimate = statistic(pairs);
	const random = mulberry32(options.seed);
	const distribution: number[] = [];
	for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex += 1) {
		const sampledClusterStatistics: number[] = [];
		for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
			const selectedTask = tasks[Math.floor(random() * tasks.length)]!;
			const taskPairs = taskMap.get(selectedTask)!;
			const sampledPairs: PairValue[] = [];
			for (let pairIndex = 0; pairIndex < taskPairs.length; pairIndex += 1)
				sampledPairs.push(taskPairs[Math.floor(random() * taskPairs.length)]!);
			sampledClusterStatistics.push(
				quantile(
					sampledPairs.map((pair) =>
						options.ratio ? pair.axi / pair.mcp : pair.axi - pair.mcp,
					),
					0.5,
				) ?? 0,
			);
		}
		distribution.push(
			sampledClusterStatistics.reduce((sum, value) => sum + value, 0) /
				sampledClusterStatistics.length,
		);
	}
	return {
		estimate,
		lower: quantile(distribution, 0.025),
		upper: quantile(distribution, 0.975),
	};
}

export interface AnalysisReport {
	schema_version: "1.0.0";
	counts: {
		total_attempts: number;
		valid_attempts: number;
		invalid_attempts: number;
		shared_valid_attempts: number;
		exclusive_valid_attempts: number;
	};
	arms: Record<
		string,
		{
			outcomes: Record<string, number>;
			success: Interval;
			deterministic_score: MetricSummary;
			visual_score: MetricSummary;
			unity_score: MetricSummary;
			input_tokens: MetricSummary;
			cost_usd: MetricSummary;
			wall_seconds: MetricSummary;
			interface_surface_bytes: MetricSummary;
		}
	>;
	tasks: Array<{
		task_id: string;
		arm: string;
		n: number;
		successes: number;
		pass_at_k: Record<string, number | null>;
		outcomes: Record<string, number>;
	}>;
	errors: Record<string, number>;
	paired: {
		functional_axi_minus_mcp: Interval;
		deterministic_axi_minus_mcp: Interval;
		visual_axi_minus_mcp: Interval;
		unity_axi_minus_mcp: Interval;
		input_token_ratio_axi_over_mcp: Interval;
		cost_ratio_axi_over_mcp: Interval;
	};
	non_inferiority: Record<
		string,
		{
			margin: number;
			result: "pass" | "fail" | "inconclusive";
			interval: Interval;
		}
	>;
	cache_views: Record<string, Record<string, MetricSummary>>;
}

function outcomeCounts(records: AttemptRecord[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const record of records)
		counts[record.outcome.status] = (counts[record.outcome.status] ?? 0) + 1;
	return counts;
}

export function analyze(
	records: AttemptRecord[],
	config: {
		bootstrap: { samples: number; seed: number };
		margins: Record<string, number>;
	},
): AnalysisReport {
	const valid = records.filter((record) => record.validity.status === "valid");
	const shared = valid.filter((record) => record.capability_scope === "shared");
	const armRows = Object.fromEntries(
		(["axi", "mcp"] as const).map((arm) => {
			const rows = shared.filter((record) => record.arm === arm);
			const successes = rows.filter(
				(record) => record.outcome.functional_success,
			).length;
			return [
				arm,
				{
					outcomes: outcomeCounts(rows),
					success: wilson(successes, rows.length),
					deterministic_score: summarize(
						rows.map((record) => record.scores.deterministic_structure_0_100),
					),
					visual_score: summarize(
						rows.map((record) => record.scores.visual_blinded_0_100),
					),
					unity_score: summarize(
						rows.map((record) => record.scores.unity_readiness_0_100),
					),
					input_tokens: summarize(
						rows.map((record) => record.usage.provider_input_tokens_total),
					),
					cost_usd: summarize(rows.map((record) => record.usage.api_cost_usd)),
					wall_seconds: summarize(
						rows.map((record) => record.timing.wall_seconds),
					),
					interface_surface_bytes: summarize(
						rows.map(
							(record) => record.inputs.marginal_interface_surface_bytes,
						),
					),
				},
			];
		}),
	);
	const tasks = [];
	for (const taskId of [
		...new Set(valid.map((record) => record.task_id)),
	].sort()) {
		for (const arm of ["axi", "mcp"] as const) {
			const rows = valid.filter(
				(record) => record.task_id === taskId && record.arm === arm,
			);
			const successes = rows.filter(
				(record) => record.outcome.functional_success,
			).length;
			tasks.push({
				task_id: taskId,
				arm,
				n: rows.length,
				successes,
				pass_at_k: Object.fromEntries(
					[1, 2, 3, 4, 5].map((k) => [
						String(k),
						passAtK(rows.length, successes, k),
					]),
				),
				outcomes: outcomeCounts(rows),
			});
		}
	}
	const bootstrap = {
		samples: config.bootstrap.samples,
		seed: config.bootstrap.seed,
	};
	const paired = {
		functional_axi_minus_mcp: clusteredPairedBootstrap(
			shared,
			(record) => (record.outcome.functional_success ? 1 : 0),
			bootstrap,
		),
		deterministic_axi_minus_mcp: clusteredPairedBootstrap(
			shared,
			(record) => record.scores.deterministic_structure_0_100,
			bootstrap,
		),
		visual_axi_minus_mcp: clusteredPairedBootstrap(
			shared,
			(record) => record.scores.visual_blinded_0_100,
			bootstrap,
		),
		unity_axi_minus_mcp: clusteredPairedBootstrap(
			shared,
			(record) => record.scores.unity_readiness_0_100,
			bootstrap,
		),
		input_token_ratio_axi_over_mcp: clusteredPairedBootstrap(
			shared,
			(record) => record.usage.provider_input_tokens_total,
			{ ...bootstrap, ratio: true },
		),
		cost_ratio_axi_over_mcp: clusteredPairedBootstrap(
			shared,
			(record) => record.usage.api_cost_usd,
			{ ...bootstrap, ratio: true },
		),
	};
	const verdict = (
		interval: Interval,
		margin: number,
		upper = false,
	): "pass" | "fail" | "inconclusive" => {
		const bound = upper ? interval.upper : interval.lower;
		if (bound === null) return "inconclusive";
		return upper
			? bound < margin
				? "pass"
				: "fail"
			: bound > margin
				? "pass"
				: "fail";
	};
	const nonInferiority = {
		functional: {
			margin: config.margins.functional_success_percentage_points / 100,
			result: verdict(
				paired.functional_axi_minus_mcp,
				config.margins.functional_success_percentage_points / 100,
			),
			interval: paired.functional_axi_minus_mcp,
		},
		deterministic: {
			margin: config.margins.deterministic_score_points,
			result: verdict(
				paired.deterministic_axi_minus_mcp,
				config.margins.deterministic_score_points,
			),
			interval: paired.deterministic_axi_minus_mcp,
		},
		visual: {
			margin: config.margins.visual_score_points,
			result: verdict(
				paired.visual_axi_minus_mcp,
				config.margins.visual_score_points,
			),
			interval: paired.visual_axi_minus_mcp,
		},
		unity: {
			margin: config.margins.unity_score_points,
			result: verdict(
				paired.unity_axi_minus_mcp,
				config.margins.unity_score_points,
			),
			interval: paired.unity_axi_minus_mcp,
		},
		input_tokens: {
			margin: config.margins.input_token_ratio_upper,
			result: verdict(
				paired.input_token_ratio_axi_over_mcp,
				config.margins.input_token_ratio_upper,
				true,
			),
			interval: paired.input_token_ratio_axi_over_mcp,
		},
		cost: {
			margin: config.margins.api_cost_ratio_upper,
			result: verdict(
				paired.cost_ratio_axi_over_mcp,
				config.margins.api_cost_ratio_upper,
				true,
			),
			interval: paired.cost_ratio_axi_over_mcp,
		},
	};
	const cacheViews: Record<string, Record<string, MetricSummary>> = {};
	for (const regime of ["cold", "warm"] as const)
		cacheViews[regime] = Object.fromEntries(
			(["axi", "mcp"] as const).map((arm) => [
				arm,
				summarize(
					shared
						.filter(
							(record) => record.cache.regime === regime && record.arm === arm,
						)
						.map((record) => record.usage.api_cost_usd),
				),
			]),
		);
	return {
		schema_version: "1.0.0",
		counts: {
			total_attempts: records.length,
			valid_attempts: valid.length,
			invalid_attempts: records.length - valid.length,
			shared_valid_attempts: shared.length,
			exclusive_valid_attempts: valid.length - shared.length,
		},
		arms: armRows,
		tasks,
		errors: outcomeCounts(
			records.filter((record) => !record.outcome.functional_success),
		),
		paired,
		non_inferiority: nonInferiority,
		cache_views: cacheViews,
	};
}
