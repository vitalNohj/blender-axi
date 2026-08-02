import { chmod, cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { TaskManifest } from "./types.js";
import {
	readJson,
	sha256,
	sha256File,
	stableJson,
	writeJsonAtomic,
} from "./util.js";

export const TASK_IDS = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
const ARTIFACT_NAMES: Record<string, string> = {
	P1: "micro.blend",
	P2: "edit.blend",
	P3: "prop-empty.blend",
	P4: "enemy-empty.blend",
	P5: "failure.blend",
	P6: "unity-empty.blend",
};

export interface FixtureIndexEntry {
	task_id: string;
	task_version: string;
	contract_path: string;
	contract_sha256: string;
	artifact_path: string;
	artifact_sha256: string;
	semantic_sha256: string;
	extra_files: Array<{ path: string; sha256: string }>;
}

export interface FixtureIndex {
	schema_version: "1.0.0";
	generated_at: string;
	blender_version: string;
	blender_executable_sha256: string;
	entries: FixtureIndexEntry[];
	manifest_sha256: string;
}

async function run(
	command: string,
	args: string[],
): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise({ stdout, stderr });
			else
				reject(
					new Error(
						`${basename(command)} failed (${signal ?? code}): ${stderr.slice(-2000)}`,
					),
				);
		});
	});
}

export async function loadTasks(
	benchmarkRoot: string,
): Promise<TaskManifest[]> {
	const taskRoot = join(benchmarkRoot, "fixtures", "tasks");
	const names = (await readdir(taskRoot))
		.filter((name) => /^P[1-6]\.json$/u.test(name))
		.sort();
	return await Promise.all(
		names.map((name) => readJson<TaskManifest>(join(taskRoot, name))),
	);
}

export async function fixtureManifestHash(
	benchmarkRoot: string,
): Promise<string> {
	const tasks = await loadTasks(benchmarkRoot);
	return sha256(stableJson(tasks));
}

export async function createFixtures(
	benchmarkRoot: string,
	blenderExecutable: string,
	options: { force?: boolean } = {},
): Promise<FixtureIndex> {
	const root = resolve(benchmarkRoot);
	const generated = join(root, "fixtures", "generated");
	if (options.force) await rm(generated, { recursive: true, force: true });
	await mkdir(generated, { recursive: true });
	const tasks = await loadTasks(root);
	const entries: FixtureIndexEntry[] = [];

	for (const task of tasks) {
		const artifactName = ARTIFACT_NAMES[task.id];
		if (!artifactName)
			throw new Error(`No fixture artifact mapping for ${task.id}`);
		const taskDirectory = join(generated, task.id);
		await mkdir(taskDirectory, { recursive: true });
		const artifactPath = join(taskDirectory, artifactName);
		const contractPath = join(root, task.fixture.contract);
		await run(blenderExecutable, [
			"--background",
			"--factory-startup",
			"--python",
			join(root, "fixtures", "generate_fixture.py"),
			"--",
			"--spec",
			contractPath,
			"--output",
			artifactPath,
			"--fixture-root",
			join(root, "fixtures"),
		]);
		const factsPath = join(generated, `${task.id}.facts.json`);
		await run(blenderExecutable, [
			"--background",
			"--factory-startup",
			artifactPath,
			"--python",
			join(root, "fixtures", "inspect_scene.py"),
			"--",
			"--output",
			factsPath,
			"--allowed-root",
			generated,
		]);
		const facts = await readJson<Record<string, unknown>>(factsPath);
		delete facts.file;
		const semanticHash = sha256(stableJson(facts));
		await chmod(artifactPath, 0o444);
		const extras: Array<{ path: string; sha256: string }> = [];
		if (task.id === "P5") {
			const scriptPath = join(taskDirectory, "faulty_build.py");
			await chmod(scriptPath, 0o444);
			extras.push({
				path: `generated/P5/faulty_build.py`,
				sha256: await sha256File(scriptPath),
			});
		}
		const artifactHash = await sha256File(artifactPath);
		if (
			task.fixture.immutable_sha256 !== "TO_BE_FROZEN" &&
			task.fixture.immutable_sha256 !== semanticHash
		) {
			throw new Error(
				`${task.id} semantic fixture hash ${semanticHash} differs from frozen ${task.fixture.immutable_sha256}`,
			);
		}
		entries.push({
			task_id: task.id,
			task_version: task.version,
			contract_path: task.fixture.contract,
			contract_sha256: await sha256File(contractPath),
			artifact_path: `generated/${task.id}/${artifactName}`,
			artifact_sha256: artifactHash,
			semantic_sha256: semanticHash,
			extra_files: extras,
		});
	}

	const version = await run(blenderExecutable, ["--version"]);
	const indexWithoutHash = {
		schema_version: "1.0.0" as const,
		generated_at: new Date().toISOString(),
		blender_version: version.stdout.split(/\r?\n/u)[0] ?? "unknown",
		blender_executable_sha256: await sha256File(blenderExecutable),
		entries,
	};
	const index: FixtureIndex = {
		...indexWithoutHash,
		manifest_sha256: sha256(stableJson(indexWithoutHash)),
	};
	await writeJsonAtomic(join(root, "fixtures", "manifest.json"), index);
	return index;
}

