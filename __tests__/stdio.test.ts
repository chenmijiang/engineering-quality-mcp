import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

async function expectServerToInitializeAndPing(command: string, args: string[]) {
  const workspace = await mkdtemp(join(tmpdir(), "eq-stdio-smoke-"));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: workspace,
    env: { PATH: process.env.PATH ?? "", HOME: workspace },
  });

  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({
      name: "engineering-quality-mcp",
      version: "1.0.0",
    });
    await expect(client.ping()).resolves.toEqual({});
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "ask_pi",
      "cancel_pi",
      "reply_pi",
      "review_code",
    ]);
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

test("a client can initialize and ping the stdio server from source", async () => {
  await expectServerToInitializeAndPing("bun", [resolve("src/index.ts")]);
});

test("a client can initialize and ping the built stdio server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engineering-quality-mcp-"));
  const bundle = join(directory, "index.js");

  try {
    await execFileAsync("bun", ["run", "build", "--outdir", directory], {
      cwd: process.cwd(),
      timeout: 20_000,
    });
    await expectServerToInitializeAndPing("bun", [bundle]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
