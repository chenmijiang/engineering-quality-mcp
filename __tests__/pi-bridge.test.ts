import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

type WireMessage = { role: string; content?: string | { type: string; text?: string }[] | null };
type ToolResult = {
  status: string;
  session_id: string;
  question_id?: string;
  question?: string;
  text?: string;
  error?: string;
};

const execFileAsync = promisify(execFile);
let fakeProvider: Server;
let directory: string;

function chunk(delta: object, finishReason: string | null) {
  return `data: ${JSON.stringify({
    id: "test-response",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function askHost(id: string, question: string) {
  const call = { name: "ask_host", arguments: JSON.stringify({ question }) };
  return (
    chunk(
      { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: call }] },
      null,
    ) + chunk({}, "tool_calls")
  );
}

// "ASK" asks one question; answering "NEXT" asks a second; otherwise echo the last tool answer.
function reply(messages: WireMessage[]) {
  const last = messages.at(-1);
  const isAsk =
    last?.role === "user" &&
    Array.isArray(last.content) &&
    last.content.some((item) => item.text === "ASK");
  if (isAsk) return askHost("call-1", "What is the code?");
  if (last?.role === "tool" && last.content === "NEXT")
    return askHost("call-2", "What is the second code?");
  const content = messages.findLast((message) => message.role === "tool")?.content;
  const answer =
    typeof content === "string"
      ? content
      : content?.map((item) => item.text ?? "").join("") || "missing";
  return chunk({ role: "assistant", content: `CODE:${answer}` }, null) + chunk({}, "stop");
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "quality-analysis-mcp-pi-"));
  fakeProvider = createServer((request, response) => {
    let body = "";
    request.on("data", (data: Buffer) => (body += data.toString()));
    request.on("end", () => {
      const { messages } = JSON.parse(body) as { messages: WireMessage[] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`${reply(messages)}data: [DONE]\n\n`);
    });
  });
  const listening = Promise.withResolvers<void>();
  fakeProvider.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = fakeProvider.address() as AddressInfo;
  const provider = {
    api: "openai-completions",
    apiKey: "test",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: [{ id: "test-model" }],
  };
  await writeFile(
    join(directory, "models.json"),
    JSON.stringify({ providers: { fake: provider } }),
  );
  await execFileAsync("bun", ["run", "build", "--outdir", directory], { timeout: 20_000 });
}, 30_000);

afterAll(async () => {
  fakeProvider?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe.each([
  { entry: "source", args: () => [resolve("src/index.ts")] },
  { entry: "bundle", args: () => [join(directory, "index.js")] },
])("Pi bridge over stdio ($entry)", ({ args }) => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "generic-client", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: args(),
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: directory,
          PI_AGENT_DIR: directory,
          PI_PROVIDER: "fake",
          PI_MODEL: "test-model",
          PI_RUN_TIMEOUT_MS: "30000",
        },
        stderr: "inherit",
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
  });

  async function call(name: string, args: Record<string, string>) {
    const response = await client.callTool({ name, arguments: args }, { timeout: 30_000 });
    return { value: response.structuredContent as ToolResult, isError: response.isError === true };
  }

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
});
