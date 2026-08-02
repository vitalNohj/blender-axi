import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, AgentResult } from "./runner.js";
import type { AttemptRecord, ToolEvent } from "./types.js";
import { extractToolEvents } from "./transcript.js";
import { readJson } from "./util.js";

interface CommandConfig {
  protocol: "jsonl-stdout-v1";
  executable: string | null;
  common_args: string[];
  arm_args: Record<"axi" | "mcp", string[]>;
  required_fresh_session_args: string[];
  required_disable_ambient_args: string[];
}
interface ProviderEnvelope {
  type?: string;
  answer?: string;
  usage?: Partial<AttemptRecord["usage"] & { agent_turns: number }>;
  cache?: Partial<AttemptRecord["cache"]>;
}

export class CommandAgentAdapter implements AgentAdapter {
  constructor(private readonly benchmarkRoot: string) {}

  async run(input: Parameters<AgentAdapter["run"]>[0]): Promise<AgentResult> {
    const config = await readJson<CommandConfig>(join(this.benchmarkRoot, "config", "agent-command.json"));
    if (!config.executable) throw new Error("config/agent-command.json has no executable; live execution is not frozen");
    if (!config.required_fresh_session_args.length || !config.required_disable_ambient_args.length) throw new Error("Provider command must freeze fresh-session and disable-ambient arguments");
    const prompt = `${input.baseInstructions}\n\n${input.conditionInstructions}\n\nTask:\n${input.task.prompt}\n`;
    await writeFile(join(input.runRoot, "transcript", "prompt.txt"), prompt, { mode: 0o600 });
    const args = [...config.common_args, ...config.required_fresh_session_args, ...config.required_disable_ambient_args, ...config.arm_args[input.cell.arm]];
    const started = process.hrtime.bigint();
    return await new Promise<AgentResult>((resolvePromise, reject) => {
      const child = spawn(config.executable!, args, { cwd: input.runRoot, env: input.environment, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.stdin.end(prompt);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, input.task.timeout_seconds * 1000);
      child.once("exit", async (code, signal) => {
        clearTimeout(timer);
        await writeFile(join(input.runRoot, "logs", "agent.stdout.log"), stdout, { mode: 0o600 });
        await writeFile(join(input.runRoot, "logs", "agent.stderr.log"), stderr, { mode: 0o600 });
        const lines = stdout.split(/\r?\n/u).filter(Boolean);
        const records: unknown[] = [];
        for (let index = 0; index < lines.length; index += 1) {
          try {
            records.push(JSON.parse(lines[index]!) as unknown);
          } catch (error) {
            reject(new Error(`Provider adapter emitted invalid JSONL at line ${index + 1}: ${(error as Error).message}`));
            return;
          }
        }
        const envelopes = records.filter((record): record is ProviderEnvelope => Boolean(record && typeof record === "object"));
        const answer = [...envelopes].reverse().find((record) => typeof record.answer === "string")?.answer ?? "";
        const usage = [...envelopes].reverse().find((record) => record.usage)?.usage ?? {};
        const cache = [...envelopes].reverse().find((record) => record.cache)?.cache ?? {};
        const events: ToolEvent[] = extractToolEvents(records);
        if (timedOut) usage.api_cost_usd ??= null;
        resolvePromise({
          answer: timedOut ? `${answer}\n[benchmark timeout]` : answer,
          transcript: `${stdout}\n${stderr}`,
          providerRecords: records,
          events,
          usage,
          cache,
          agentTurns: Number(usage.agent_turns ?? 0),
          retries: 0,
          agentPid: child.pid ?? null,
        });
        void code;
        void signal;
        void started;
      });
    });
  }
}
