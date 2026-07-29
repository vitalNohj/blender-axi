import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("argument parsing", () => {
	it("parses positionals, value flags, equals flags, and booleans", () => {
		const parsed = parseArgs(
			["build.py", "--save", "/tmp/a.blend", "--render=front,side", "--json"],
			["--save", "--render"],
		);
		expect(parsed.positionals).toEqual(["build.py"]);
		expect(Object.fromEntries(parsed.flags)).toEqual({
			"--save": "/tmp/a.blend",
			"--render": "front,side",
			"--json": true,
		});
	});

	it("rejects unknown and missing-value flags", () => {
		expect(() => parseArgs(["--wat"], [])).toThrow(/Unknown flag --wat/);
		expect(() => parseArgs(["--save"], ["--save"])).toThrow(/requires a value/);
	});
});
