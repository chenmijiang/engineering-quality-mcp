import type {
  AgentRuntime,
  AgentSession,
  AskRequest,
  HostChannel,
  Result,
  SessionBroker,
} from "./contracts";

export interface SessionLimits {
  /** Default workspace for new sessions. */
  cwd: string;
  /** Whole-turn deadline, including time spent waiting for a reply. */
  runTimeoutMs: number;
  /** Retention for sessions without an active turn. */
  idleTimeoutMs: number;
  maxSessions: number;
}

type Question = PromiseWithResolvers<string> & { id: string };
type Turn = { result: PromiseWithResolvers<Result>; timer: NodeJS.Timeout };

const fail = (error: string, session_id?: string): Result => ({
  status: "error",
  error,
  session_id,
});

/**
 * One agent conversation and its current turn. It is also the agent's channel to the host:
 * a question suspends the turn and resolves the waiting tool call with `needs_input`.
 */
class Conversation implements HostChannel {
  readonly id = crypto.randomUUID();
  session?: AgentSession;
  turn?: Turn;
  pending?: Question;
  closed = false;
  touched = Date.now();

  constructor(readonly cwd: string) {}

  publish(result: Result) {
    this.touched = Date.now();
    this.turn?.result.resolve({ ...result, session_id: this.id, model: this.session?.model });
  }

  startTurn(timeoutMs: number, onTimeout: () => void): Turn {
    this.turn = {
      result: Promise.withResolvers<Result>(),
      timer: setTimeout(onTimeout, timeoutMs),
    };
    return this.turn;
  }

  endTurn() {
    if (this.turn) clearTimeout(this.turn.timer);
    this.turn = undefined;
  }

  // Resolve the waiting call before disposing the agent session.
  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.publish({ status: "error", error: reason });
    if (this.turn) clearTimeout(this.turn.timer);
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new Error(reason));
    this.session?.dispose();
  }

  async ask(question: string, signal?: AbortSignal): Promise<string> {
    if (this.closed || !this.turn) throw new Error("Session is closed or no turn is active");
    if (this.pending) throw new Error("Only one host question may wait at a time");
    const pending: Question = { ...Promise.withResolvers<string>(), id: crypto.randomUUID() };
    this.pending = pending;
    const abort = () => pending.reject(new Error("Agent question aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.publish({ status: "needs_input", question_id: pending.id, question });
    try {
      return await pending.promise;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.pending === pending) this.pending = undefined;
    }
  }
}

/** Keeps conversations in this process and maps their turns onto request/response tool calls. */
export class InMemorySessionBroker implements SessionBroker {
  readonly #sessions = new Map<string, Conversation>();
  readonly #sweeper: NodeJS.Timeout;
  #shuttingDown = false;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly limits: SessionLimits,
  ) {
    this.#sweeper = setInterval(
      () => {
        for (const record of this.#sessions.values()) {
          if (!record.turn && Date.now() - record.touched >= limits.idleTimeoutMs) {
            this.#close(record, "Idle session expired");
          }
        }
      },
      Math.min(limits.idleTimeoutMs, 60_000),
    );
    this.#sweeper.unref();
  }

  async ask({ prompt, sessionId, cwd }: AskRequest, signal: AbortSignal): Promise<Result> {
    if (this.#shuttingDown) return fail("Server is shutting down");
    let record: Conversation;
    if (sessionId) {
      const existing = this.#sessions.get(sessionId);
      if (!existing) {
        return fail(
          "Unknown or closed session_id; start a new session without session_id",
          sessionId,
        );
      }
      if (existing.turn) {
        return fail("Session is busy; if needs_input, use reply_pi with question_id", sessionId);
      }
      record = existing;
    } else {
      if (this.#sessions.size >= this.limits.maxSessions) {
        return fail("Session limit reached; cancel_pi an existing session first");
      }
      record = new Conversation(cwd ?? this.limits.cwd);
      this.#sessions.set(record.id, record);
    }
    const turn = this.#startTurn(record);
    // Not awaited: a host question may suspend the run across several tool calls.
    void this.#run(record, prompt);
    return this.#awaitResult(record, turn, signal);
  }

  async reply(
    sessionId: string,
    questionId: string,
    answer: string,
    signal: AbortSignal,
  ): Promise<Result> {
    const record = this.#sessions.get(sessionId);
    if (!record) return fail("Unknown or closed session_id", sessionId);
    const pending = record.pending;
    if (!pending || !record.turn || pending.id !== questionId) {
      return fail(
        "No matching pending question (stale, duplicate, or wrong question_id)",
        sessionId,
      );
    }
    // Replace the response channel BEFORE releasing the agent to avoid losing a fast completion.
    record.turn.result = Promise.withResolvers<Result>();
    const turn = record.turn;
    record.pending = undefined;
    pending.resolve(answer);
    return this.#awaitResult(record, turn, signal);
  }

  cancel(sessionId: string): Result {
    const record = this.#sessions.get(sessionId);
    if (record) this.#close(record, "Session closed by host");
    return { status: "closed", session_id: sessionId };
  }

  async shutdown() {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    clearInterval(this.#sweeper);
    for (const record of this.#sessions.values()) this.#close(record, "MCP server disconnected");
  }

  #close(record: Conversation, reason: string) {
    this.#sessions.delete(record.id);
    record.close(reason);
  }

  #startTurn(record: Conversation) {
    return record.startTurn(this.limits.runTimeoutMs, () =>
      this.#close(record, "Agent turn deadline exceeded (including reply wait)"),
    );
  }

  async #run(record: Conversation, prompt: string) {
    try {
      if (!record.session) {
        const session = await this.runtime.open({ cwd: record.cwd, host: record });
        if (record.closed) {
          session.dispose();
          return;
        }
        record.session = session;
      }
      const text = await record.session.prompt(prompt);
      if (record.closed) return;
      record.publish({ status: "completed", text });
      record.endTurn();
    } catch (error) {
      this.#close(record, error instanceof Error ? error.message : String(error));
    }
  }

  async #awaitResult(record: Conversation, turn: Turn, signal: AbortSignal) {
    const abort = () => this.#close(record, "MCP request cancelled");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      return await turn.result.promise;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
