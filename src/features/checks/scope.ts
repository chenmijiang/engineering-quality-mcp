import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Glob } from "bun";

const IGNORED_DIRS: Record<string, true> = {
  node_modules: true,
  dist: true,
  build: true,
  coverage: true,
  out: true,
};
const GLOB_MAGIC = /[*?[\]{}]/;

export interface ScopeOptions {
  /** Filters files found through directories and globs; explicit file entries bypass it. */
  isTarget: (path: string) => boolean;
  /** Plural noun for errors, e.g. "test files". */
  label: string;
  maxFiles: number;
}

async function* walk(root: string, dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!Object.hasOwn(IGNORED_DIRS, entry.name)) yield* walk(root, path);
    } else if (entry.isFile()) {
      yield relative(root, path).split(sep).join("/");
    }
  }
}

/**
 * Resolves scope entries (paths or globs relative to `projectDir`) to sorted, project-relative files.
 * Skips hidden and build/dependency directories while walking.
 * Throws with a caller-facing message when the scope is invalid, empty, or too large.
 */
export async function resolveScope(
  projectDir: string,
  scope: string[],
  { isTarget, label, maxFiles }: ScopeOptions,
): Promise<string[]> {
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
        if (glob.match(path) && isTarget(path)) files.add(path);
      }
      continue;
    }
    const target = resolve(root, entry);
    const path = relative(root, target);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error(`Scope path must stay inside project_dir: ${entry}`);
    }
    const info = await stat(target).catch(() => undefined);
    if (!info) throw new Error(`Scope path does not exist: ${entry}`);
    if (info.isFile()) {
      files.add(path.split(sep).join("/"));
      continue;
    }
    for await (const file of walk(root, target)) if (isTarget(file)) files.add(file);
  }

  if (files.size === 0) throw new Error(`No ${label} found in scope: ${scope.join(", ")}`);
  if (files.size > maxFiles) {
    throw new Error(
      `Scope matches ${files.size} ${label} (max ${maxFiles}); narrow scope and check in batches`,
    );
  }
  return [...files].sort();
}
