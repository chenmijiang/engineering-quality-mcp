import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Glob } from "bun";

import { prompts } from "./prompts";

export const MAX_TEST_FILES = 50;

const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out"]);
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const TEST_NAME = /\.(?:test|spec)\.[^./]+$/;
const TEST_DIRS = new Set(["__tests__", "test", "tests"]);
const GLOB_MAGIC = /[*?[\]{}]/;

/** Discovered test file: a script under a test directory or named `*.test.*` / `*.spec.*`. */
function isTestFile(path: string): boolean {
  if (!SCRIPT_FILE.test(path) || path.endsWith(".d.ts")) return false;
  const segments = path.split("/");
  return TEST_NAME.test(path) || segments.slice(0, -1).some((segment) => TEST_DIRS.has(segment));
}

async function* walk(root: string, dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walk(root, path);
    } else if (entry.isFile()) {
      yield relative(root, path).split(sep).join("/");
    }
  }
}

/**
 * Resolves scope entries (paths or globs relative to `projectDir`) to sorted, project-relative test files.
 * Directories and globs are filtered to discovered test files; explicit files are taken as given.
 * Throws with a caller-facing message when the scope is invalid, empty, or too large.
 */
export async function resolveTestFiles(projectDir: string, scope: string[]): Promise<string[]> {
  if (!isAbsolute(projectDir)) throw new Error("project_dir must be an absolute path");
  const root = resolve(projectDir);
  if (!(await stat(root).catch(() => undefined))?.isDirectory()) {
    throw new Error(`project_dir is not a directory: ${root}`);
  }

  const files = new Set<string>();
  for (const entry of scope) {
    if (GLOB_MAGIC.test(entry)) {
      if (isAbsolute(entry) || entry.split("/").includes("..")) {
        throw new Error(`Scope glob must stay inside project_dir: ${entry}`);
      }
      const glob = new Glob(entry);
      for await (const path of walk(root, root)) {
        if (glob.match(path) && isTestFile(path)) files.add(path);
      }
      continue;
    }
    const target = resolve(root, entry);
    const path = relative(root, target);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error(`Scope path must stay inside project_dir: ${entry}`);
    const info = await stat(target).catch(() => undefined);
    if (!info) throw new Error(`Scope path does not exist: ${entry}`);
    if (info.isFile()) {
      files.add(path.split(sep).join("/"));
      continue;
    }
    for await (const file of walk(root, target)) if (isTestFile(file)) files.add(file);
  }

  if (files.size === 0) throw new Error(`No test files found in scope: ${scope.join(", ")}`);
  if (files.size > MAX_TEST_FILES) {
    throw new Error(
      `Scope matches ${files.size} test files (max ${MAX_TEST_FILES}); narrow scope and check in batches`,
    );
  }
  return [...files].sort();
}

export function checkTestPrompt(files: string[], instructions?: string): string {
  const sections = [
    prompts.checkTest,
    `<rubric>\n${prompts.testingQuality}\n</rubric>`,
    `<test-files>\n${files.join("\n")}\n</test-files>`,
  ];
  if (instructions) sections.push(`<host-instructions>\n${instructions}\n</host-instructions>`);
  return sections.join("\n\n");
}
