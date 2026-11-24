import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { SessionBroker } from "@/core/contracts";
import { tool, ToolModule } from "@/core/tool-module";

const askInput = z.object({
  prompt: z.string().min(1).max(100_000),
  session_id: z.uuid().optional(),
});
const replyInput = z.object({
  session_id: z.uuid(),
  question_id: z.uuid(),
  answer: z.string().min(1).max(100_000),
});
const cancelInput = z.object({ session_id: z.uuid() });

/** `ask_pi`, `reply_pi`, and `cancel_pi`: the generic session protocol. */
export class SessionTools extends ToolModule {
  constructor(private readonly sessions: SessionBroker) {
    super();
  }

  @tool({
    name: "ask_pi",
    description:
      "Ask Pi a task, or continue a completed Pi conversation by session_id. Pi can inspect files with read, grep, find and ls, and may ask you a clarification; it has no shell or file-writing tools. Returns needs_input with IDs when Pi needs an answer; reply via reply_pi, never another ask_pi on that session.",
    inputSchema: askInput,
  })
  ask({ prompt, session_id }: z.output<typeof askInput>, ctx: ServerContext) {
    return this.sessions.ask({ prompt, sessionId: session_id }, ctx.mcpReq.signal);
  }

  @tool({
    name: "reply_pi",
    description:
      "Answer Pi's pending question and resume the same run. Use the exact session_id and question_id from needs_input. May return another needs_input or completed. Stale or duplicate replies are rejected.",
    inputSchema: replyInput,
  })
  reply({ session_id, question_id, answer }: z.output<typeof replyInput>, ctx: ServerContext) {
    return this.sessions.reply(session_id, question_id, answer, ctx.mcpReq.signal);
  }

  @tool({
    name: "cancel_pi",
    description:
      "Abort a running or waiting Pi session, or close a completed one. Discards the conversation and invalidates its IDs. Idempotent.",
    inputSchema: cancelInput,
    annotations: { idempotentHint: true },
  })
  cancel({ session_id }: z.output<typeof cancelInput>) {
    return this.sessions.cancel(session_id);
  }
}
