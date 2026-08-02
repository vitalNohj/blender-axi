import type { Arm, PlanCell, SeedPlan } from "./types.js";
import { fixtureManifestHash } from "./fixtures.js";
import { mulberry32, shuffle, writeJsonAtomic } from "./util.js";

interface PlanOptions {
	kind: SeedPlan["kind"];
	taskIds: string[];
	replicates: number;
	seed: number;
	cacheRegime?: "cold" | "warm";
}

export async function generatePlan(
	benchmarkRoot: string,
	options: PlanOptions,
): Promise<SeedPlan> {
	const random = mulberry32(options.seed);
	const blocks: Array<{
		taskId: string;
		replicate: number;
		sequence: "AXI_MCP" | "MCP_AXI";
		seed: number;
	}> = [];
	for (const taskId of options.taskIds) {
		for (let replicate = 1; replicate <= options.replicates; replicate += 1) {
			const parity = (replicate + options.taskIds.indexOf(taskId)) % 2;
			blocks.push({
				taskId,
				replicate,
				sequence: parity === 0 ? "AXI_MCP" : "MCP_AXI",
				seed: Math.floor(random() * 2_147_483_647),
			});
		}
	}
	const cells: PlanCell[] = [];
	for (const block of shuffle(blocks, random)) {
		const arms: Arm[] =
			block.sequence === "AXI_MCP" ? ["axi", "mcp"] : ["mcp", "axi"];
		const pairId = `${block.taskId}-seed-${block.seed}-r${String(block.replicate).padStart(2, "0")}`;
		arms.forEach((arm, index) =>
			cells.push({
				cell_id: `${pairId}-${arm}`,
				pair_id: pairId,
				task_id: block.taskId,
				replicate: block.replicate,
				arm,
				order_in_pair: (index + 1) as 1 | 2,
				sequence: block.sequence,
				seed: block.seed,
				cache_regime: options.cacheRegime ?? "cold",
				replacement_for: null,
			}),
		);
	}
	return {
		schema_version: "1.0.0",
		study_id: "blender-axi-vs-blendermcp-1",
		kind: options.kind,
		created_at: new Date(0).toISOString(),
		randomization_seed: options.seed,
		manifest_sha256: await fixtureManifestHash(benchmarkRoot),
		cells,
	};
}

export async function generatePreflightPlan(
	benchmarkRoot: string,
	seed = 4103,
): Promise<SeedPlan> {
	const random = mulberry32(seed);
	const p1Sequence: "AXI_MCP" | "MCP_AXI" =
		random() < 0.5 ? "AXI_MCP" : "MCP_AXI";
	const p5Sequence = p1Sequence === "AXI_MCP" ? "MCP_AXI" : "AXI_MCP";
	const cells: PlanCell[] = [];
	for (const [taskId, sequence] of [
		["P1", p1Sequence],
		["P5", p5Sequence],
	] as const) {
		const pairSeed = Math.floor(random() * 2_147_483_647);
		const pairId = `${taskId}-preflight-${pairSeed}`;
		const arms: Arm[] =
			sequence === "AXI_MCP" ? ["axi", "mcp"] : ["mcp", "axi"];
		arms.forEach((arm, index) =>
			cells.push({
				cell_id: `${pairId}-${arm}`,
				pair_id: pairId,
				task_id: taskId,
				replicate: 1,
				arm,
				order_in_pair: (index + 1) as 1 | 2,
				sequence,
				seed: pairSeed,
				cache_regime: "cold",
				replacement_for: null,
			}),
		);
	}
	return {
		schema_version: "1.0.0",
		study_id: "blender-axi-vs-blendermcp-1",
		kind: "preflight",
		created_at: new Date(0).toISOString(),
		randomization_seed: seed,
		manifest_sha256: await fixtureManifestHash(benchmarkRoot),
		cells,
	};
}

export async function savePlan(path: string, plan: SeedPlan): Promise<void> {
	await writeJsonAtomic(path, plan);
}
