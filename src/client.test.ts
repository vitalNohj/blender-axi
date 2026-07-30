import { describe, expect, it, vi } from "vitest";
import { requestAddon } from "./client.js";
import {
	AddonProtocolError,
	sendRequest,
} from "./protocol.js";

vi.mock("./protocol.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./protocol.js")>()),
	sendRequest: vi.fn(),
}));

describe("client", () => {
	it("does not report malformed protocol data as an unreachable listener", async () => {
		const protocolError = new AddonProtocolError(
			"Malformed Blender addon response: missing status",
		);
		vi.mocked(sendRequest).mockRejectedValueOnce(protocolError);

		let caught: unknown;
		try {
			await requestAddon(
				{ session: "test", port: 9876, stateDir: "." },
				"get_scene_info",
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(protocolError);
		expect(caught).not.toMatchObject({ code: "BLENDER_UNREACHABLE" });
	});
});
