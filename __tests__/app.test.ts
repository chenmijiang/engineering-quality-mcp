import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeAll, afterAll, expect, test } from "vitest";

import { App, type AppOverrides } from "@/app";
import type { AgentRuntime, OpenSessionOptions } from "@/core/contracts";
import type { Check } from "@/features/checks";

import type { ToolResult } from "./support/fake-pi";

const config = {
  cwd: tmpdir(),
  agentDir: tmpdir(),
  runTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  maxSessions: 8,
};

/** Scripted agent backend: "ASK" asks the host once and answers with the reply. */
function fakeRuntime() {
  const opened: OpenSessionOptions[] = [];
  const prompts: string[] = [];
  const runtime: AgentRuntime = {
    async open(options) {
      opened.push(options);
      return {
        model: "fake/model",
        async prompt(text) {
          prompts.push(text);
          if (text === "FAIL") throw new Error("provider exploded");
          if (text === "ASK") return `ANSWER:${await options.host.ask("Which one?")}`;
          return "DONE";
        },
        dispose() {},
      };
    },
    async shutdown() {},
  };
  return { runtime, opened, prompts };
}

const docsCheck: Check = {
  name: "docs",
  prompts: { tool: "Review documentation.", task: "DOCS-TASK", rubric: "DOCS-RUBRIC" },
  targetLabel: "markdown files",
  isTarget: (path) => path.endsWith(".md"),
};

let app: App | undefined;
let client: Client | undefined;
let project: string;

async function connect(overrides: AppOverrides) {
  const created = new App(config, overrides);
  app = created;
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await created.createServer().connect(serverSide);
  client = new Client({ name: "generic-client", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

async function call(name: string, args: Record<string, unknown>) {
  const response = await client!.callTool({ name, arguments: args });
  return { value: response.structuredContent as ToolResult, isError: response.isError === true };
}

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "quality-analysis-mcp-app-"));
  await mkdir(join(project, "docs"));
  await writeFile(join(project, "docs/guide.md"), "");
  await writeFile(join(project, "docs/build.ts"), "");
});

afterEach(async () => {
  await client?.close();
  await app?.shutdown();
  client = app = undefined;
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

test("an injected check is exposed as check_<name> in place of the built-in checks", async () => {
  const mcp = await connect({ runtime: fakeRuntime().runtime, checks: [docsCheck] });
  const names = (await mcp.listTools()).tools.map((tool) => tool.name);
  expect(names.sort()).toEqual(["ask_pi", "cancel_pi", "check_docs", "reply_pi"]);
});

test("a check reviews only its own targets, in project_dir, with its own prompts", async () => {
  const fake = fakeRuntime();
  await connect({ runtime: fake.runtime, checks: [docsCheck] });

  const result = await call("check_docs", { project_dir: project, scope: ["docs"] });

  expect(result.value).toMatchObject({ status: "completed", text: "DONE", model: "fake/model" });
  expect(fake.opened.map((options) => options.cwd)).toEqual([project]);
  expect(fake.prompts[0]).toBe(
    "DOCS-TASK\n\n<rubric>\nDOCS-RUBRIC\n</rubric>\n\n<files>\ndocs/guide.md\n</files>",
  );
});

test("a check's target label names its files in scope errors", async () => {
  await connect({ runtime: fakeRuntime().runtime, checks: [docsCheck] });
  const result = await call("check_docs", { project_dir: project, scope: ["."] });
  expect(result.value.status).toBe("completed");

  const empty = await call("check_docs", { project_dir: join(project, "docs"), scope: ["*.ts"] });
  expect(empty.value.error).toBe("No markdown files found in scope: *.ts");
});

test("the session protocol suspends and resumes a turn on any agent runtime", async () => {
  await connect({ runtime: fakeRuntime().runtime, checks: [] });

  const asked = await call("ask_pi", { prompt: "ASK" });
  expect(asked.value).toMatchObject({ status: "needs_input", question: "Which one?" });
  const { session_id, question_id } = asked.value;

  const done = await call("reply_pi", { session_id, question_id, answer: "B" });
  expect(done.value).toMatchObject({ status: "completed", text: "ANSWER:B", session_id });
});

test("an agent error ends the turn with an error result and closes the session", async () => {
  await connect({ runtime: fakeRuntime().runtime, checks: [] });

  const failed = await call("ask_pi", { prompt: "FAIL" });
  expect(failed).toMatchObject({ isError: true, value: { error: "provider exploded" } });

  const followUp = await call("ask_pi", { session_id: failed.value.session_id, prompt: "again" });
  expect(followUp.value.error).toContain("Unknown or closed session_id");
});
