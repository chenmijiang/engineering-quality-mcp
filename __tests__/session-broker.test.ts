import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentRuntime, HostChannel, Result } from "@/core/contracts";
import { InMemorySessionBroker, type SessionLimits } from "@/core/session-broker";

type AgentScript = (text: string, host: HostChannel, disposed: Promise<void>) => Promise<string>;

const brokers: InMemorySessionBroker[] = [];
const signal = () => new AbortController().signal;

function createBroker(script: AgentScript, limits: Partial<SessionLimits> = {}) {
  const runtime: AgentRuntime = {
    async open({ host }) {
      const disposed = Promise.withResolvers<void>();
      return {
        prompt: (text) => script(text, host, disposed.promise),
        dispose: () => disposed.resolve(),
      };
    },
    async shutdown() {},
  };
  const broker = new InMemorySessionBroker(runtime, {
    cwd: process.cwd(),
    runTimeoutMs: 1_000,
    idleTimeoutMs: 60_000,
    maxSessions: 2,
    ...limits,
  });
  brokers.push(broker);
  return broker;
}

function sessionId(result: Result): string {
  expect(result.session_id).toEqual(expect.any(String));
  return result.session_id!;
}

function questionId(result: Result): string {
  expect(result.status).toBe("needs_input");
  expect(result.question_id).toEqual(expect.any(String));
  return result.question_id!;
}

async function expectClosed(broker: InMemorySessionBroker, id: string, question?: string) {
  expect(await broker.ask({ sessionId: id, prompt: "continue" }, signal())).toMatchObject({
    status: "error",
    session_id: id,
    error: expect.stringContaining("Unknown or closed"),
  });
  if (question) {
    expect(await broker.reply(id, question, "too late", signal())).toMatchObject({
      status: "error",
      session_id: id,
      error: expect.stringContaining("Unknown or closed"),
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  try {
    await Promise.all(brokers.splice(0).map((broker) => broker.shutdown()));
  } finally {
    vi.useRealTimers();
  }
});

describe("session capacity", () => {
  test("rejects a new session without evicting existing conversations, and cancel frees a slot", async () => {
    const broker = createBroker(async (text) => `answer:${text}`);
    const first = await broker.ask({ prompt: "first" }, signal());
    const second = await broker.ask({ prompt: "second" }, signal());
    expect(first).toMatchObject({ status: "completed", text: "answer:first" });
    expect(second).toMatchObject({ status: "completed", text: "answer:second" });
    const firstId = sessionId(first);
    const secondId = sessionId(second);

    expect(await broker.ask({ prompt: "over capacity" }, signal())).toMatchObject({
      status: "error",
      error: expect.stringContaining("Session limit reached"),
    });
    for (const id of [firstId, secondId]) {
      expect(await broker.ask({ sessionId: id, prompt: "still here" }, signal())).toMatchObject({
        status: "completed",
        session_id: id,
        text: "answer:still here",
      });
    }

    expect(broker.cancel(firstId)).toEqual({ status: "closed", session_id: firstId });
    const replacement = await broker.ask({ prompt: "replacement" }, signal());
    expect(replacement).toMatchObject({ status: "completed", text: "answer:replacement" });
    expect(sessionId(replacement)).not.toBe(firstId);
    expect(sessionId(replacement)).not.toBe(secondId);
    await expectClosed(broker, firstId);
    expect(await broker.ask({ sessionId: secondId, prompt: "survived" }, signal())).toMatchObject({
      status: "completed",
      session_id: secondId,
      text: "answer:survived",
    });
  });
});

describe("whole-turn deadlines", () => {
  test("expires a running request at the deadline and invalidates its session", async () => {
    const started = Promise.withResolvers<void>();
    const broker = createBroker(async (_text, _host, disposed) => {
      started.resolve();
      await disposed;
      return "stopped";
    });
    const request = broker.ask({ prompt: "keep running" }, signal());
    let settled = false;
    void request.then(() => {
      settled = true;
    });
    await started.promise;

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await request;
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("deadline exceeded"),
    });
    await expectClosed(broker, sessionId(result));
  });

  test("expires while waiting for a host answer and rejects both expired ids", async () => {
    const broker = createBroker(async (_text, host) => host.ask("Which target?"));
    const question = await broker.ask({ prompt: "ask the host" }, signal());
    const id = sessionId(question);
    const pendingId = questionId(question);

    await vi.advanceTimersByTimeAsync(999);
    expect(await broker.ask({ sessionId: id, prompt: "overlap" }, signal())).toMatchObject({
      status: "error",
      error: expect.stringContaining("busy"),
    });
    await vi.advanceTimersByTimeAsync(1);
    await expectClosed(broker, id, pendingId);
    expect(await broker.ask({ prompt: "new task" }, signal())).toMatchObject({
      status: "needs_input",
      question: "Which target?",
    });
  });

  test("neither asking the host nor replying resets the original turn deadline", async () => {
    const started = Promise.withResolvers<void>();
    const askHost = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<string>();
    const broker = createBroker(async (_text, host, disposed) => {
      started.resolve();
      await Promise.race([askHost.promise, disposed]);
      const answer = await host.ask("Which target?");
      answered.resolve(answer);
      await disposed;
      return "stopped";
    });
    const request = broker.ask({ prompt: "work, clarify, then work again" }, signal());
    await started.promise;
    await vi.advanceTimersByTimeAsync(400);
    askHost.resolve();
    const question = await request;
    const id = sessionId(question);
    const pendingId = questionId(question);

    await vi.advanceTimersByTimeAsync(400);
    const reply = broker.reply(id, pendingId, "src", signal());
    expect(await answered.promise).toBe("src");
    let settled = false;
    void reply.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await reply).toMatchObject({
      status: "error",
      session_id: id,
      error: expect.stringContaining("deadline exceeded"),
    });
    await expectClosed(broker, id, pendingId);
  });
});

describe("request cancellation", () => {
  test.each(["ask", "reply"] as const)(
    "an already-aborted %s request closes the conversation and invalidates its ids",
    async (operation) => {
      const broker = createBroker(async (text, host, disposed) => {
        if (text === "question") await host.ask("Continue?");
        await disposed;
        return "stopped";
      });
      const controller = new AbortController();
      controller.abort();
      let question: Result | undefined;
      if (operation === "reply") {
        question = await broker.ask({ prompt: "question" }, signal());
      }
      const result = question
        ? await broker.reply(sessionId(question), questionId(question), "yes", controller.signal)
        : await broker.ask({ prompt: "work" }, controller.signal);

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("request cancelled"),
      });
      const id = sessionId(result);
      if (question) expect(id).toBe(sessionId(question));
      await expectClosed(broker, id, question?.question_id);
    },
  );

  test.each(["ask", "reply"] as const)(
    "aborting an in-flight %s request settles it and prevents further use of the session",
    async (operation) => {
      const running = Promise.withResolvers<void>();
      const broker = createBroker(async (text, host, disposed) => {
        if (text === "question") await host.ask("Continue?");
        running.resolve();
        await disposed;
        return "stopped";
      });
      const controller = new AbortController();
      let question: Result | undefined;
      if (operation === "reply") {
        question = await broker.ask({ prompt: "question" }, signal());
      }
      const request = question
        ? broker.reply(sessionId(question), questionId(question), "yes", controller.signal)
        : broker.ask({ prompt: "work" }, controller.signal);
      await running.promise;
      controller.abort();

      const result = await request;
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("request cancelled"),
      });
      const id = sessionId(result);
      if (question) expect(id).toBe(sessionId(question));
      await expectClosed(broker, id, question?.question_id);
    },
  );
});
