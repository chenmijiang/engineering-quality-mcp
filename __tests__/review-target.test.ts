import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { resolveRepo } from "@/features/review/git";
import {
  captureChanges,
  MAX_PATCH_BYTES,
  MAX_REVIEW_FILES,
  resolveTarget,
  type Change,
  type TargetRequest,
} from "@/features/review/target";

import { createRepo, type GitRepo } from "./support/git-repo";

let repo: GitRepo;

afterEach(async () => {
  await repo?.remove();
});

async function review(request: TargetRequest = {}, paths: string[] = []) {
  const target = await resolveTarget(repo.dir, request);
  return { target, changes: await captureChanges(target, paths) };
}

const summary = (changes: Change[]) =>
  changes.map(({ status, path, oldPath, skipped }) => ({ status, path, oldPath, skipped }));

describe("workspace", () => {
  test("reviews the net change from HEAD to the work tree across staged and unstaged edits", async () => {
    repo = await createRepo();
    await repo.write("a.ts", "one\n");
    const head = await repo.commit("init");
    await repo.write("a.ts", "two\n");
    await repo.git("add", "a.ts");
    await repo.write("a.ts", "three\n");

    const { target, changes } = await review();

    expect(target).toMatchObject({ mode: "workspace", base: head });
    expect(target.head).toBeUndefined();
    expect(summary(changes)).toEqual([{ status: "modified", path: "a.ts" }]);
    expect(changes[0]!.patch).toContain("-one\n+three");
    expect(changes[0]!.patch).not.toContain("two");
  });

  test("a staged edit reverted in the work tree is not a change", async () => {
    repo = await createRepo();
    await repo.write("a.ts", "one\n");
    await repo.commit("init");
    await repo.write("a.ts", "two\n");
    await repo.git("add", "a.ts");
    await repo.write("a.ts", "one\n");

    expect((await review()).changes).toEqual([]);
  });

  test("includes untracked files, honours .gitignore, and lists excluded directories as not reviewable", async () => {
    repo = await createRepo();
    await repo.write(".gitignore", "ignored.ts\n");
    await repo.commit("init");
    await repo.write("new.ts", "export const x = 1;\n");
    await repo.write("ignored.ts", "secret\n");
    await repo.write("node_modules/pkg/index.js", "module\n");

    const { changes } = await review();

    expect(summary(changes)).toEqual([
      { status: "added", path: "new.ts" },
      { status: "added", path: "node_modules/pkg/index.js", skipped: "excluded directory" },
    ]);
    expect(changes[0]).toMatchObject({ untracked: true });
    expect(changes[0]!.patch).toContain("+export const x = 1;");
  });

  test("leaves the index and refs untouched", async () => {
    repo = await createRepo();
    await repo.write("a.ts", "one\n");
    await repo.commit("init");
    await repo.write("a.ts", "two\n");
    const index = await readFile(join(repo.dir, ".git", "index"));
    const head = await repo.git("rev-parse", "HEAD");

    await review();

    expect(await readFile(join(repo.dir, ".git", "index"))).toEqual(index);
    expect(await repo.git("rev-parse", "HEAD")).toBe(head);
  });

  test("an unborn branch compares against the empty tree", async () => {
    repo = await createRepo();
    await repo.write("a.ts", "one\n");
    await repo.git("add", "a.ts");

    const { target, changes } = await review();

    expect(target.base).toBe(await repo.git("hash-object", "-t", "tree", "/dev/null"));
    expect(summary(changes)).toEqual([{ status: "added", path: "a.ts" }]);
  });

  test("a HEAD that points to a missing object is an error, not an empty repository", async () => {
    repo = await createRepo();
    await repo.commit("init");
    await repo.git("update-ref", "--no-deref", "-d", "HEAD");
    await Bun.write(join(repo.dir, ".git", "HEAD"), "0123456789012345678901234567890123456789\n");

    await expect(resolveTarget(repo.dir, {})).rejects.toThrow(
      "HEAD does not point to a valid commit",
    );
  });

  test("unresolved merge conflicts block the review", async () => {
    repo = await createRepo();
    await repo.write("a.ts", "base\n");
    await repo.commit("init");
    await repo.git("checkout", "-q", "-b", "other");
    await repo.write("a.ts", "other\n");
    await repo.commit("other");
    await repo.git("checkout", "-q", "main");
    await repo.write("a.ts", "main\n");
    await repo.commit("main");
    await expect(repo.git("merge", "-q", "other")).rejects.toThrow();

    await expect(resolveTarget(repo.dir, {})).rejects.toThrow("unresolved merge conflicts");
  });

  test("binary files and symlinks are listed as not reviewable", async () => {
    repo = await createRepo();
    await repo.commit("init");
    await repo.write("image.bin", new Uint8Array([0, 1, 2, 0]));
    await symlink("/etc/hosts", join(repo.dir, "link"));

    const { changes } = await review();

    expect(summary(changes)).toEqual([
      { status: "added", path: "image.bin", skipped: "binary" },
      { status: "added", path: "link", skipped: "symlink" },
    ]);
  });

  test("untracked files in excluded directories do not count toward the file limit", async () => {
    repo = await createRepo();
    await repo.commit("init");
    await repo.write("app.ts", "app\n");
    for (let i = 0; i <= MAX_REVIEW_FILES; i++) await repo.write(`vendor/dep${i}.js`, "dep\n");

    const { changes } = await review();

    expect(changes.filter((change) => !change.skipped).map((change) => change.path)).toEqual([
      "app.ts",
    ]);
    expect(changes.filter((change) => change.skipped === "excluded directory")).toHaveLength(
      MAX_REVIEW_FILES + 1,
    );
  });

  test("more reviewable files than the limit are rejected before capturing patches", async () => {
    repo = await createRepo();
    await repo.commit("init");
    for (let i = 0; i <= MAX_REVIEW_FILES; i++) await repo.write(`src/f${i}.ts`, "x\n");

    await expect(review()).rejects.toThrow(`exceed the limit of ${MAX_REVIEW_FILES}`);
  });

  test("a tracked patch over the size limit is not reviewable and does not fail the review", async () => {
    repo = await createRepo();
    await repo.write("big.txt", "a\n");
    await repo.write("small.ts", "one\n");
    await repo.commit("init");
    await repo.write(
      "big.txt",
      "x"
        .repeat(80)
        .concat("\n")
        .repeat(MAX_PATCH_BYTES / 80),
    );
    await repo.write("small.ts", "two\n");

    expect(summary((await review()).changes)).toEqual([
      { status: "modified", path: "big.txt", skipped: "too large" },
      { status: "modified", path: "small.ts" },
    ]);
  });

  test("paths limit the review literally", async () => {
    repo = await createRepo();
    await repo.commit("init");
    await repo.write("src/a.ts", "a\n");
    await repo.write("lib/b.ts", "b\n");
    await repo.write("[x].ts", "x\n");

    expect(summary((await review({}, ["src"])).changes)).toEqual([
      { status: "added", path: "src/a.ts" },
    ]);
    expect(summary((await review({}, ["[x].ts"])).changes)).toEqual([
      { status: "added", path: "[x].ts" },
    ]);
  });
});

