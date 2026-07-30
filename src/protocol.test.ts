import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	AddonProtocolError,
	encodeRequest,
	sendRequest,
	tryParseResponse,
} from "./protocol.js";

class FakeSocket extends EventEmitter {
	written?: Buffer;
	destroyed = false;
	setTimeout() {
		return this;
	}
	connect(_port: number, _host: string, callback: () => void) {
		callback();
		return this;
	}
	write(value: Buffer) {
		this.written = value;
		return true;
	}
	destroy() {
		this.destroyed = true;
		return this;
	}
}

describe("protocol", () => {
	it("encodes newline-free JSON", () => {
		const encoded = encodeRequest({ type: "get_scene_info", params: {} });
		expect(encoded.toString()).toBe('{"type":"get_scene_info","params":{}}');
		expect(encoded.includes(10)).toBe(false);
	});

	it("returns undefined for incomplete chunks", () => {
		expect(
			tryParseResponse(Buffer.from('{"status":"success"')),
		).toBeUndefined();
	});

	it.each([
		[
			'{"status":"success"}',
			"Malformed Blender addon response: success response missing result",
		],
		[
			'{"status":"bogus"}',
			'Malformed Blender addon response: unknown status "bogus"',
		],
		[
			'{"status":"error"}',
			"Malformed Blender addon response: error response missing message",
		],
		[
			'{"status":"error","message":42}',
			"Malformed Blender addon response: error response message must be a string",
		],
		[
			"null",
			"Malformed Blender addon response: expected an object",
		],
	])("rejects malformed response %s", (response, message) => {
		expect(() => tryParseResponse(Buffer.from(response))).toThrowError(
			AddonProtocolError,
		);
		expect(() => tryParseResponse(Buffer.from(response))).toThrowError(message);
	});

	it("reassembles chunked responses", async () => {
		const socket = new FakeSocket();
		const pending = sendRequest(
			9876,
			{ type: "get_scene_info", params: {} },
			{
				socketFactory: () => socket as never,
			},
		);
		socket.emit("data", Buffer.from('{"status":"success","res'));
		socket.emit("data", Buffer.from('ult":{"object_count":3}}'));
		await expect(pending).resolves.toEqual({
			status: "success",
			result: { object_count: 3 },
		});
		expect(socket.destroyed).toBe(true);
	});
});
