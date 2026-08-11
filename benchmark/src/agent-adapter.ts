import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, AgentResult } from "./runner.js";
import type { AttemptRecord, ToolEvent } from "./types.js";
import { registerSpawnedProcess } from "./isolation.js";
import { extractToolEvents } from "./transcript.js";
import { readJson, redact } from "./util.js";

// The provider wrapper is a process tree (wrapper shell -> agent CLI -> pinned
// MCP server -> Blender). Signalling only the direct child leaves the rest of
// the tree alive, which is how the first live run orphaned a BlenderMCP server
// still holding port 9876. Every provider process is therefore started as its
// own process-group leader and torn down by group, with SIGKILL escalation, so
// nothing outlives the cell on success, failure, interrupt, or timeout.
const TERMINATION_GRACE_MILLISECONDS = 5_000;

interface CommandConfig {
	protocol: "jsonl-stdout-v1";
	executable: string | null;
	common_args: string[];
	arm_args: Record<"axi" | "mcp", string[]>;
	required_fresh_session_args: string[];
	required_disable_ambient_args: string[];
	credential_environment_variables: string[];
}
interface ProviderEnvelope {
	type?: string;
	answer?: string;
	usage?: Partial<AttemptRecord["usage"] & { agent_turns: number }>;
	cache?: Partial<AttemptRecord["cache"]>;
}

// A cell only measures the agent if the provider actually answered. The first
// live rerun recorded a cell as valid/wrong_artifact after four consecutive
// provider errors (502, overloaded) because the wrapper still emitted a
// well-formed empty envelope and exited 0, so nothing threw. The terminal
// failure signal is present in the record stream, so read it directly: an
// exhausted retry chain, or a run whose every assistant turn errored without
// producing content, is infrastructure failure rather than a wrong answer.
export function providerFailure(
	records: unknown[],
): { reason: string } | null {
	const objects = records.filter(
		(record): record is Record<string, unknown> =>
			Boolean(record) && typeof record === "object",
	);
	const exhausted = objects.find(
		(record) => record.type === "auto_retry_end" && record.success === false,
	);
	if (exhausted)
		return {
			reason:
				typeof exhausted.finalError === "string"
					? exhausted.finalError
					: "provider retries exhausted",
		};
	const assistantTurns = objects
		.filter((record) => record.type === "message_end")
		.map((record) => record.message)
		.filter(
			(message): message is Record<string, unknown> =>
				Boolean(message) &&
				typeof message === "object" &&
				(message as Record<string, unknown>).role === "assistant",
		);
	if (!assistantTurns.length) return null;
	const everyTurnFailed = assistantTurns.every((message) => {
		const content = message.content;
		const hasContent = Array.isArray(content) && content.length > 0;
		return message.stopReason === "error" && !hasContent;
	});
	return everyTurnFailed
		? { reason: "every provider turn ended in an error with no response" }
		: null;
}

export class CommandAgentAdapter implements AgentAdapter {
	constructor(private readonly benchmarkRoot: string) {}

