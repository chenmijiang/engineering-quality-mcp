import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { SessionBroker } from "@/core/contracts";
import { tool, ToolModule } from "@/core/tool-module";

import askPi from "./prompts/ask-pi.md" with { type: "text" };
import cancelPi from "./prompts/cancel-pi.md" with { type: "text" };
import replyPi from "./prompts/reply-pi.md" with { type: "text" };

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

  @tool({ name: "ask_pi", description: askPi.trim(), inputSchema: askInput })
  ask({ prompt, session_id }: z.output<typeof askInput>, ctx: ServerContext) {
    return this.sessions.ask({ prompt, sessionId: session_id }, ctx.mcpReq.signal);
  }

  @tool({ name: "reply_pi", description: replyPi.trim(), inputSchema: replyInput })
  reply({ session_id, question_id, answer }: z.output<typeof replyInput>, ctx: ServerContext) {
    return this.sessions.reply(session_id, question_id, answer, ctx.mcpReq.signal);
  }

  @tool({
    name: "cancel_pi",
    description: cancelPi.trim(),
    inputSchema: cancelInput,
    annotations: { idempotentHint: true },
  })
  cancel({ session_id }: z.output<typeof cancelInput>) {
    return this.sessions.cancel(session_id);
  }
}
