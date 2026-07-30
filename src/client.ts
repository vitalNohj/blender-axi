import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { AddonTransportError, sendRequest } from "./protocol.js";
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

export class DeadPortError extends AxiError {
	constructor(
		readonly session: string,
		readonly port: number,
		readonly cause?: unknown,
	) {
		super(
			`No Blender addon answered for session "${session}" on port ${port}`,
			"BLENDER_UNREACHABLE",
			[
				"Run `blender-axi start` to launch Blender for this session",
				"Or re-run the command with `--launch`",
			],
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
		if (error instanceof AddonTransportError)
			throw new DeadPortError(context.session, context.port, error);
		throw error;
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
