import { Socket } from "node:net";

export interface AddonRequest {
	type: string;
	params: Record<string, unknown>;
}

export type AddonResponse =
	| { status: "success"; result: unknown }
	| { status: "error"; message: string };

export interface ProtocolOptions {
	host?: string;
	timeoutMs?: number;
	socketFactory?: () => Socket;
}

export class AddonTransportError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause });
	}
}

export class AddonProtocolError extends Error {}

export function encodeRequest(request: AddonRequest): Buffer {
	return Buffer.from(JSON.stringify(request), "utf8");
}

export function tryParseResponse(buffer: Buffer): AddonResponse | undefined {
	if (buffer.length === 0) return undefined;
	try {
		const value: unknown = JSON.parse(buffer.toString("utf8"));
		if (!value || typeof value !== "object" || !("status" in value)) {
			throw new AddonProtocolError(
				"Malformed Blender addon response: missing status",
			);
		}
		return value as AddonResponse;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export function sendRequest(
	port: number,
	request: AddonRequest,
	options: ProtocolOptions = {},
): Promise<AddonResponse> {
	const host = options.host ?? "127.0.0.1";
	const timeoutMs = options.timeoutMs ?? 300_000;

	return new Promise((resolve, reject) => {
		const socket = options.socketFactory?.() ?? new Socket();
		let response = Buffer.alloc(0);
		let settled = false;

		const finish = (error?: Error, value?: AddonResponse) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolve(value as AddonResponse);
		};

		socket.setTimeout(timeoutMs);
		socket.once("timeout", () =>
			finish(
				new AddonTransportError(
					`Blender addon timed out after ${timeoutMs}ms`,
				),
			),
		);
		socket.once("error", (error) =>
			finish(new AddonTransportError(error.message, error)),
		);
		socket.on("data", (chunk: Buffer) => {
			response = Buffer.concat([response, chunk]);
			try {
				const parsed = tryParseResponse(response);
				if (parsed) finish(undefined, parsed);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.once("close", () => {
			if (settled) return;
			try {
				const parsed = tryParseResponse(response);
				finish(
					parsed
						? undefined
						: new AddonProtocolError(
								"Blender addon closed the socket before sending complete JSON",
							),
					parsed,
				);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.connect(port, host, () => socket.write(encodeRequest(request)));
	});
}
