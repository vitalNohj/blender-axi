import { createHash } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
	return sha256(await readFile(path));
}

export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => a.localeCompare(b),
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export async function writeJsonAtomic(
	path: string,
	value: unknown,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporary, path);
}

export async function appendJsonl(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function readJson<T>(path: string): Promise<T> {
	const text = await readFile(path, "utf8");
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`Invalid JSON at ${path}: ${(error as Error).message}`, {
			cause: error,
		});
	}
}

export async function readJsonl<T>(path: string): Promise<T[]> {
	try {
		const text = await readFile(path, "utf8");
		return text
			.split(/\r?\n/u)
			.filter(Boolean)
			.map((line, index) => {
				try {
					return JSON.parse(line) as T;
				} catch (error) {
					throw new Error(
						`Invalid JSONL at ${path}:${index + 1}: ${(error as Error).message}`,
					);
				}
			});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function assertInside(root: string, target: string): string {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	const child = relative(resolvedRoot, resolvedTarget);
	if (
		child === "" ||
		(!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep))
	)
		return resolvedTarget;
	throw new Error(`Path escapes benchmark root: ${target}`);
}

export function redact(value: unknown, secretValues: string[] = []): unknown {
	const sensitive =
		/(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)/iu;
	const replace = (text: string): string => {
		let output = text.replace(
			/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/giu,
			"[REDACTED]",
		);
		for (const secret of secretValues.filter(Boolean))
			output = output.split(secret).join("[REDACTED]");
		return output;
	};
	if (typeof value === "string") return replace(value);
	if (Array.isArray(value))
		return value.map((item) => redact(item, secretValues));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [
				key,
				sensitive.test(key) ? "[REDACTED]" : redact(item, secretValues),
			]),
		);
	}
	return value;
}

export function mulberry32(seed: number): () => number {
	let value = seed >>> 0;
	return () => {
		value += 0x6d2b79f5;
		let result = value;
		result = Math.imul(result ^ (result >>> 15), result | 1);
		result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
		return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffle<T>(values: readonly T[], random: () => number): T[] {
	const output = [...values];
	for (let index = output.length - 1; index > 0; index -= 1) {
		const selected = Math.floor(random() * (index + 1));
		[output[index], output[selected]] = [output[selected]!, output[index]!];
	}
	return output;
}

export async function fileMetadata(
	path: string,
): Promise<{ sha256: string; bytes: number }> {
	const details = await stat(path);
	return { sha256: await sha256File(path), bytes: details.size };
}
