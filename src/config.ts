import { resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Config = {
  cwd: string;
  agentDir: string;
  model?: { provider: string; id: string };
  runTimeoutMs: number;
  idleTimeoutMs: number;
  maxSessions: number;
};

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer <= 2147483647`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { PI_PROVIDER: provider, PI_MODEL: id } = env;
  if (!provider !== !id) throw new Error("Set PI_PROVIDER and PI_MODEL together, or omit both");
  return {
    cwd: resolve(env.PI_CWD ?? process.cwd()),
    agentDir: resolve(env.PI_AGENT_DIR ?? getAgentDir()),
    model: provider && id ? { provider, id } : undefined,
    runTimeoutMs: positiveInteger(env, "PI_RUN_TIMEOUT_MS", 300_000),
    idleTimeoutMs: positiveInteger(env, "PI_IDLE_TIMEOUT_MS", 1_800_000),
    maxSessions: positiveInteger(env, "PI_MAX_SESSIONS", 8),
  };
}
