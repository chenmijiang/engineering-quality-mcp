import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { callTool, startFakeProvider, type FakeProvider } from "./support/fake-pi";

const execFileAsync = promisify(execFile);
let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider();
  await execFileAsync("bun", ["run", "build", "--outdir", fake.agentDir], { timeout: 20_000 });
}, 30_000);

afterAll(async () => {
  await fake?.close();
});

type SettingsFixture = {
  project: string;
  session: string;
  agentDir: string;
  connect: (env?: Record<string, string | undefined>) => Promise<Client>;
};

async function withSettingsFixture(
  args: string[],
  action: (fixture: SettingsFixture) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "eq-stdio-settings-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const session = join(root, "session");
  const agentDir = join(home, ".eq", "agent");
  const legacyAgentDir = join(root, "legacy-agent-decoy");
  const clients: Client[] = [];
  try {
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(join(project, ".eq"), { recursive: true }),
      mkdir(join(project, ".pi"), { recursive: true }),
      mkdir(join(session, ".eq"), { recursive: true }),
      mkdir(join(home, ".pi", "agent"), { recursive: true }),
      mkdir(legacyAgentDir, { recursive: true }),
    ]);
    await Promise.all([
      copyFile(join(fake.agentDir, "models.json"), join(agentDir, "models.json")),
      writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fake", defaultModel: "global-model" }),
      ),
      // Valid decoys would select a different model if an old or session-specific path were read.
      writeFile(join(project, ".pi", "settings.json"), '{"defaultModel":"test-model"}'),
      writeFile(
        join(home, ".pi", "agent", "settings.json"),
        '{"defaultProvider":"fake","defaultModel":"test-model"}',
      ),
      copyFile(join(fake.agentDir, "models.json"), join(home, ".pi", "agent", "models.json")),
      writeFile(
        join(legacyAgentDir, "settings.json"),
        '{"defaultProvider":"fake","defaultModel":"test-model"}',
      ),
      copyFile(join(fake.agentDir, "models.json"), join(legacyAgentDir, "models.json")),
      writeFile(join(session, ".eq", "settings.json"), '{"defaultModel":"test-model"}'),
    ]);
    await action({
      project,
      session,
      agentDir,
      async connect(env = {}) {
        const client = await fake.connect(args, {
          cwd: project,
          env: {
            HOME: home,
            EQ_AGENT_DIR: undefined,
            EQ_PROVIDER: undefined,
            EQ_MODEL: undefined,
            PI_CODING_AGENT_DIR: legacyAgentDir,
            EQ_CWD: session,
            ...env,
          },
        });
        clients.push(client);
        return client;
      },
    });
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await rm(root, { recursive: true, force: true });
  }
}

