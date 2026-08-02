import type { AttemptRecord, SeedPlan, TaskManifest } from "./types.js";

function object(
	value: unknown,
	path: string,
	errors: string[],
): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		errors.push(`${path} must be an object`);
		return false;
	}
	return true;
}

function required(
	record: Record<string, unknown>,
	names: string[],
	path: string,
	errors: string[],
): void {
	for (const name of names)
		if (!(name in record)) errors.push(`${path}.${name} is required`);
}

export function validateTask(value: unknown): string[] {
	const errors: string[] = [];
	if (!object(value, "task", errors)) return errors;
	required(
		value,
		[
			"schema_version",
			"id",
			"version",
			"category",
			"prompt",
			"fixture",
			"required_artifacts",
			"deterministic_oracles",
		],
		"task",
		errors,
	);
	if (!/^P[1-6]$/u.test(String(value.id))) errors.push("task.id must be P1-P6");
	if (
		!Array.isArray(value.required_artifacts) ||
		value.required_artifacts.length === 0
	)
		errors.push("task.required_artifacts must be non-empty");
	if (
		!Array.isArray(value.deterministic_oracles) ||
		value.deterministic_oracles.length === 0
	)
		errors.push("task.deterministic_oracles must be non-empty");
	return errors;
}

export function validatePlan(value: unknown): string[] {
	const errors: string[] = [];
	if (!object(value, "plan", errors)) return errors;
	required(
		value,
		[
			"schema_version",
			"study_id",
			"kind",
			"randomization_seed",
			"manifest_sha256",
			"cells",
		],
		"plan",
		errors,
	);
	if (!Array.isArray(value.cells)) errors.push("plan.cells must be an array");
	else {
		const ids = new Set<string>();
		value.cells.forEach((cell, index) => {
			if (!object(cell, `plan.cells[${index}]`, errors)) return;
			required(
				cell,
				[
					"cell_id",
					"pair_id",
					"task_id",
					"replicate",
					"arm",
					"order_in_pair",
					"sequence",
					"seed",
					"cache_regime",
				],
				`plan.cells[${index}]`,
				errors,
			);
			const id = String(cell.cell_id);
			if (ids.has(id)) errors.push(`plan.cells duplicate cell_id ${id}`);
			ids.add(id);
		});
	}
	return errors;
}

export function validateAttempt(value: unknown): string[] {
	const errors: string[] = [];
	if (!object(value, "attempt", errors)) return errors;
	required(
		value,
		[
			"schema_version",
			"study_id",
			"run_id",
			"pair_id",
			"task_id",
			"task_category",
			"capability_scope",
			"replicate",
			"arm",
			"randomization",
			"validity",
			"versions",
			"inputs",
			"cache",
			"usage",
			"trajectory",
			"timing",
			"outcome",
			"scores",
			"artifacts",
			"oracles",
			"environment",
			"notes",
		],
		"attempt",
		errors,
	);
	for (const section of [
		"randomization",
		"validity",
		"inputs",
		"cache",
		"usage",
		"trajectory",
		"timing",
		"outcome",
		"scores",
		"oracles",
		"environment",
	])
		object(value[section], `attempt.${section}`, errors);
	if (!Array.isArray(value.artifacts))
		errors.push("attempt.artifacts must be an array");
	if (!Array.isArray(value.notes))
		errors.push("attempt.notes must be an array");
	if (!(["axi", "mcp"] as unknown[]).includes(value.arm))
		errors.push("attempt.arm must be axi or mcp");
	return errors;
}

export function assertValidTask(value: unknown): asserts value is TaskManifest {
	const errors = validateTask(value);
	if (errors.length) throw new Error(errors.join("; "));
}

export function assertValidPlan(value: unknown): asserts value is SeedPlan {
	const errors = validatePlan(value);
	if (errors.length) throw new Error(errors.join("; "));
}

export function assertValidAttempt(
	value: unknown,
): asserts value is AttemptRecord {
	const errors = validateAttempt(value);
	if (errors.length) throw new Error(errors.join("; "));
}
