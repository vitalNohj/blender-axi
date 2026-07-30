import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddonProtocolError } from "./protocol.js";
import { DeadPortError, requestAddon } from "./client.js";
import { launchBlender } from "./lifecycle.js";
import { main } from "./cli.js";

vi.mock("./client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./client.js")>()),
	requestAddon: vi.fn(),
}));

vi.mock("./lifecycle.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lifecycle.js")>()),
	launchBlender: vi.fn(),
}));

const PORT = 9876;
let savedPort: string | undefined;

beforeEach(() => {
	savedPort = process.env.BLENDER_AXI_PORT;
	process.env.BLENDER_AXI_PORT = String(PORT);
});

afterEach(() => {
	vi.resetAllMocks();
	process.exitCode = undefined;
	if (savedPort === undefined) delete process.env.BLENDER_AXI_PORT;
	else process.env.BLENDER_AXI_PORT = savedPort;
});

async function run(argv: string[]): Promise<string> {
	let output = "";
	await main({
		argv,
		stdout: { write: (chunk) => void (output += chunk) },
	});
	return output;
}

describe("listener protocol errors", () => {
	it("does not report ping as healthy for a malformed response", async () => {
		vi.mocked(requestAddon).mockRejectedValueOnce(
			new AddonProtocolError(
				"Malformed Blender addon response: success response missing result",
			),
		);

		const output = await run(["ping"]);

		expect(process.exitCode).toBe(1);
		expect(output).toContain("success response missing result");
		expect(output).not.toContain("healthy");
		expect(output).not.toContain("BLENDER_UNREACHABLE");
	});

	it("rethrows a start protocol error without launching", async () => {
		vi.mocked(requestAddon).mockRejectedValueOnce(
			new AddonProtocolError(
				"Malformed Blender addon response: unknown status",
			),
		);

		const output = await run(["start"]);

		expect(process.exitCode).toBe(1);
		expect(output).toContain("Malformed Blender addon response");
		expect(launchBlender).not.toHaveBeenCalled();
	});

	it("launches start only after a dead-port error", async () => {
		vi.mocked(requestAddon).mockRejectedValueOnce(
			new DeadPortError("default", PORT),
		);
		vi.mocked(launchBlender).mockResolvedValueOnce(4321);

		const output = await run(["start", "--json"]);

		expect(JSON.parse(output)).toEqual({
			ok: true,
			status: "started",
			pid: 4321,
			session: "default",
			port: PORT,
		});
		expect(launchBlender).toHaveBeenCalledOnce();
	});

	it("keeps the already-running start response unchanged", async () => {
		vi.mocked(requestAddon).mockResolvedValueOnce({ object_count: 1 });

		const output = await run(["start", "--json"]);

		expect(JSON.parse(output)).toEqual({
			ok: true,
			status: "already-running",
			session: "default",
			port: PORT,
		});
		expect(launchBlender).not.toHaveBeenCalled();
	});
});
