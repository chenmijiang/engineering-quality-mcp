import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Config = {
  cwd: string;
  /** Process startup directory; independent of the default session cwd. */
  projectCwd: string;
  agentDir: string;
  /** Directory for persisted session transcripts. */
  sessionDir: string;
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
  const { EQ_PROVIDER: provider, EQ_MODEL: id } = env;
  if (!provider !== !id) throw new Error("Set EQ_PROVIDER and EQ_MODEL together, or omit both");
  const projectCwd = process.cwd();
  const agentDir = resolve(env.EQ_AGENT_DIR ?? join(env.HOME ?? homedir(), ".eq", "agent"));
  return {
    cwd: resolve(env.EQ_CWD ?? projectCwd),
    projectCwd,
    agentDir,
    sessionDir: resolve(env.EQ_SESSION_DIR ?? join(agentDir, "sessions")),
    model: provider && id ? { provider, id } : undefined,
    runTimeoutMs: positiveInteger(env, "EQ_RUN_TIMEOUT_MS", 300_000),
    idleTimeoutMs: positiveInteger(env, "EQ_IDLE_TIMEOUT_MS", 1_800_000),
    maxSessions: positiveInteger(env, "EQ_MAX_SESSIONS", 8),
  };
}
