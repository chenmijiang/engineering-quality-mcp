import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  DIFF_FLAGS,
  emptyTree,
  git,
  isBinary,
  OutputLimitError,
  readWorktreeFile,
  resolveCommit,
} from "./git";

/** Directory names whose files are never reviewed, at any depth. */
const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  ".idea": true,
  ".svn": true,
  ".vscode": true,
  node_modules: true,
  target: true,
  vendor: true,
};
export const MAX_PATCH_BYTES = 512 * 1024;
export const MAX_REVIEW_FILES = 100;

export type TargetRequest = { commit?: string; from?: string; to?: string };

export interface ReviewTarget {
  mode: "workspace" | "commit" | "range";
  repo: string;
  /** Commit or tree the changes are compared against. */
  base: string;
  /** Commit under review; undefined means the live work tree. */
  head?: string;
  /** What the caller asked for, before refs were pinned. */
  requested: string;
}

export type SkipReason =
  | "excluded directory"
  | "binary"
  | "too large"
  | "symlink"
  | "submodule"
  | "unreadable";

export interface Change {
  status: "added" | "modified" | "deleted" | "renamed" | "typechanged";
  /** New path; the old path for deletions. */
  path: string;
  /** Source path of a rename or copy. */
  oldPath?: string;
  untracked?: boolean;
  /** Unified diff against the base; absent when skipped. */
  patch?: string;
  skipped?: SkipReason;
}

/**
 * Pins the requested target to commits. Workspace: HEAD (or the empty tree on an unborn branch)
 * to the work tree. Commit: first parent (or the empty tree for a root) to the commit.
 * Range: merge base of `from` and `to` to `to`.
 */
export async function resolveTarget(
  repo: string,
  { commit, from, to }: TargetRequest,
  signal?: AbortSignal,
): Promise<ReviewTarget> {
  if (commit && (from || to)) throw new Error("commit cannot be combined with from/to");
  if (to && !from) throw new Error("to requires from");

  if (commit) {
    const head = await resolveCommit(repo, commit, signal);
    return {
      mode: "commit",
      repo,
      base: await firstParent(repo, head, signal),
      head,
      requested: `commit ${commit}`,
    };
  }
  if (from) {
    const end = to ?? "HEAD";
    const [start, head] = await Promise.all([
      resolveCommit(repo, from, signal),
      resolveCommit(repo, end, signal),
    ]);
    const mergeBase = await git(repo, ["merge-base", start, head], { signal, ok: [0, 1] });
    if (mergeBase.exitCode !== 0) throw new Error(`${from} and ${end} have no common ancestor`);
    return {
      mode: "range",
      repo,
      base: mergeBase.stdout.trim(),
      head,
      requested: `range ${from}...${end}`,
    };
  }

  const conflicts = await git(repo, ["ls-files", "--unmerged", "-z"], { signal });
  if (conflicts.stdout) throw new Error("The work tree has unresolved merge conflicts");
  return {
    mode: "workspace",
    repo,
    base: await workspaceBase(repo, signal),
    requested: "workspace",
  };
}

async function firstParent(repo: string, sha: string, signal?: AbortSignal) {
  const { stdout } = await git(repo, ["cat-file", "commit", sha], { signal });
  const parent = /^parent ([0-9a-f]+)$/m.exec(stdout.split("\n\n", 1)[0] ?? "")?.[1];
  if (!parent) return emptyTree(repo, signal);
  const exists = await git(repo, ["cat-file", "-e", `${parent}^{commit}`], {
    signal,
    ok: [0, 1, 128],
  });
  if (exists.exitCode !== 0) {
    throw new Error(`Parent ${parent} of ${sha} is missing; deepen the clone history first`);
  }
  return parent;
}

/** Only a confirmed unborn branch compares against the empty tree; a broken HEAD is an error. */
async function workspaceBase(repo: string, signal?: AbortSignal) {
  const head = await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    signal,
    ok: [0, 1],
  });
  if (head.exitCode === 0) return head.stdout.trim();
  const ref = await git(repo, ["symbolic-ref", "--quiet", "HEAD"], { signal, ok: [0, 1] });
  if (ref.exitCode === 0) {
    const exists = await git(repo, ["show-ref", "--verify", "--quiet", ref.stdout.trim()], {
      signal,
      ok: [0, 1],
    });
    if (exists.exitCode === 1) return emptyTree(repo, signal);
  }
  throw new Error("HEAD does not point to a valid commit");
}

const STATUS: Record<string, Change["status"]> = {
  A: "added",
  C: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "typechanged",
};

export function isExcluded(path: string) {
  return path.split("/").some((segment) => Object.hasOwn(EXCLUDED_DIRS, segment));
}

