import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sendRequest } from "./protocol.js";
import {
	generatePrelude,
	parseExecutionOutput,
	type ExecutionResult,
	type PreludeOptions,
} from "./prelude.js";

export interface SessionContext {
	session: string;
	port: number;
	stateDir: string;
}

class DeadPortError extends Error {
	constructor(
		readonly session: string,
		readonly port: number,
		cause?: unknown,
	) {
		super(
			`No Blender addon answered for session "${session}" on port ${port}`,
			{ cause },
		);
	}
}

export async function requestAddon(
	context: SessionContext,
	type: string,
	params: Record<string, unknown> = {},
): Promise<unknown> {
	let response;
	try {
		response = await sendRequest(context.port, { type, params });
	} catch (error) {
		throw new DeadPortError(context.session, context.port, error);
	}
	if (response.status === "error") throw new Error(response.message);
	return response.result;
}

export async function executeSource(
	context: SessionContext,
	source: string,
	options: PreludeOptions = {},
): Promise<ExecutionResult> {
	const raw = await requestAddon(context, "execute_code", {
		code: generatePrelude(source, options),
	});
	if (
		!raw ||
		typeof raw !== "object" ||
		!("result" in raw) ||
		typeof raw.result !== "string"
	) {
		throw new Error("Malformed execute_code response from Blender addon");
	}
	return parseExecutionOutput(raw.result);
}

export function readPythonSource(file: string): {
	source: string;
	filename: string;
} {
	if (file === "-")
		return { source: readFileSync(0, "utf8"), filename: "<stdin>" };
	const filename = resolve(file);
	return { source: readFileSync(filename, "utf8"), filename };
}

export function defaultRenderDirectory(savePath?: string): string {
	return savePath ? dirname(resolve(savePath)) : process.cwd();
}
