import { basename } from "node:path";
import type { Arm, ToolEvent } from "./types.js";
import { readJsonl } from "./util.js";

export interface PolicyViolation {
  event_index: number;
  rule: string;
  detail: string;
}

const ALWAYS_FORBIDDEN = [
  /\b(curl|wget)\b/iu,
  /\b(playwright|puppeteer|selenium|osascript)\b/iu,
  /\b(socket|socat|netcat|nc\s)\b/iu,
  /\bhttps?:\/\//iu,
  /\/Users\//u,
  /\.claude|\.cursor|\.pi\/agent|\.config\/opencode/iu,
];

function eventText(event: ToolEvent): string {
  return JSON.stringify({ tool: event.tool, arguments: event.arguments, response: event.response });
}

function shellExecutable(event: ToolEvent): string | null {
  if (event.interface !== "shell") return null;
  const args = event.arguments as Record<string, unknown> | string | null;
  const command = typeof args === "string" ? args : typeof args?.command === "string" ? args.command : null;
  if (!command) return null;
  const first = command.trim().split(/\s+/u)[0];
  return first ? basename(first) : null;
}

export function detectPolicyViolations(arm: Arm, events: ToolEvent[]): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  events.forEach((event, eventIndex) => {
    const text = eventText(event);
    for (const pattern of ALWAYS_FORBIDDEN) {
      if (pattern.test(text)) violations.push({ event_index: eventIndex, rule: "common-deny", detail: `Matched ${pattern.source}` });
    }
    if (arm === "axi") {
      if (event.interface === "mcp" || /^mcp__/iu.test(event.tool)) {
        violations.push({ event_index: eventIndex, rule: "wrong-interface", detail: `AXI arm called MCP tool ${event.tool}` });
      }
      const executable = shellExecutable(event);
      if (event.interface === "shell" && executable !== null && executable !== "blender-axi") {
        violations.push({ event_index: eventIndex, rule: "shell-allowlist", detail: `AXI shell executable ${executable} is not allowed` });
      }
      if (/execute_blender_code|get_viewport_screenshot|blender-mcp|\buvx\b/iu.test(text)) {
        violations.push({ event_index: eventIndex, rule: "wrong-interface", detail: "AXI event references BlenderMCP surface" });
      }
    } else {
      if (event.interface === "shell") {
        violations.push({ event_index: eventIndex, rule: "wrong-interface", detail: "MCP arm used a shell interface" });
      }
      if (event.interface === "mcp" && !/^(mcp__)?blender(?:__|$)/iu.test(event.tool)) {
        violations.push({ event_index: eventIndex, rule: "mcp-allowlist", detail: `MCP tool ${event.tool} is not on pinned Blender server` });
      }
      if (/blender-axi|BLENDER_AXI_PORT/iu.test(text)) {
        violations.push({ event_index: eventIndex, rule: "wrong-interface", detail: "MCP event references blender-axi" });
      }
    }
  });
  return violations;
}

export async function checkTranscriptPolicy(arm: Arm, path: string): Promise<PolicyViolation[]> {
  return detectPolicyViolations(arm, await readJsonl<ToolEvent>(path));
}