/** Parses `git diff --raw -z` records into changes, marking files that cannot be reviewed. */
function parseRaw(output: string): Change[] {
  const tokens = output.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const [srcMode, dstMode, , , code = ""] = tokens[i]!.slice(1).split(" ");
    const status = STATUS[code[0] ?? ""];
    if (!status) throw new Error(`Unexpected git diff status: ${code}`);
    const renamed = code[0] === "R" || code[0] === "C";
    const change: Change = renamed
      ? { status, oldPath: tokens[i + 1]!, path: tokens[i + 2]! }
      : { status, path: tokens[i + 1]! };
    i += renamed ? 3 : 2;
    const modes = [srcMode, dstMode];
    if (isExcluded(change.path) || (change.oldPath && isExcluded(change.oldPath))) {
      change.skipped = "excluded directory";
    } else if (modes.includes("160000")) change.skipped = "submodule";
    else if (modes.includes("120000")) change.skipped = "symlink";
    changes.push(change);
  }
  return changes;
}

function classifyPatch(patch: string): SkipReason | undefined {
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) return "too large";
  if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(patch)) return "binary";
  return undefined;
}

/** Returns undefined when the patch exceeds the size limit; reading stops at the limit. */
async function trackedPatch(target: ReviewTarget, change: Change, signal?: AbortSignal) {
  const revisions = target.head ? [target.base, target.head] : [target.base];
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
  try {
    const { stdout } = await git(
      target.repo,
      ["diff", ...DIFF_FLAGS, "-U3", ...revisions, "--", ...paths],
      { signal, maxBytes: MAX_PATCH_BYTES },
    );
    return stdout;
  } catch (error) {
    if (error instanceof OutputLimitError) return undefined;
    throw error;
  }
}

async function untrackedChange(repo: string, path: string, signal?: AbortSignal) {
  const change: Change = { status: "added", path, untracked: true };
  if (path.endsWith("/")) return { ...change, skipped: "submodule" as const };
  if (isExcluded(path)) return { ...change, skipped: "excluded directory" as const };
  const file = await readWorktreeFile(repo, path, MAX_PATCH_BYTES);
  if (!file) {
    const link = (await lstat(join(repo, path)).catch(() => undefined))?.isSymbolicLink();
    return { ...change, skipped: link ? ("symlink" as const) : ("unreadable" as const) };
  }
  if ("tooLarge" in file) return { ...change, skipped: "too large" as const };
  if (isBinary(file.content)) return { ...change, skipped: "binary" as const };
  const { stdout } = await git(
    repo,
    ["diff", "--no-index", ...DIFF_FLAGS, "-U3", "--", "/dev/null", path],
    { signal, ok: [0, 1] },
  );
  return { ...change, patch: stdout };
}

/**
 * Lists the target's changed files with their patches, limited to literal `paths` when given.
 * Patches are captured once, so follow-up questions see the same diff.
 */
export async function captureChanges(
  target: ReviewTarget,
  paths: string[],
  signal?: AbortSignal,
): Promise<Change[]> {
  const { repo, base, head } = target;
  const raw = await git(
    repo,
    ["diff", "--raw", "-z", ...DIFF_FLAGS, base, ...(head ? [head] : []), "--", ...paths],
    { signal },
  );
  const tracked = parseRaw(raw.stdout);
  const untracked = head
    ? []
    : (
        await git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], {
          signal,
        })
      ).stdout
        .split("\0")
        .filter(Boolean);

  // Binary and oversized files are only known after capturing their patches, so they count.
  const eligible =
    tracked.filter((change) => !change.skipped).length +
    untracked.filter((path) => !isExcluded(path)).length;
  if (eligible > MAX_REVIEW_FILES) {
    throw new Error(
      `${eligible} changed files exceed the limit of ${MAX_REVIEW_FILES}; narrow with paths, a commit, or a smaller range`,
    );
  }

  const changes: Change[] = [];
  for (const change of tracked) {
    if (!change.skipped) {
      const patch = await trackedPatch(target, change, signal);
      // The index is not refreshed, so stat-only differences can appear without content changes.
      if (patch === "") continue;
      change.skipped = patch === undefined ? "too large" : classifyPatch(patch);
      if (!change.skipped) change.patch = patch;
    }
    changes.push(change);
  }
  for (const path of untracked) {
    const change = await untrackedChange(repo, path, signal);
    if (change.patch) {
      const skipped = classifyPatch(change.patch);
      if (skipped) {
        changes.push({ ...change, patch: undefined, skipped });
        continue;
      }
    }
    changes.push(change);
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