describe("commit", () => {
  test("compares a commit with its first parent and a root commit with the empty tree", async () => {
    repo = await createRepo();
    await repo.write("a.ts", "one\n");
    const root = await repo.commit("root");
    await repo.write("a.ts", "two\n");
    await repo.write("b.ts", "b\n");
    const second = await repo.commit("second");
    await repo.write("a.ts", "work tree edit\n");

    const latest = await review({ commit: "HEAD" });
    expect(latest.target).toMatchObject({ mode: "commit", base: root, head: second });
    expect(summary(latest.changes)).toEqual([
      { status: "modified", path: "a.ts" },
      { status: "added", path: "b.ts" },
    ]);
    expect(latest.changes[0]!.patch).toContain("+two");

    const first = await review({ commit: root });
    expect(summary(first.changes)).toEqual([{ status: "added", path: "a.ts" }]);
  });

  test("a merge commit is compared with its first parent", async () => {
    repo = await createRepo();
    await repo.write("base.ts", "base\n");
    await repo.commit("init");
    await repo.git("checkout", "-q", "-b", "feature");
    await repo.write("feature.ts", "feature\n");
    await repo.commit("feature");
    await repo.git("checkout", "-q", "main");
    await repo.write("main.ts", "main\n");
    const mainHead = await repo.commit("main");
    await repo.git("merge", "-q", "--no-edit", "feature");

    const { target, changes } = await review({ commit: "HEAD" });

    expect(target.base).toBe(mainHead);
    expect(summary(changes)).toEqual([{ status: "added", path: "feature.ts" }]);
  });

  test("detects renames", async () => {
    repo = await createRepo();
    await repo.write("old.ts", "a\nb\nc\nd\n");
    await repo.commit("init");
    await repo.git("mv", "old.ts", "new.ts");
    await repo.commit("rename");

    const { changes } = await review({ commit: "HEAD" });

    expect(summary(changes)).toEqual([{ status: "renamed", path: "new.ts", oldPath: "old.ts" }]);
  });

  test("a parent hidden by a shallow clone is reported, not treated as a root", async () => {
    repo = await createRepo();
    await repo.write("a.ts", "one\n");
    await repo.commit("one");
    await repo.write("a.ts", "two\n");
    await repo.commit("two");
    const source = repo;
    repo = await createRepo();
    try {
      await repo.git("fetch", "-q", "--depth=1", `file://${source.dir}`, "main");

      await expect(resolveTarget(repo.dir, { commit: "FETCH_HEAD" })).rejects.toThrow(
        "deepen the clone history",
      );
    } finally {
      await source.remove();
    }
  });

  test("an unknown ref is an error and is not replaced by HEAD", async () => {
    repo = await createRepo();
    await repo.commit("init");

    await expect(resolveTarget(repo.dir, { commit: "missing" })).rejects.toThrow(
      "Unknown commit: missing",
    );
    await expect(resolveTarget(repo.dir, { commit: "--all" })).rejects.toThrow("Invalid ref");
  });
});

