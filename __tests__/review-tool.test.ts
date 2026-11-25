import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test } from "vitest";

import { App } from "@/app";
import type { AgentRuntime, OpenSessionOptions } from "@/core/contracts";

import type { ToolResult } from "./support/fake-pi";
import { createRepo, type GitRepo } from "./support/git-repo";

const config = {
  cwd: tmpdir(),
  projectCwd: tmpdir(),
  agentDir: tmpdir(),
  sessionDir: tmpdir(),
  runTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  maxSessions: 8,
};

let app: App | undefined;
let client: Client | undefined;
let repo: GitRepo | undefined;
let opened: OpenSessionOptions | undefined;
let prompts: string[] = [];

const runtime: AgentRuntime = {
  async open(options) {
    opened = options;
    return {
      model: "fake/model",
      async prompt(text) {
        prompts.push(text);
        return "REPORT";
      },
      dispose() {},
    };
  },
  async shutdown() {},
};

async function connect() {
  app = new App(config, { runtime });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await app.createServer().connect(serverSide);
  client = new Client({ name: "generic-client", version: "1.0.0" });
  await client.connect(clientSide);
}

async function review(args: Record<string, unknown>) {
  const response = await client!.callTool({ name: "review_code", arguments: args });
  return { value: response.structuredContent as ToolResult, isError: response.isError === true };
}

function agentTool(name: string) {
  const tool = opened?.tools?.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`agent tool ${name} was not provided`);
  return (args: Record<string, unknown>) => tool.execute(args);
}

afterEach(async () => {
  await client?.close();
  await app?.shutdown();
  await repo?.remove();
  client = app = repo = opened = undefined;
  prompts = [];
});

test("review_code is listed as a read-only tool next to the session tools", async () => {
  await connect();
  const { tools } = await client!.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "ask_pi",
    "cancel_pi",
    "reply_pi",
    "review_code",
  ]);
  expect(tools.find((tool) => tool.name === "review_code")?.annotations?.readOnlyHint).toBe(true);
});

test("a commit review gives the agent the pinned revisions, not the current work tree", async () => {
  repo = await createRepo();
  await repo.write("src/auth.ts", "export const allow = false;\n");
  const base = await repo.commit("init");
  await repo.write("src/auth.ts", "export const allow = true;\n");
  const head = await repo.commit("open access");
  await repo.write("src/auth.ts", "export const allow = 'work tree';\n");
  await connect();

  const result = await review({
    repo: repo.dir,
    commit: "HEAD",
    instructions: "Answer in Chinese",
  });

  expect(result.value).toMatchObject({ status: "completed", text: "REPORT" });
  expect(opened?.cwd).toBe(repo.dir);
  expect(prompts[0]).toContain(`base: ${base}\nhead: ${head}`);
  expect(prompts[0]).toContain("<changes>\nmodified src/auth.ts\n</changes>");
  expect(prompts[0]).toContain("<host-instructions>\nAnswer in Chinese\n</host-instructions>");

  expect(await agentTool("read_diff")({ path: "src/auth.ts" })).toContain(
    "1\t-export const allow = false;\n1\t+export const allow = true;",
  );
  expect(await agentTool("read_file_at")({ path: "src/auth.ts", rev: "head" })).toContain(
    "1\texport const allow = true;",
  );
  expect(await agentTool("read_file_at")({ path: "src/auth.ts", rev: "base" })).toContain(
    "1\texport const allow = false;",
  );
  expect(await agentTool("grep_at")({ text: "allow", rev: "head" })).toBe(
    "src/auth.ts:1: export const allow = true;",
  );
  expect(await agentTool("list_files_at")({ rev: "head" })).toBe("src/auth.ts");
});

test("a workspace review reads the head from the live work tree", async () => {
  repo = await createRepo();
  await repo.write("a.ts", "committed\n");
  await repo.commit("init");
  await repo.write("a.ts", "edited\n");
  await repo.write("new.ts", "untracked\n");
  await connect();

  await review({ repo: repo.dir });

  expect(prompts[0]).toContain("head: working tree (live files)");
  expect(await agentTool("read_file_at")({ path: "a.ts", rev: "head" })).toContain("1\tedited");
  expect(await agentTool("read_file_at")({ path: "a.ts", rev: "base" })).toContain("1\tcommitted");
  expect(await agentTool("list_files_at")({ rev: "head" })).toBe("a.ts\nnew.ts");
  await rm(join(repo.dir, "a.ts"));
  expect(await agentTool("list_files_at")({ rev: "head" })).toBe("new.ts");
  expect(await agentTool("grep_at")({ text: "untracked", rev: "head" })).toBe(
    "new.ts:1: untracked",
  );
});

