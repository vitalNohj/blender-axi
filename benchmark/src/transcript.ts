import { readFile } from "node:fs/promises";
import type { ToolEvent } from "./types.js";
import { redact } from "./util.js";

function nestedObjects(value: unknown): unknown[] {
	if (!value || typeof value !== "object") return [];
	const output: unknown[] = [value];
	for (const child of Object.values(value as Record<string, unknown>)) {
		if (Array.isArray(child))
			for (const item of child) output.push(...nestedObjects(item));
		else output.push(...nestedObjects(child));
	}
	return output;
}

function toolUse(
	node: Record<string, unknown>,
): { name: string; input: unknown } | null {
	const type = node.type;
	if (
		(type === "tool_use" || type === "function_call") &&
		typeof (node.name ?? node.tool_name) === "string"
	) {
		return {
			name: String(node.name ?? node.tool_name),
			input: node.input ?? node.arguments ?? null,
		};
	}
	if (
		typeof node.method === "string" &&
		(node.method === "tools/call" || node.method.endsWith("/call"))
	) {
		const params = node.params as Record<string, unknown> | undefined;
		if (typeof params?.name === "string")
			return { name: params.name, input: params.arguments ?? null };
	}
	return null;
}

function toolResult(
	node: Record<string, unknown>,
): { id: string | null; content: unknown; success: boolean | null } | null {
	const type = node.type;
	if (type === "tool_result" || type === "function_call_output") {
		return {
			id:
				typeof (node.tool_use_id ?? node.call_id) === "string"
					? String(node.tool_use_id ?? node.call_id)
					: null,
			content: node.content ?? node.output ?? null,
			success: typeof node.is_error === "boolean" ? !node.is_error : null,
		};
	}
	return null;
}

export function extractToolEvents(
	records: unknown[],
	secrets: string[] = [],
): ToolEvent[] {
	const events: ToolEvent[] = [];
	const ids = new Map<string, number>();
	for (const record of records) {
		for (const candidate of nestedObjects(record)) {
			const node = candidate as Record<string, unknown>;
			const use = toolUse(node);
			if (use) {
				const event: ToolEvent = {
					timestamp: typeof node.timestamp === "string" ? node.timestamp : null,
					tool: use.name,
					interface:
						/^mcp__/iu.test(use.name) || node.method === "tools/call"
							? "mcp"
							: /shell|bash|exec/iu.test(use.name)
								? "shell"
								: "unknown",
					arguments: redact(use.input, secrets),
					response: null,
					success: null,
					duration_seconds: null,
				};
				events.push(event);
				const id = node.id ?? node.tool_use_id ?? node.call_id;
				if (typeof id === "string") ids.set(id, events.length - 1);
			}
			const result = toolResult(node);
			if (result) {
				const index = result.id === null ? -1 : (ids.get(result.id) ?? -1);
				if (index >= 0) {
					events[index]!.response = redact(result.content, secrets);
					events[index]!.success = result.success;
				}
			}
		}
	}
	return events;
}

export async function parseProviderJsonl(
	path: string,
	secrets: string[] = [],
): Promise<{ records: unknown[]; events: ToolEvent[] }> {
	const text = await readFile(path, "utf8");
	const records = text
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line, index) => {
			try {
				return JSON.parse(line) as unknown;
			} catch (error) {
				throw new Error(
					`Invalid provider JSONL at line ${index + 1}: ${(error as Error).message}`,
				);
			}
		});
	return {
		records: redact(records, secrets) as unknown[],
		events: extractToolEvents(records, secrets),
	};
}

export function summarizeEvents(events: ToolEvent[]): {
	tool_calls: number;
	failed_tool_calls: number;
	help_calls: number;
	argument_bytes: number;
	response_bytes: number;
} {
	return {
		tool_calls: events.length,
		failed_tool_calls: events.filter((event) => event.success === false).length,
		help_calls: events.filter((event) =>
			/(?:^|\s)--help(?:\s|$)|\bhelp\b/iu.test(JSON.stringify(event.arguments)),
		).length,
		argument_bytes: events.reduce(
			(total, event) =>
				total + Buffer.byteLength(JSON.stringify(event.arguments)),
			0,
		),
		response_bytes: events.reduce(
			(total, event) =>
				total + Buffer.byteLength(JSON.stringify(event.response)),
			0,
		),
	};
}
