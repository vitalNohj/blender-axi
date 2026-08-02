import { describe, expect, it } from "vitest";
import { generatePlan, generatePreflightPlan } from "../src/plan.js";
import { resolve } from "node:path";

const root = resolve("benchmark");

describe("seed plans", () => {
	it("is deterministic and gives opposite P1/P5 preflight order", async () => {
		const first = await generatePreflightPlan(root, 4103);
		const second = await generatePreflightPlan(root, 4103);
		expect(first).toEqual(second);
		expect(first.cells).toHaveLength(4);
		const starts = first.cells.filter((cell) => cell.order_in_pair === 1);
		expect(starts.map((cell) => cell.task_id)).toEqual(["P1", "P5"]);
		expect(starts[0]!.sequence).not.toBe(starts[1]!.sequence);
		expect(new Set(first.cells.map((cell) => cell.cell_id)).size).toBe(4);
	});

	it("counterbalances and archives unique pilot cells", async () => {
		const plan = await generatePlan(root, {
			kind: "pilot",
			taskIds: ["P1", "P2"],
			replicates: 4,
			seed: 8,
		});
		expect(plan.cells).toHaveLength(16);
		expect(new Set(plan.cells.map((cell) => cell.cell_id)).size).toBe(16);
		for (const task of ["P1", "P2"]) {
			const sequences = plan.cells
				.filter((cell) => cell.task_id === task && cell.order_in_pair === 1)
				.map((cell) => cell.sequence);
			expect(sequences.filter((value) => value === "AXI_MCP")).toHaveLength(2);
			expect(sequences.filter((value) => value === "MCP_AXI")).toHaveLength(2);
		}
	});
});
