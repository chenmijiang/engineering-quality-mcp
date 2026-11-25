/** Lets a running agent ask the calling host a question and wait for the answer. */
export interface HostChannel {
  ask(question: string, signal?: AbortSignal): Promise<string>;
}

/** One agent conversation. Implementations wrap a concrete agent SDK. */
export interface AgentSession {
  /** `provider/model` identifier, when known. */
  readonly model?: string;
  /** Runs one turn to completion and returns the final assistant text; rejects on agent errors. */
  prompt(text: string): Promise<string>;
  /** `reason` explains why the host ended the conversation, for runtimes that keep transcripts. */
  dispose(reason?: string): void;
}

/** A task-specific tool a feature gives the agent in addition to the runtime's built-in tools. */
export interface AgentTool {
  /** Must not collide with the runtime's built-in tool names. */
  name: string;
  description: string;
  /** JSON Schema of the arguments object. Runtimes may validate against it; `execute` must not rely on that. */
  parameters: Record<string, unknown>;
  /** Returns the text shown to the agent; a thrown error is reported to the agent as a tool error. */
  execute(args: unknown, signal?: AbortSignal): Promise<string>;
}

export interface OpenSessionOptions {
  /** Host-facing session id; runtimes that keep transcripts use it to identify them. */
  id: string;
  /** Workspace the agent's file tools operate in. */
  cwd: string;
  /** Channel the agent uses for clarification questions during a turn. */
  host: HostChannel;
  tools?: AgentTool[];
}

/** Agent backend: creates sessions and owns their shared resources. */
export interface AgentRuntime {
  open(options: OpenSessionOptions): Promise<AgentSession>;
  shutdown(): Promise<void>;
}

export type Result = {
  status: "needs_input" | "completed" | "error" | "closed";
  session_id?: string;
  question_id?: string;
  question?: string;
  text?: string;
  error?: string;
  model?: string;
};

export interface AskRequest {
  prompt: string;
  /** Continues this completed session; omit to start a new one. */
  sessionId?: string;
  /** Workspace for a new session; defaults to the configured cwd. Ignored when continuing. */
  cwd?: string;
  /** Extra agent tools for a new session; they stay with it for follow-ups. Ignored when continuing. */
  tools?: AgentTool[];
}

/** Host-facing session protocol: turns, suspended questions, cancellation. */
export interface SessionBroker {
  /** Starts a session, or continues a completed one, and waits for its next result. */
  ask(request: AskRequest, signal: AbortSignal): Promise<Result>;
  /** Answers the pending host question and waits for the session's next result. */
  reply(
    sessionId: string,
    questionId: string,
    answer: string,
    signal: AbortSignal,
  ): Promise<Result>;
  cancel(sessionId: string): Result;
  shutdown(): Promise<void>;
}