describe.each([
  { entry: "source", args: () => [resolve("src/index.ts")] },
  { entry: "bundle", args: () => [join(fake.agentDir, "index.js")] },
])("Pi bridge over stdio ($entry)", ({ args }) => {
  let client: Client;

  beforeAll(async () => {
    client = await fake.connect(args());
  });

  afterAll(async () => {
    await client?.close();
  });

  const call = (name: string, args: Record<string, string>) => callTool(client, name, args);

  test("a question suspends and resumes the same session without losing context", async () => {
    const first = await call("ask_pi", { prompt: "ASK" });
    expect(first.value).toMatchObject({ status: "needs_input", question: "What is the code?" });
    const { session_id, question_id = "" } = first.value;

    const busy = await call("ask_pi", { session_id, prompt: "overlapping turn" });
    expect(busy.isError).toBe(true);
    expect(busy.value.error).toContain("busy");
    const wrong = await call("reply_pi", {
      session_id,
      question_id: crypto.randomUUID(),
      answer: "x",
    });
    expect(wrong.isError).toBe(true);

    const reply = await call("reply_pi", { session_id, question_id, answer: "CODE-42" });
    expect(reply.value).toMatchObject({ status: "completed", text: "CODE:CODE-42" });
    const duplicate = await call("reply_pi", { session_id, question_id, answer: "again" });
    expect(duplicate.isError).toBe(true);

    const followUp = await call("ask_pi", { session_id, prompt: "RECALL" });
    expect(followUp.value).toMatchObject({ status: "completed", text: "CODE:CODE-42" });
    expect((await call("cancel_pi", { session_id })).value.status).toBe("closed");
    expect((await call("ask_pi", { session_id, prompt: "RECALL" })).isError).toBe(true);
  }, 30_000);

  test("a session transcript is persisted under its session_id with the close reason", async () => {
    const first = await call("ask_pi", { prompt: "ASK" });
    const { session_id, question_id = "" } = first.value;
    await call("reply_pi", { session_id, question_id, answer: "CODE-7" });
    await call("cancel_pi", { session_id });

    const sessionDir = join(fake.agentDir, "sessions");
    const file = (await readdir(sessionDir)).find((name) => name.endsWith(`_${session_id}.jsonl`));
    expect(file).toBeDefined();
    const transcript = SessionManager.open(join(sessionDir, file!));
    expect(transcript.getSessionId()).toBe(session_id);
    const messages = transcript.buildSessionContext().messages;
    expect(messages).toContainEqual(
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "ASK" }] }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "ask_host",
        content: [{ type: "text", text: "CODE-7" }],
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([{ type: "text", text: "CODE:CODE-7" }]),
      }),
    );
    // The close entry is our diagnostic contract, not an SDK-owned event layout.
    expect(transcript.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "eq_close",
      data: { reason: "Session closed by host" },
    });
  }, 30_000);

  test("cancelling a waiting session rejects a later reply", async () => {
    const first = await call("ask_pi", { prompt: "ASK" });
    expect(first.value.status).toBe("needs_input");
    const { session_id, question_id = "" } = first.value;
    expect((await call("cancel_pi", { session_id })).value.status).toBe("closed");

    const reply = await call("reply_pi", { session_id, question_id, answer: "too late" });
    expect(reply.isError).toBe(true);
    expect(reply.value.error).toContain("closed");
  }, 30_000);

  test("one task can ask again after its first answer", async () => {
    const first = await call("ask_pi", { prompt: "ASK" });
    const { session_id, question_id = "" } = first.value;
    const second = await call("reply_pi", { session_id, question_id, answer: "NEXT" });
    expect(second.value).toMatchObject({
      status: "needs_input",
      question: "What is the second code?",
    });
    expect(second.value.question_id).not.toBe(question_id);

    const done = await call("reply_pi", {
      session_id,
      question_id: second.value.question_id ?? "",
      answer: "FINAL",
    });
    expect(done.value).toMatchObject({ status: "completed", text: "CODE:FINAL" });
    await call("cancel_pi", { session_id });
  }, 30_000);

  test("global .eq settings select the wire model while .pi and legacy agent directories are ignored", async () => {
    await withSettingsFixture(args(), async ({ connect }) => {
      const configuredClient = await connect();
      const result = await callTool(configuredClient, "ask_pi", { prompt: "MODEL" });
      expect(result.value).toMatchObject({ status: "completed", text: "CODE:missing" });
      expect(fake.models.at(-1)).toBe("global-model");
    });
  }, 30_000);

  test("startup project .eq overrides global settings despite EQ_CWD and stays a snapshot", async () => {
    await withSettingsFixture(args(), async ({ project, agentDir, connect }) => {
      const path = join(project, ".eq", "settings.json");
      const projectSettings = '{"defaultModel":"project-model"}';
      await writeFile(path, projectSettings);
      const globalBefore = await readFile(join(agentDir, "settings.json"), "utf8");
      const configuredClient = await connect();
      const first = await callTool(configuredClient, "ask_pi", { prompt: "MODEL" });
      expect(first.value.status).toBe("completed");
      expect(fake.models.at(-1)).toBe("project-model");
      expect(await readFile(path, "utf8")).toBe(projectSettings);
      expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe(globalBefore);
      await writeFile(path, '{"defaultModel":"global-model"}');
      const second = await callTool(configuredClient, "ask_pi", { prompt: "NEW SESSION" });
      expect(second.value.status).toBe("completed");
      expect(fake.models.at(-1)).toBe("project-model");
    });
  }, 30_000);

  test("check_test project_dir does not replace the startup project's settings", async () => {
    await withSettingsFixture(args(), async ({ project, session, connect }) => {
      await writeFile(join(project, ".eq", "settings.json"), '{"defaultModel":"project-model"}');
      await mkdir(join(session, "src"));
      await writeFile(join(session, "src", "sum.test.ts"), "// EQ-SETTINGS-CHECK-MARKER");
      const configuredClient = await connect();
      const result = await callTool(configuredClient, "check_test", {
        project_dir: session,
        scope: ["src/sum.test.ts"],
      });
      expect(result.value).toMatchObject({
        status: "completed",
        text: expect.stringContaining("EQ-SETTINGS-CHECK-MARKER"),
      });
      expect(fake.models.at(-1)).toBe("project-model");
    });
  }, 30_000);

  test("explicit EQ agent directory and model overrides remain supported", async () => {
    await withSettingsFixture(args(), async ({ project, connect }) => {
      await writeFile(join(project, ".eq", "settings.json"), '{"defaultModel":"project-model"}');
      const configuredClient = await connect({
        EQ_AGENT_DIR: fake.agentDir,
        EQ_PROVIDER: "fake",
        EQ_MODEL: "test-model",
      });
      const result = await callTool(configuredClient, "ask_pi", { prompt: "MODEL" });
      expect(result.value.status).toBe("completed");
      expect(fake.models.at(-1)).toBe("test-model");
    });
  }, 30_000);

  test("missing .eq settings do not fall back to Pi settings", async () => {
    await withSettingsFixture(args(), async ({ agentDir, connect }) => {
      await rm(join(agentDir, "settings.json"));
      const configuredClient = await connect({ EQ_PROVIDER: "fake", EQ_MODEL: "test-model" });
      const result = await callTool(configuredClient, "ask_pi", { prompt: "MODEL" });
      expect(result.value.status).toBe("completed");
      expect(fake.models.at(-1)).toBe("test-model");
    });
  }, 30_000);

  test.each(["global", "project"] as const)(
    "invalid %s .eq settings stop startup with scope and path",
    async (scope) => {
      await withSettingsFixture(args(), async ({ project, session, agentDir }) => {
        const path =
          scope === "global"
            ? join(agentDir, "settings.json")
            : join(project, ".eq", "settings.json");
        await writeFile(path, "{invalid-settings");
        await expect(
          execFileAsync("bun", args(), {
            cwd: project,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: resolve(agentDir, "../.."),
              EQ_AGENT_DIR: agentDir,
              EQ_CWD: session,
            },
            timeout: 5_000,
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            `Cannot load ${scope} settings at ${scope === "project" ? join(await realpath(project), ".eq", "settings.json") : path}`,
          ),
        });
        expect(await readFile(path, "utf8")).toBe("{invalid-settings");
      });
    },
    30_000,
  );
});
