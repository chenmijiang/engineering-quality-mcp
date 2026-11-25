import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadConfig } from "@/config";
import { createReadOnlySettings } from "@/runtimes/pi/settings";

let root: string;
let project: string;
let agentDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qa-settings-"));
  project = join(root, "project");
  agentDir = join(root, "home", ".qa", "agent");
  await mkdir(join(project, ".qa"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("configuration separates startup project, session cwd and application agent directory", () => {
  const before = { ...process.env };
  const home = join(root, "home");
  const env = { HOME: home, QA_CWD: project, PI_CODING_AGENT_DIR: join(root, "decoy") };
  expect(loadConfig(env)).toMatchObject({
    cwd: project,
    projectCwd: process.cwd(),
    agentDir: join(home, ".qa", "agent"),
    sessionDir: join(home, ".qa", "agent", "sessions"),
  });
  expect(loadConfig({ ...env, QA_AGENT_DIR: agentDir })).toMatchObject({
    agentDir,
    sessionDir: join(agentDir, "sessions"),
  });
  expect(loadConfig({ ...env, QA_SESSION_DIR: join(root, "transcripts") })).toMatchObject({
    sessionDir: join(root, "transcripts"),
  });
  expect(process.env).toEqual(before);
});

test("QA environment variables configure the model and session limits", () => {
  expect(
    loadConfig({
      QA_PROVIDER: "fake",
      QA_MODEL: "test-model",
      QA_RUN_TIMEOUT_MS: "1234",
      QA_IDLE_TIMEOUT_MS: "5678",
      QA_MAX_SESSIONS: "3",
    }),
  ).toMatchObject({
    model: { provider: "fake", id: "test-model" },
    runTimeoutMs: 1234,
    idleTimeoutMs: 5678,
    maxSessions: 3,
  });
});

test("legacy PI application variables do not configure the server", () => {
  const home = join(root, "home");
  expect(
    loadConfig({
      HOME: home,
      PI_AGENT_DIR: agentDir,
      PI_CWD: project,
      PI_PROVIDER: "fake",
      PI_MODEL: "test-model",
      PI_RUN_TIMEOUT_MS: "1",
      PI_IDLE_TIMEOUT_MS: "1",
      PI_MAX_SESSIONS: "1",
    }),
  ).toMatchObject({
    cwd: process.cwd(),
    agentDir: join(home, ".qa", "agent"),
    model: undefined,
    runTimeoutMs: 300_000,
    idleTimeoutMs: 1_800_000,
    maxSessions: 8,
  });
});

test.each([{ QA_PROVIDER: "fake" }, { QA_MODEL: "test-model" }])(
  "QA provider and model must be configured together",
  (env) => {
    expect(() => loadConfig(env)).toThrow("Set QA_PROVIDER and QA_MODEL together, or omit both");
  },
);

describe.each([
  ["QA_RUN_TIMEOUT_MS", "runTimeoutMs"],
  ["QA_IDLE_TIMEOUT_MS", "idleTimeoutMs"],
  ["QA_MAX_SESSIONS", "maxSessions"],
] as const)("%s", (name, field) => {
  test.each(["", "0", "-1", "1.5", "not-a-number", "Infinity", "2147483648"])(
    "rejects invalid positive integer %j",
    (value) => {
      expect(() => loadConfig({ [name]: value })).toThrow(
        `${name} must be a positive integer <= 2147483647`,
      );
    },
  );

  test.each(["1", "2147483647"])("accepts boundary value %s", (value) => {
    expect(loadConfig({ [name]: value })[field]).toBe(Number(value));
  });
});

test("missing settings use SDK defaults without creating directories or lock files", async () => {
  const missingAgentDir = join(root, "missing-agent");
  const missingProject = join(root, "missing-project");
  const manager = createReadOnlySettings(missingProject, missingAgentDir);
  expect(manager.getSettings()).toEqual({});
  expect(manager.getCompactionEnabled()).toBe(true);
  expect(manager.drainErrors()).toEqual([]);
  expect(await readdir(root)).toEqual(expect.arrayContaining(["home", "project"]));
  await expect(readFile(join(missingAgentDir, "settings.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readdir(missingProject)).rejects.toMatchObject({ code: "ENOENT" });
});

test("SDK migration and nested project-over-global merging work without rewriting files", async () => {
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(project, ".qa", "settings.json");
  const global =
    '\uFEFF{"defaultProvider":"fake","defaultModel":"global-model","queueMode":"all","websockets":true,"compaction":{"enabled":true,"reserveTokens":1234}}';
  const local = '{"defaultModel":"project-model","compaction":{"enabled":false}}';
  await writeFile(globalPath, global);
  await writeFile(projectPath, local);
  const manager = createReadOnlySettings(project, agentDir);
  expect(manager.getSettings()).toMatchObject({
    defaultProvider: "fake",
    defaultModel: "project-model",
    steeringMode: "all",
    transport: "websocket",
    compaction: { enabled: false, reserveTokens: 1234 },
  });
  expect(manager.getSettings()).not.toHaveProperty("queueMode");
  expect(await readFile(globalPath, "utf8")).toBe(global);
  expect(await readFile(projectPath, "utf8")).toBe(local);
  expect(await readdir(agentDir)).toEqual(["settings.json"]);
  expect(await readdir(join(project, ".qa"))).toEqual(["settings.json"]);
});

test("settings are startup snapshots, including files absent at startup", async () => {
  await writeFile(join(agentDir, "settings.json"), '{"defaultModel":"global-model"}');
  const manager = createReadOnlySettings(project, agentDir);
  await writeFile(join(agentDir, "settings.json"), '{"defaultModel":"changed"}');
  await writeFile(join(project, ".qa", "settings.json"), '{"defaultModel":"new-project"}');
  await manager.reload();
  expect(manager.getDefaultModel()).toBe("global-model");
  expect(manager.getProjectSettings()).toEqual({});
});

test("write attempts surface through SDK errors and never persist", async () => {
  const path = join(agentDir, "settings.json");
  const content = '{"defaultModel":"global-model"}';
  await writeFile(path, content);
  const manager = createReadOnlySettings(project, agentDir);
  manager.setDefaultModel("changed");
  await manager.flush();
  expect(manager.drainErrors()).toEqual([
    expect.objectContaining({
      scope: "global",
      error: expect.objectContaining({
        message: `Cannot write read-only global settings: ${path}`,
      }),
    }),
  ]);
  expect(await readFile(path, "utf8")).toBe(content);
});

test.each(["global", "project"] as const)(
  "invalid %s JSON reports scope, path and SDK cause",
  async (scope) => {
    const path =
      scope === "global" ? join(agentDir, "settings.json") : join(project, ".qa", "settings.json");
    await writeFile(path, "{invalid");
    let failure: unknown;
    try {
      createReadOnlySettings(project, agentDir);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain(
      `Cannot load ${scope} settings at ${path}`,
    );
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ cause: expect.any(SyntaxError) }),
    ]);
    expect(await readFile(path, "utf8")).toBe("{invalid");
  },
);

test("non-ENOENT read failures in both scopes are reported rather than defaulted", async () => {
  const paths = [join(agentDir, "settings.json"), join(project, ".qa", "settings.json")];
  await Promise.all(paths.map((path) => mkdir(path)));
  let failure: unknown;
  try {
    createReadOnlySettings(project, agentDir);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(2);
  expect((failure as AggregateError).message).toContain(
    `Cannot load global settings at ${paths[0]}`,
  );
  expect((failure as AggregateError).message).toContain(
    `Cannot load project settings at ${paths[1]}`,
  );
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ cause: expect.objectContaining({ code: "EISDIR" }) }),
    expect.objectContaining({ cause: expect.objectContaining({ code: "EISDIR" }) }),
  ]);
});
