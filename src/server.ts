import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { PiBridge, Result } from "./bridge";
import { prompts } from "./prompts";

const resultSchema = z.object({
  status: z.enum(["needs_input", "completed", "error", "closed"]),
  session_id: z.string().optional(),
  question_id: z.string().optional(),
  question: z.string().optional(),
  text: z.string().optional(),
  error: z.string().optional(),
  model: z.string().optional(),
});

function toolResult(result: Result) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    isError: result.status === "error",
  };
}

export function createServer(bridge: PiBridge) {
  const server = new McpServer(
    { name: "quality-analysis-mcp", version: "1.0.0" },
    { instructions: prompts.serverInstructions },
  );

  server.registerTool(
    "ask_pi",
    {
      description: prompts.askPi,
      inputSchema: z.object({
        prompt: z.string().min(1).max(100_000),
        session_id: z.uuid().optional(),
      }),
      outputSchema: resultSchema,
    },
    async ({ prompt, session_id }, ctx) =>
      toolResult(await bridge.ask(prompt, session_id, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "reply_pi",
    {
      description: prompts.replyPi,
      inputSchema: z.object({
        session_id: z.uuid(),
        question_id: z.uuid(),
        answer: z.string().min(1).max(100_000),
      }),
      outputSchema: resultSchema,
    },
    async ({ session_id, question_id, answer }, ctx) =>
      toolResult(await bridge.reply(session_id, question_id, answer, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "cancel_pi",
    {
      description: prompts.cancelPi,
      inputSchema: z.object({ session_id: z.uuid() }),
      outputSchema: resultSchema,
      annotations: { idempotentHint: true },
    },
    ({ session_id }) => toolResult(bridge.cancel(session_id)),
  );

  return server;
}