export async function verifyFixtures(
	benchmarkRoot: string,
): Promise<{ ok: boolean; errors: string[]; index: FixtureIndex }> {
	const root = resolve(benchmarkRoot);
	const index = await readJson<FixtureIndex>(
		join(root, "fixtures", "manifest.json"),
	);
	const errors: string[] = [];
	const expectedManifestHash = sha256(
		stableJson({
			schema_version: index.schema_version,
			generated_at: index.generated_at,
			blender_version: index.blender_version,
			blender_executable_sha256: index.blender_executable_sha256,
			entries: index.entries,
		}),
	);
	if (index.manifest_sha256 !== expectedManifestHash)
		errors.push("fixture manifest hash mismatch");
	const tasks = new Map((await loadTasks(root)).map((task) => [task.id, task]));
	for (const entry of index.entries) {
		const artifact = join(
			root,
			"fixtures",
			entry.artifact_path.replace(/^generated\//u, "generated/"),
		);
		try {
			if ((await sha256File(artifact)) !== entry.artifact_sha256)
				errors.push(`${entry.task_id} artifact hash mismatch`);
			const task = tasks.get(entry.task_id);
			if (!task || task.fixture.immutable_sha256 !== entry.semantic_sha256)
				errors.push(`${entry.task_id} task immutable fixture hash mismatch`);
			if (
				(await sha256File(join(root, entry.contract_path))) !==
				entry.contract_sha256
			)
				errors.push(`${entry.task_id} contract hash mismatch`);
			for (const extra of entry.extra_files) {
				const path = join(
					root,
					"fixtures",
					extra.path.replace(/^generated\//u, "generated/"),
				);
				if ((await sha256File(path)) !== extra.sha256)
					errors.push(
						`${entry.task_id} extra file hash mismatch: ${extra.path}`,
					);
			}
		} catch (error) {
			errors.push(
				`${entry.task_id} fixture missing: ${(error as Error).message}`,
			);
		}
	}
	return { ok: errors.length === 0, errors, index };
}

export async function materializeReadOnlyFixture(
	benchmarkRoot: string,
	taskId: string,
	destination: string,
): Promise<string> {
	const verification = await verifyFixtures(benchmarkRoot);
	if (!verification.ok)
		throw new Error(
			`Fixture verification failed: ${verification.errors.join("; ")}`,
		);
	const entry = verification.index.entries.find(
		(candidate) => candidate.task_id === taskId,
	);
	if (!entry) throw new Error(`Unknown task fixture: ${taskId}`);
	const sourceDirectory = dirname(
		join(benchmarkRoot, "fixtures", entry.artifact_path),
	);
	await mkdir(destination, { recursive: true });
	await cp(sourceDirectory, destination, { recursive: true, force: false });
	const files = await readdir(destination);
	for (const name of files) await chmod(join(destination, name), 0o444);
	await chmod(destination, 0o555);
	return entry.artifact_sha256;
}

export async function fixtureBytes(
	benchmarkRoot: string,
	taskId: string,
): Promise<Uint8Array> {
	const index = await readJson<FixtureIndex>(
		join(benchmarkRoot, "fixtures", "manifest.json"),
	);
	const entry = index.entries.find((candidate) => candidate.task_id === taskId);
	if (!entry) throw new Error(`Unknown fixture ${taskId}`);
	return await readFile(join(benchmarkRoot, "fixtures", entry.artifact_path));
}
