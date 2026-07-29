import { AxiError } from "axi-sdk-js";

export interface ParsedArgs {
	positionals: string[];
	flags: Map<string, string | true>;
}

export function parseArgs(
	args: string[],
	valueFlags: readonly string[],
	booleanFlags: readonly string[] = ["--json", "--launch"],
): ParsedArgs {
	const values = new Set(valueFlags);
	const booleans = new Set(booleanFlags);
	const positionals: string[] = [];
	const flags = new Map<string, string | true>();

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const equals = arg.indexOf("=");
		const name = equals < 0 ? arg : arg.slice(0, equals);
		if (booleans.has(name)) {
			if (equals >= 0) throw usage(`Flag ${name} does not take a value`);
			flags.set(name, true);
			continue;
		}
		if (!values.has(name)) {
			throw usage(`Unknown flag ${name}`, [
				`Valid flags: ${[...values, ...booleans, "--help"].join(", ") || "--help"}`,
			]);
		}
		const value = equals >= 0 ? arg.slice(equals + 1) : args[++i];
		if (!value || value.startsWith("--"))
			throw usage(`${name} requires a value`);
		flags.set(name, value);
	}
	return { positionals, flags };
}

export function requirePositionals(
	parsed: ParsedArgs,
	count: number,
	usageText: string,
): string[] {
	if (parsed.positionals.length !== count)
		throw usage(`Expected ${count} argument(s)`, [usageText]);
	return parsed.positionals;
}

export function flagString(
	parsed: ParsedArgs,
	name: string,
): string | undefined {
	const value = parsed.flags.get(name);
	return typeof value === "string" ? value : undefined;
}

export function usage(message: string, suggestions: string[] = []): AxiError {
	return new AxiError(message, "VALIDATION_ERROR", suggestions);
}
