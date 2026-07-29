import { AxiError } from "axi-sdk-js";
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

	it("rejects unknown flags with a complete valid-flag hint", () => {
		try {
			parseArgs(["--wat"], ["--save"]);
			expect.fail("expected usage error");
		} catch (error) {
			expect(error).toBeInstanceOf(AxiError);
			expect((error as AxiError).suggestions).toEqual([
				"Valid flags: --save, --json, --launch, --help",
			]);
		}
	});

	it("rejects missing value flags", () => {
		expect(() => parseArgs(["--save"], ["--save"])).toThrow(/requires a value/);
	});
});