describe("range", () => {
  async function forkedRepo() {
    repo = await createRepo();
    await repo.write("base.ts", "base\n");
    const base = await repo.commit("init");
    await repo.git("checkout", "-q", "-b", "feature");
    await repo.write("feature.ts", "feature\n");
    await repo.commit("feature");
    await repo.git("checkout", "-q", "main");
    await repo.write("main.ts", "main only\n");
    await repo.commit("main");
    await repo.git("checkout", "-q", "feature");
    await repo.write("dirty.ts", "work tree only\n");
    return base;
  }

  test("reviews from the merge base to the end, excluding main-only and work tree changes", async () => {
    const base = await forkedRepo();

    const implicit = await review({ from: "main" });
    const explicit = await review({ from: "main", to: "HEAD" });

    expect(implicit.target).toMatchObject({ mode: "range", base });
    expect(summary(implicit.changes)).toEqual([{ status: "added", path: "feature.ts" }]);
    expect(explicit).toEqual(implicit);
  });

  test("unrelated histories have no merge base", async () => {
    repo = await createRepo();
    await repo.commit("main");
    await repo.git("checkout", "-q", "--orphan", "other");
    await repo.commit("other");

    await expect(resolveTarget(repo.dir, { from: "main" })).rejects.toThrow("no common ancestor");
  });

  test.each([
    [{ to: "HEAD" }, "to requires from"],
    [{ commit: "HEAD", from: "HEAD" }, "commit cannot be combined"],
  ])("rejects inconsistent targets %j", async (request, error) => {
    repo = await createRepo();
    await repo.commit("init");

    await expect(resolveTarget(repo.dir, request)).rejects.toThrow(error);
  });
});

test("inherited GIT_DIR and GIT_WORK_TREE do not redirect the review to another repository", async () => {
  repo = await createRepo();
  await repo.write("a.ts", "one\n");
  await repo.commit("init");
  await repo.write("a.ts", "two\n");
  const other = await createRepo();
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    await other.write("other.ts", "other\n");
    await other.commit("other");
    process.env.GIT_DIR = join(other.dir, ".git");
    process.env.GIT_WORK_TREE = other.dir;

    expect(await resolveRepo(repo.dir)).toBe(repo.dir);
    expect(summary((await review()).changes)).toEqual([{ status: "modified", path: "a.ts" }]);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await other.remove();
  }
});

test("a subdirectory resolves to the canonical repository root", async () => {
  repo = await createRepo();
  await repo.write("src/a.ts", "a\n");

  expect(await resolveRepo(join(repo.dir, "src"))).toBe(repo.dir);
  await expect(resolveRepo("relative/path")).rejects.toThrow("absolute");
});
