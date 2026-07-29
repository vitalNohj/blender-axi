import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SESSION_NAME = "default";
export const DEFAULT_BASE_PORT = 9876;
const SESSION_PORT_RANGE = 1000;
const STATE_DIR_NAME = ".blender-axi";

export function resolveSessionName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BLENDER_AXI_SESSION?.trim();
  const name = raw || DEFAULT_SESSION_NAME;
  validateSessionName(name);
  return name;
}

export function validateSessionName(name: string): void {
  if (name === DEFAULT_SESSION_NAME) return;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(`Invalid BLENDER_AXI_SESSION "${name}": use 1-64 chars from [A-Za-z0-9._-]`);
  }
  if (/^\.+$/.test(name)) {
    throw new Error(`Invalid BLENDER_AXI_SESSION "${name}": a name made only of dots would collapse onto the default session's state directory`);
  }
}

export function defaultPortForSession(name: string): number {
  if (name === DEFAULT_SESSION_NAME) return DEFAULT_BASE_PORT;
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return DEFAULT_BASE_PORT + (Math.abs(hash) % SESSION_PORT_RANGE) + 1;
}

export function resolveSessionPort(
  name = resolveSessionName(),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = env.BLENDER_AXI_PORT;
  if (explicit !== undefined) {
    if (!/^\d+$/.test(explicit)) {
      throw new Error(`Invalid BLENDER_AXI_PORT "${explicit}": use an integer from 1 to 65535`);
    }
    const parsed = Number(explicit);
    if (parsed < 1 || parsed > 65535) {
      throw new Error(`Invalid BLENDER_AXI_PORT "${explicit}": use an integer from 1 to 65535`);
    }
    return parsed;
  }
  return defaultPortForSession(name);
}

export function resolveSessionStateDir(
  name = resolveSessionName(),
  home = homedir(),
): string {
  const base = join(home, STATE_DIR_NAME);
  return name === DEFAULT_SESSION_NAME ? base : join(base, "sessions", name);
}

export function resolveSessionPidFile(name = resolveSessionName(), home = homedir()): string {
  return join(resolveSessionStateDir(name, home), "blender.pid");
}