test("agent tools reject paths outside the repository and unknown changes", async () => {
  repo = await createRepo();
  await repo.write("a.ts", "one\n");
  await repo.commit("init");
  await repo.write("a.ts", "two\n");
  await connect();
  await review({ repo: repo.dir });

  const readFileAt = agentTool("read_file_at");
  await expect(readFileAt({ path: "../secret", rev: "head" })).rejects.toThrow(
    "Invalid repository-relative path",
  );
  await expect(readFileAt({ path: "/etc/hosts", rev: "head" })).rejects.toThrow(
    "Invalid repository-relative path",
  );
  await expect(readFileAt({ path: "missing.ts", rev: "base" })).rejects.toThrow("does not exist");
  await expect(readFileAt({ path: "a.ts", rev: "head", start_line: 5 })).rejects.toThrow(
    "past the end",
  );
  await expect(agentTool("read_diff")({ path: "other.ts" })).rejects.toThrow("not a changed file");
  await expect(agentTool("grep_at")({ text: "x", rev: "head", path: "../" })).rejects.toThrow(
    "Invalid repository-relative path",
  );
});

test("read_diff numbers removed lines by base and other lines by head", async () => {
  repo = await createRepo();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  await repo.write("a.ts", `${lines.join("\n")}\n`);
  await repo.commit("init");
  lines.splice(9, 1, "changed 10a", "changed 10b");
  await repo.write("a.ts", `${lines.join("\n")}\n`);
  await connect();
  await review({ repo: repo.dir });

  const diff = await agentTool("read_diff")({ path: "a.ts" });

  expect(diff).toContain("@@ -7,7 +7,8 @@");
  expect(diff).toContain(
    "9\t line 9\n10\t-line 10\n10\t+changed 10a\n11\t+changed 10b\n12\t line 11\n",
  );
});

test("read_file_at pages long files", async () => {
  repo = await createRepo();
  await repo.write("long.ts", Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n"));
  await repo.commit("long");
  await connect();
  await review({ repo: repo.dir, commit: "HEAD" });

  const first = await agentTool("read_file_at")({ path: "long.ts", rev: "head" });
  expect(first).toContain("lines 1-400 of 450");
  expect(first).toContain("[more: start_line=401]");
  const last = await agentTool("read_file_at")({ path: "long.ts", rev: "head", start_line: 401 });
  expect(last).toContain("lines 401-450 of 450");
  expect(last).toContain("450\tline 450");
});

test("nothing to review completes without starting an agent session", async () => {
  repo = await createRepo();
  await repo.write("a.ts", "one\n");
  await repo.commit("init");
  await repo.write("image.bin", new Uint8Array([0, 0, 0]));
  await connect();

  const empty = await review({ repo: repo.dir, paths: ["a.ts"] });
  expect(empty.value.status).toBe("completed");
  expect(empty.value.text).toContain("No changes to review.");
  expect(empty.value.session_id).toBeUndefined();

  const skipped = await review({ repo: repo.dir });
  expect(skipped.value.text).toContain("No reviewable files");
  expect(skipped.value.text).toContain("added image.bin (untracked; not reviewable: binary)");
  expect(opened).toBeUndefined();
});

test("invalid targets are tool errors before any agent session starts", async () => {
  repo = await createRepo();
  await repo.commit("init");
  await connect();

  const relative = await review({ repo: "relative" });
  expect(relative).toMatchObject({
    isError: true,
    value: { error: "repo must be an absolute path" },
  });
  const unknown = await review({ repo: repo.dir, commit: "nope" });
  expect(unknown).toMatchObject({ isError: true, value: { error: "Unknown commit: nope" } });
  const escaping = await review({ repo: repo.dir, paths: ["../x"] });
  expect(escaping.value.error).toContain("Invalid repository-relative path");
  expect(opened).toBeUndefined();
});

test("a follow-up continues the same agent session with its review tools", async () => {
  repo = await createRepo();
  await repo.write("a.ts", "one\n");
  await repo.commit("init");
  await repo.write("a.ts", "two\n");
  await connect();
  const first = await review({ repo: repo.dir });
  const session = opened;

  const followUp = await client!.callTool({
    name: "ask_pi",
    arguments: { session_id: first.value.session_id, prompt: "Explain finding 1" },
  });

  expect((followUp.structuredContent as ToolResult).status).toBe("completed");
  expect(prompts).toEqual([expect.stringContaining("<changes>"), "Explain finding 1"]);
  expect(opened).toBe(session);
  expect(opened?.tools?.map((tool) => tool.name)).toEqual([
    "read_diff",
    "read_file_at",
    "grep_at",
    "list_files_at",
  ]);
});
