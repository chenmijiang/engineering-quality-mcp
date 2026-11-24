import { join } from "node:path";

import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Config } from "./config";
import { prompts } from "./prompts";

export type Result = {
  status: "needs_input" | "completed" | "error" | "closed";
  session_id?: string;
  question_id?: string;
  question?: string;
  text?: string;
  error?: string;
  model?: string;
};

type Question = PromiseWithResolvers<string> & { id: string };
type Turn = { result: PromiseWithResolvers<Result>; timer: NodeJS.Timeout; error?: string };
type Conversation = {
  id: string;
  session?: AgentSession;
  turn?: Turn;
  pending?: Question;
  closed: boolean;
  touched: number;
};

// No automatic resource discovery: importing user extensions could enable arbitrary tools.
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => prompts.piSystem,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const questionSchema = Type.Object({ question: Type.String({ minLength: 1, maxLength: 16_000 }) });

export interface PiBridge {
  /** Starts a session, or continues a completed one, and waits for its next result. */
  ask(prompt: string, sessionId: string | undefined, signal: AbortSignal): Promise<Result>;
  /** Resolves the pending ask_host call and waits for the session's next result. */
  reply(
    sessionId: string,
    questionId: string,
    answer: string,
    signal: AbortSignal,
  ): Promise<Result>;
  cancel(sessionId: string): Result;
  shutdown(): Promise<void>;
}

