import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { encodeRequest, sendRequest, tryParseResponse } from "./protocol.js";

class FakeSocket extends EventEmitter {
  written?: Buffer;
  destroyed = false;
  setTimeout() { return this; }
  connect(_port: number, _host: string, callback: () => void) { callback(); return this; }
  write(value: Buffer) { this.written = value; return true; }
  destroy() { this.destroyed = true; return this; }
}

describe("protocol", () => {
  it("encodes newline-free JSON", () => {
    const encoded = encodeRequest({ type: "get_scene_info", params: {} });
    expect(encoded.toString()).toBe('{"type":"get_scene_info","params":{}}');
    expect(encoded.includes(10)).toBe(false);
  });

  it("returns undefined for incomplete chunks", () => {
    expect(tryParseResponse(Buffer.from('{"status":"success"'))).toBeUndefined();
  });

  it("reassembles chunked responses", async () => {
    const socket = new FakeSocket();
    const pending = sendRequest(9876, { type: "get_scene_info", params: {} }, {
      socketFactory: () => socket as never,
    });
    socket.emit("data", Buffer.from('{"status":"success","res'));
    socket.emit("data", Buffer.from('ult":{"object_count":3}}'));
    await expect(pending).resolves.toEqual({ status: "success", result: { object_count: 3 } });
    expect(socket.destroyed).toBe(true);
  });
});
