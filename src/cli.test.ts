import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.js";

afterEach(() => { process.exitCode = undefined; });

describe("cli errors", () => {
  it("formats usage errors with exit code 2", async () => {
    let output = "";
    await main({ argv: ["render", "north"], stdout: { write: (chunk) => { output += chunk; } } });
    expect(process.exitCode).toBe(2);
    expect(output).toContain("Invalid render angles");
    expect(output).toContain("front,side,back,tq");
  });

  it("shows command help without connecting", async () => {
    let output = "";
    await main({ argv: ["exec", "--help"], stdout: { write: (chunk) => { output += chunk; } } });
    expect(output).toContain("guaranteed traceback");
    expect(process.exitCode).toBeUndefined();
  });
});