export function createPiBridge(config: Config): PiBridge {
  const sessions = new Map<string, Conversation>();
  let shuttingDown = false;

  // Copy existing settings into a non-persisting manager: SDK changes cannot rewrite settings.
  const baseSettings = SettingsManager.create(config.cwd, config.agentDir).getSettings();
  let runtimePromise: Promise<ModelRuntime> | undefined;
  function getRuntime() {
    return (runtimePromise ??= ModelRuntime.create({
      authPath: join(config.agentDir, "auth.json"),
      modelsPath: join(config.agentDir, "models.json"),
    }).catch((error: unknown) => {
      runtimePromise = undefined;
      throw error;
    }));
  }

  function publish(record: Conversation, result: Result) {
    record.touched = Date.now();
    const model = record.session?.model;
    record.turn?.result.resolve({
      ...result,
      session_id: record.id,
      model: model ? `${model.provider}/${model.id}` : undefined,
    });
  }

  // Invalidate IDs and resolve the waiting MCP call before aborting the SDK session.
  function close(record: Conversation, reason: string) {
    if (record.closed) return;
    record.closed = true;
    sessions.delete(record.id);
    publish(record, { status: "error", error: reason });
    if (record.turn) clearTimeout(record.turn.timer);
    const pending = record.pending;
    record.pending = undefined;
    pending?.reject(new Error(reason));
    record.session?.dispose();
  }

  function startTurn(record: Conversation): Turn {
    const turn: Turn = {
      result: Promise.withResolvers<Result>(),
      timer: setTimeout(
        () => close(record, "Pi turn deadline exceeded (including reply wait)"),
        config.runTimeoutMs,
      ),
    };
    record.turn = turn;
    return turn;
  }

  function askHostTool(record: Conversation): ToolDefinition<typeof questionSchema> {
    return {
      name: "ask_host",
      label: "Ask host",
      parameters: questionSchema,
      description: prompts.askHost,
      promptSnippet: "Ask the host a necessary clarification and wait for its answer.",
      executionMode: "sequential",
      async execute(_id, { question }, signal) {
        if (record.closed || !record.turn)
          throw new Error("Session is closed or no turn is active");
        if (record.pending) throw new Error("Only one ask_host question may wait at a time");
        const pending: Question = { ...Promise.withResolvers<string>(), id: crypto.randomUUID() };
        record.pending = pending;
        const abort = () => pending.reject(new Error("Pi question aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        publish(record, { status: "needs_input", question_id: pending.id, question });
        try {
          const answer = await pending.promise;
          return { content: [{ type: "text", text: answer }], details: {} };
        } finally {
          signal?.removeEventListener("abort", abort);
          if (record.pending === pending) record.pending = undefined;
        }
      },
    };
  }

  async function initialize(record: Conversation) {
    const modelRuntime = await getRuntime();
    if (record.closed) return;
    const model = config.model
      ? modelRuntime.getModel(config.model.provider, config.model.id)
      : undefined;
    if (config.model && !model) {
      throw new Error(`Unknown Pi model: ${config.model.provider}/${config.model.id}`);
    }
    const { session } = await createAgentSession({
      cwd: config.cwd,
      agentDir: config.agentDir,
      modelRuntime,
      model,
      resourceLoader,
      tools: ["ask_host", "read", "grep", "find", "ls"],
      customTools: [askHostTool(record)],
      sessionManager: SessionManager.inMemory(config.cwd),
      settingsManager: SettingsManager.inMemory({
        ...baseSettings,
        compaction: { ...baseSettings.compaction, enabled: false },
        retry: { ...baseSettings.retry, enabled: false },
        cacheWarming: "off",
      }),
    });
    if (record.closed) {
      session.dispose();
      return;
    }
    record.session = session;
    // Some provider errors end the stream normally rather than rejecting prompt().
    session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        (event.message.stopReason === "error" || event.message.stopReason === "aborted") &&
        record.turn
      ) {
        record.turn.error = event.message.errorMessage ?? `Pi ${event.message.stopReason}`;
      }
    });
  }

  async function run(record: Conversation, prompt: string) {
    try {
      if (!record.session) await initialize(record);
      if (record.closed || !record.session) return;
      await record.session.prompt(prompt, { expandPromptTemplates: false });
      if (record.closed) return;
      if (record.turn?.error) throw new Error(record.turn.error);
      publish(record, { status: "completed", text: record.session.getLastAssistantText() ?? "" });
      if (record.turn) clearTimeout(record.turn.timer);
      record.turn = undefined;
    } catch (error) {
      close(record, error instanceof Error ? error.message : String(error));
    }
  }

  async function awaitResult(record: Conversation, turn: Turn, signal: AbortSignal) {
    const abort = () => close(record, "MCP request cancelled");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      return await turn.result.promise;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  const fail = (error: string, session_id?: string): Result => ({
    status: "error",
    error,
    session_id,
  });

  const sweeper = setInterval(
    () => {
      for (const record of sessions.values()) {
        if (!record.turn && Date.now() - record.touched >= config.idleTimeoutMs) {
          close(record, "Idle session expired");
        }
      }
    },
    Math.min(config.idleTimeoutMs, 60_000),
  );
  sweeper.unref();

  return {
    async ask(prompt, sessionId, signal) {
      if (shuttingDown) return fail("Server is shutting down");
      let record: Conversation;
      if (sessionId) {
        const existing = sessions.get(sessionId);
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
        if (sessions.size >= config.maxSessions) {
          return fail("Session limit reached; cancel_pi an existing session first");
        }
        record = { id: crypto.randomUUID(), closed: false, touched: Date.now() };
        sessions.set(record.id, record);
      }
      const turn = startTurn(record);
      // Not awaited: ask_host may suspend the run across several MCP calls.
      void run(record, prompt);
      return awaitResult(record, turn, signal);
    },

    async reply(sessionId, questionId, answer, signal) {
      const record = sessions.get(sessionId);
      if (!record) return fail("Unknown or closed session_id", sessionId);
      const pending = record.pending;
      if (!pending || !record.turn || pending.id !== questionId) {
        return fail(
          "No matching pending question (stale, duplicate, or wrong question_id)",
          sessionId,
        );
      }
      // Replace the response channel BEFORE releasing Pi to avoid losing a fast completion.
      record.turn.result = Promise.withResolvers<Result>();
      const turn = record.turn;
      record.pending = undefined;
      pending.resolve(answer);
      return awaitResult(record, turn, signal);
    },

    cancel(sessionId) {
      const record = sessions.get(sessionId);
      if (record) close(record, "Session closed by host");
      return { status: "closed", session_id: sessionId };
    },

    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(sweeper);
      for (const record of sessions.values()) close(record, "MCP server disconnected");
      if (runtimePromise) await (await runtimePromise).settleCredentialWrites();
    },
  };
}
