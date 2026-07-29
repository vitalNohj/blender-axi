import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createSkillMarkdown } from "../src/skill.js";

const target = resolve("skills/blender-axi/SKILL.md");
const expected = createSkillMarkdown();

if (process.argv.slice(2).includes("--check")) {
	let actual = "";
	try {
		actual = readFileSync(target, "utf8");
	} catch {}
	if (actual !== expected) {
		console.error(
			"skills/blender-axi/SKILL.md is stale; run `npm run build:skill`",
		);
		process.exitCode = 1;
	}
} else {
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, expected);
}
