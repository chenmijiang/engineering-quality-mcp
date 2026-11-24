import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

async function expectServerToInitializeAndPing(command: string, args: string[]) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: process.cwd(),
  });

  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({ name: "quality-analysis-mcp", version: "1.0.0" });
    await expect(client.ping()).resolves.toEqual({});
  } finally {
    await client.close();
  }
}

test("a client can initialize and ping the stdio server from source", async () => {
  await expectServerToInitializeAndPing("bun", ["src/index.ts"]);
});

test("a client can initialize and ping the built stdio server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quality-analysis-mcp-"));
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
