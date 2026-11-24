import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import { tool, ToolModule } from "@/core/tool-module";

const echoInput = z.object({ text: z.string().min(1), times: z.number().int().default(1) });

class EchoTools extends ToolModule {
  constructor(private readonly prefix: string) {
    super();
  }

  @tool((self: EchoTools) => ({
    name: `${self.prefix}_echo`,
    description: "Echo text.",
    inputSchema: echoInput,
  }))
  echo({ text, times }: z.output<typeof echoInput>) {
    return { status: "completed" as const, text: `${this.prefix}:${text.repeat(times)}` };
  }

  @tool((self: EchoTools) => ({
    name: `${self.prefix}_explode`,
    description: "Always fails.",
    inputSchema: z.object({}),
  }))
  async explode(): Promise<never> {
    throw new Error("boom");
  }
}

let client: Client | undefined;

async function serve(...modules: ToolModule[]) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  for (const module of modules) module.register(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

test("a decorated method receives parsed input with defaults and returns a structured result", async () => {
  const mcp = await serve(new EchoTools("a"));
  const response = await mcp.callTool({ name: "a_echo", arguments: { text: "hi" } });
  expect(response.structuredContent).toEqual({ status: "completed", text: "a:hi" });
  expect(response.isError).toBe(false);
});

test("input that violates the schema is rejected before the method runs", async () => {
  const mcp = await serve(new EchoTools("a"));
  const response = await mcp.callTool({ name: "a_echo", arguments: { text: "" } });
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toBeUndefined();
});

test("a thrown error becomes an error result instead of a protocol failure", async () => {
  const mcp = await serve(new EchoTools("a"));
  const response = await mcp.callTool({ name: "a_explode", arguments: {} });
  expect(response).toMatchObject({
    isError: true,
    structuredContent: { status: "error", error: "boom" },
  });
});

test("each instance registers its own tools, bound to its own state", async () => {
  const mcp = await serve(new EchoTools("a"), new EchoTools("b"));
  const names = (await mcp.listTools()).tools.map((item) => item.name).sort();
  expect(names).toEqual(["a_echo", "a_explode", "b_echo", "b_explode"]);
  const response = await mcp.callTool({ name: "b_echo", arguments: { text: "x", times: 2 } });
  expect(response.structuredContent).toEqual({ status: "completed", text: "b:xx" });
});
