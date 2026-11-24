import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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