	async run(input: Parameters<AgentAdapter["run"]>[0]): Promise<AgentResult> {
		const config = await readJson<CommandConfig>(
			join(this.benchmarkRoot, "config", "agent-command.json"),
		);
		if (!config.executable)
			throw new Error(
				"config/agent-command.json has no executable; live execution is not frozen",
			);
		if (
			!config.required_fresh_session_args.length ||
			!config.required_disable_ambient_args.length
		)
			throw new Error(
				"Provider command must freeze fresh-session and disable-ambient arguments",
			);
		const prompt = `${input.baseInstructions}\n\n${input.conditionInstructions}\n\nTask:\n${input.task.prompt}\n`;
		await writeFile(join(input.runRoot, "transcript", "prompt.txt"), prompt, {
			mode: 0o600,
		});
		const args = [
			...config.common_args,
			...config.required_fresh_session_args,
			...config.required_disable_ambient_args,
			...config.arm_args[input.cell.arm],
		];
		const child = spawn(config.executable, args, {
			cwd: input.runRoot,
			env: input.environment,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		const agentPid = child.pid;
		const killGroup = (signal: NodeJS.Signals): void => {
			if (agentPid === undefined) return;
			try {
				process.kill(-agentPid, signal);
			} catch {
				// The group is already gone; nothing is left to reap.
			}
		};
		const completion = new Promise<AgentResult>((resolvePromise, reject) => {
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let aborted = input.signal?.aborted ?? false;
			let escalation: NodeJS.Timeout | null = null;
			let timer: NodeJS.Timeout | null = null;
			const cleanup = (): void => {
				if (timer) clearTimeout(timer);
				if (escalation) clearTimeout(escalation);
				input.signal?.removeEventListener("abort", onAbort);
			};
			const terminate = (): void => {
				killGroup("SIGTERM");
				escalation ??= setTimeout(
					() => killGroup("SIGKILL"),
					TERMINATION_GRACE_MILLISECONDS,
				);
			};
			const onAbort = (): void => {
				aborted = true;
				terminate();
			};
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => (stdout += chunk));
			child.stderr.on("data", (chunk: string) => (stderr += chunk));
			child.once("error", (error) => {
				cleanup();
				reject(error);
			});
			child.stdin.end(prompt);
			input.signal?.addEventListener("abort", onAbort, { once: true });
			if (aborted) terminate();
			timer = setTimeout(() => {
				timedOut = true;
				terminate();
			}, input.task.timeout_seconds * 1000);
			child.once("exit", async (code, signal) => {
				cleanup();
				// The group leader has exited; sweep any surviving descendant so no
				// wrapper, MCP server, or Blender process outlives the cell.
				killGroup("SIGKILL");
				const secrets = config.credential_environment_variables
					.map((name) => input.environment[name])
					.filter((value): value is string => Boolean(value));
				await writeFile(
					join(input.runRoot, "logs", "agent.stdout.log"),
					String(redact(stdout, secrets)),
					{ mode: 0o600 },
				);
				await writeFile(
					join(input.runRoot, "logs", "agent.stderr.log"),
					String(redact(stderr, secrets)),
					{ mode: 0o600 },
				);
				const lines = stdout.split(/\r?\n/u).filter(Boolean);
				const records: unknown[] = [];
				for (let index = 0; index < lines.length; index += 1) {
					try {
						records.push(JSON.parse(lines[index]!) as unknown);
					} catch (error) {
						reject(
							new Error(
								`Provider adapter emitted invalid JSONL at line ${index + 1}: ${(error as Error).message}`,
							),
						);
						return;
					}
				}
				const envelopes = records.filter((record): record is ProviderEnvelope =>
					Boolean(record && typeof record === "object"),
				);
				const answer =
					[...envelopes]
						.reverse()
						.find((record) => typeof record.answer === "string")?.answer ?? "";
				const usage =
					[...envelopes].reverse().find((record) => record.usage)?.usage ?? {};
				const cache =
					[...envelopes].reverse().find((record) => record.cache)?.cache ?? {};
				const events: ToolEvent[] = extractToolEvents(records);
				if (aborted) {
					reject(input.signal?.reason ?? new Error("Agent run aborted"));
					return;
				}
				if (!timedOut && (code !== 0 || signal !== null)) {
					reject(
						new Error(
							`Provider adapter exited with ${signal ?? `code ${String(code)}`}: ${String(redact(stderr.slice(-1000), secrets))}`,
						),
					);
					return;
				}
				if (agentPid === undefined) {
					reject(new Error("Provider adapter failed to start"));
					return;
				}
				const failure = timedOut ? null : providerFailure(records);
				if (failure) {
					reject(
						new Error(
							"Provider never produced a response: " +
								String(redact(failure.reason, secrets)),
						),
					);
					return;
				}
				resolvePromise({
					answer: timedOut ? `${answer}\n[benchmark timeout]` : answer,
					transcript: `${stdout}\n${stderr}`,
					providerRecords: records,
					events,
					usage,
					cache,
					agentTurns: Number(usage.agent_turns ?? 0),
					retries: 0,
					agentPid,
					timedOut,
				});
			});
		});
		void completion.catch(() => undefined);
		if (agentPid === undefined) return await completion;
		await registerSpawnedProcess(
			join(input.runRoot, "owned-processes.json"),
			child,
			{
				role: "agent",
				port: null,
				started_at: new Date().toISOString(),
				executable: config.executable,
				run_id: input.cell.cell_id,
				process_group: true,
			},
		);
		return await completion;
	}
}
