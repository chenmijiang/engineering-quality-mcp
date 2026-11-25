import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export type WireMessage = {
  role: string;
  content?: string | { type: string; text?: string }[] | null;
};

type WireRequest = {
  model: string;
  messages: WireMessage[];
  tools: { type: string; function: { name: string; description: string } }[];
};

export type ToolResult = {
  status: string;
  session_id: string;
  question_id?: string;
  question?: string;
  text?: string;
  error?: string;
};

export function messageText(message: WireMessage | undefined): string {
  const content = message?.content;
  return typeof content === "string"
    ? content
    : (content ?? []).map((item) => item.text ?? "").join("");
}

function chunk(delta: object, finishReason: string | null) {
  return `data: ${JSON.stringify({
    id: "test-response",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function toolCall(id: string, name: string, args: object) {
  const call = { name, arguments: JSON.stringify(args) };
  return (
    chunk(
      { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: call }] },
      null,
    ) + chunk({}, "tool_calls")
  );
}

/** Scripted model: "ASK" asks the host a question; "NEXT" asks a second one. */
function reply(messages: WireMessage[]) {
  const last = messages.at(-1);
  if (last?.role === "user" && messageText(last) === "ASK") {
    return toolCall("call-1", "ask_host", { question: "What is the code?" });
  }
  if (last?.role === "tool" && messageText(last) === "NEXT") {
    return toolCall("call-2", "ask_host", { question: "What is the second code?" });
  }
  const answer = messageText(messages.findLast((message) => message.role === "tool")) || "missing";
  return chunk({ role: "assistant", content: `CODE:${answer}` }, null) + chunk({}, "stop");
}

export type FakeProvider = {
  /** Pi agent dir configured for the fake provider; also the server's cwd and HOME. */
  agentDir: string;
  /** Model requests observed on the provider wire, in request order. */
  requests: WireRequest[];
  connect(
    args: string[],
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ): Promise<Client>;
  close(): Promise<void>;
};

/** Starts the scripted OpenAI-compatible provider and writes a Pi agent dir that points at it. */
export async function startFakeProvider(): Promise<FakeProvider> {
  const agentDir = await mkdtemp(join(tmpdir(), "engineering-quality-mcp-pi-"));
  const requests: WireRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (data: Buffer) => (body += data.toString()));
    request.on("end", () => {
      const payload = JSON.parse(body) as WireRequest;
      requests.push(payload);
      const { messages } = payload;
      const prompt = messageText(messages.at(-1));
      if (prompt === "HTTP_ERROR") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "scripted provider failure", type: "invalid_request_error" },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (prompt === "STREAM_ERROR") {
        response.end(
          chunk({ role: "assistant", content: "INCOMPLETE" }, null) +
            `data: ${JSON.stringify({ error: { message: "scripted stream failure", type: "server_error" } })}\n\n`,
        );
        return;
      }
      response.end(`${reply(messages)}data: [DONE]\n\n`);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  const provider = {
    api: "openai-completions",
    apiKey: "test",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: [{ id: "test-model" }, { id: "global-model" }, { id: "project-model" }],
  };
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: provider } }));

  return {
    agentDir,
    requests,
    async connect(args: string[], options: Parameters<FakeProvider["connect"]>[1] = {}) {
      const client = new Client({ name: "generic-client", version: "1.0.0" });
      await client.connect(
        new StdioClientTransport({
          command: "bun",
          args,
          cwd: options.cwd ?? agentDir,
          env: Object.fromEntries(
            Object.entries({
              PATH: process.env.PATH ?? "",
              HOME: agentDir,
              EQ_AGENT_DIR: agentDir,
              EQ_PROVIDER: "fake",
              EQ_MODEL: "test-model",
              EQ_RUN_TIMEOUT_MS: "30000",
              ...options.env,
            }).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          stderr: "inherit",
        }),
      );
      return client;
    },
    async close() {
      server.close();
      await rm(agentDir, { recursive: true, force: true });
    },
  };
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args }, { timeout: 30_000 });
  return { value: response.structuredContent as ToolResult, isError: response.isError === true };
}
