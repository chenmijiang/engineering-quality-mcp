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
  dispose(): void;
}

export interface OpenSessionOptions {
  /** Workspace the agent's file tools operate in. */
  cwd: string;
  /** Channel the agent uses for clarification questions during a turn. */
  host: HostChannel;
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
