import { tmpdir } from "node:os";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test } from "vitest";

import { App, type AppOverrides } from "@/app";
import type { AgentRuntime } from "@/core/contracts";

import type { ToolResult } from "./support/fake-pi";

const config = {
  cwd: tmpdir(),
  projectCwd: tmpdir(),
  agentDir: tmpdir(),
  sessionDir: tmpdir(),
  runTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  maxSessions: 8,
};

/** Scripted agent backend: "ASK" asks the host once and answers with the reply. */
function fakeRuntime() {
  const runtime: AgentRuntime = {
    async open(options) {
      return {
        model: "fake/model",
        async prompt(text) {
          if (text === "FAIL") throw new Error("provider exploded");
          if (text === "ASK") return `ANSWER:${await options.host.ask("Which one?")}`;
          return "DONE";
        },
        dispose() {},
      };
    },
    async shutdown() {},
  };
  return { runtime };
}

let app: App | undefined;
let client: Client | undefined;

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

afterEach(async () => {
  await client?.close();
  await app?.shutdown();
  client = app = undefined;
});

test("the server exposes the session tools and review_code", async () => {
  const mcp = await connect({ runtime: fakeRuntime().runtime });
  const names = (await mcp.listTools()).tools.map((tool) => tool.name);
  expect(names.sort()).toEqual(["ask_pi", "cancel_pi", "reply_pi", "review_code"]);
});

test("the session protocol suspends and resumes a turn on any agent runtime", async () => {
  await connect({ runtime: fakeRuntime().runtime });

  const asked = await call("ask_pi", { prompt: "ASK" });
  expect(asked.value).toMatchObject({ status: "needs_input", question: "Which one?" });
  const { session_id, question_id } = asked.value;

  const done = await call("reply_pi", { session_id, question_id, answer: "B" });
  expect(done.value).toMatchObject({ status: "completed", text: "ANSWER:B", session_id });
});

test("an agent error ends the turn with an error result and closes the session", async () => {
  await connect({ runtime: fakeRuntime().runtime });

  const failed = await call("ask_pi", { prompt: "FAIL" });
  expect(failed).toMatchObject({ isError: true, value: { error: "provider exploded" } });

  const followUp = await call("ask_pi", { session_id: failed.value.session_id, prompt: "again" });
  expect(followUp.value.error).toContain("Unknown or closed session_id");
});
