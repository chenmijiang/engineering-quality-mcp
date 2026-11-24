import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { callTool, messageText, startFakeProvider, type FakeProvider } from "./support/fake-pi";

let fake: FakeProvider;
let client: Client;
let workspace: string;
let project: string;

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function makeProject(name: string, files: Record<string, string>) {
  const root = join(workspace, name);
  await writeFiles(root, files);
  return root;
}

const batch = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i}.test.ts`, ""]));

/** Calls check_test and returns its result plus the model prompts it caused. */
async function checkTest(args: Record<string, unknown>) {
  const before = fake.requests.length;
  const result = await callTool(client, "check_test", args);
  const prompts = fake.requests
    .slice(before)
    .map((messages) => messageText(messages.findLast((message) => message.role === "user")));
  return { ...result, prompt: prompts.find((prompt) => prompt.includes("<test-files>")) };
}

const listedFiles = (prompt = "") =>
  /<test-files>\n([\s\S]*?)\n<\/test-files>/.exec(prompt)?.[1]?.split("\n");

beforeAll(async () => {
  fake = await startFakeProvider();
  workspace = await mkdtemp(join(tmpdir(), "quality-analysis-mcp-check-"));
  project = await makeProject("project", {
    "src/sum.ts": "export const sum = (a: number, b: number) => a + b;\n",
    "src/sum.test.ts": "// SUM-TEST-MARKER\nexpect(sum(1, 2)).toBe(3);\n",
    "src/view.spec.tsx": "",
    "__tests__/api.ts": "",
    "__tests__/types.d.ts": "",
    "docs/guide.md": "",
    "node_modules/pkg/index.test.js": "",
    "dist/index.test.js": "",
    ".cache/stale.test.ts": "",
  });
  client = await fake.connect([resolve("src/index.ts")]);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await fake?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("check_test scope resolution", () => {
  test.each([
    {
      scope: ["."],
      files: ["__tests__/api.ts", "src/sum.test.ts", "src/view.spec.tsx"],
      case: "project root skips ignored, hidden, declaration, and non-test files",
    },
    { scope: ["src"], files: ["src/sum.test.ts", "src/view.spec.tsx"], case: "directory" },
    { scope: ["src/*.tsx"], files: ["src/view.spec.tsx"], case: "glob" },
    { scope: ["src/sum.ts"], files: ["src/sum.ts"], case: "explicit file is taken as given" },
    {
      scope: ["src", "src/sum.test.ts"],
      files: ["src/sum.test.ts", "src/view.spec.tsx"],
      case: "overlapping entries are deduplicated",
    },
  ])(
    "$case",
    async ({ scope, files }) => {
      const { value, prompt } = await checkTest({ project_dir: project, scope });
      expect(value.status).toBe("completed");
      expect(listedFiles(prompt)).toEqual(files);
    },
    30_000,
  );

  test("scope defaults to the whole project", async () => {
    const { prompt } = await checkTest({ project_dir: project });
    expect(listedFiles(prompt)).toEqual([
      "__tests__/api.ts",
      "src/sum.test.ts",
      "src/view.spec.tsx",
    ]);
  }, 30_000);

  test.each([
    { args: () => ({ project_dir: "project" }), error: "absolute" },
    { args: () => ({ project_dir: join(workspace, "missing") }), error: "not a directory" },
    { args: () => ({ project_dir: project, scope: ["missing"] }), error: "does not exist" },
    { args: () => ({ project_dir: project, scope: ["../outside"] }), error: "inside project_dir" },
    {
      args: () => ({ project_dir: project, scope: ["../**/*.test.ts"] }),
      error: "inside project_dir",
    },
    { args: () => ({ project_dir: project, scope: ["docs"] }), error: "No test files" },
  ])("rejects invalid scope without calling the model: $error", async ({ args, error }) => {
    const before = fake.requests.length;
    const result = await callTool(client, "check_test", args());
    expect(result.isError).toBe(true);
    expect(result.value.error).toContain(error);
    expect(fake.requests.length).toBe(before);
  });

  test("accepts exactly 50 test files", async () => {
    const root = await makeProject("batch-50", batch(50));
    const { value, prompt } = await checkTest({ project_dir: root });
    expect(value.status).toBe("completed");
    expect(listedFiles(prompt)).toHaveLength(50);
  }, 30_000);

  test("rejects 51 test files and asks to narrow the scope", async () => {
    const root = await makeProject("batch-51", batch(51));
    const result = await callTool(client, "check_test", { project_dir: root });
    expect(result.isError).toBe(true);
    expect(result.value.error).toContain("matches 51 test files (max 50)");
  });
});

describe("check_test review", () => {
  test("Pi receives the rubric and host instructions, and reads files from project_dir", async () => {
    const { value, prompt } = await checkTest({
      project_dir: project,
      scope: ["src/sum.test.ts"],
      instructions: "Write the report in Chinese.",
    });
    expect(prompt).toContain("<rubric>\nWrite every test as a specification of behavior");
    expect(prompt).toContain(
      "<host-instructions>\nWrite the report in Chinese.\n</host-instructions>",
    );
    expect(value.status).toBe("completed");
    expect(value.text).toContain("SUM-TEST-MARKER");
  }, 30_000);
});
