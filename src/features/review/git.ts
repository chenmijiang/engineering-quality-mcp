import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

// Read-only Git: no optional locks, prompts, repository-configured fsmonitor, or index refresh
// writes; pathspecs are literal so file names cannot act as Git magic.
const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LITERAL_PATHSPECS: "1",
  LC_ALL: "C",
};
const GIT_CONFIG = ["-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Thrown when git writes more than the caller's `maxBytes`; the process is killed. */
export class OutputLimitError extends Error {}

/** Runs git without a shell and returns stdout; exit codes outside `ok` reject with stderr. */
export function git(
  repo: string,
  args: string[],
  {
    signal,
    ok = [0],
    maxBytes = MAX_OUTPUT_BYTES,
  }: { signal?: AbortSignal; ok?: number[]; maxBytes?: number } = {},
): Promise<{ stdout: string; bytes: Buffer; exitCode: number }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    bytes: Buffer;
    exitCode: number;
  }>();
  // Inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS, ...)
  // could redirect git away from `repo` or reconfigure it.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const child = spawn("git", [...GIT_CONFIG, ...args], {
    cwd: repo,
    env: { ...env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) child.kill();
    else out.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  child.on("error", reject);
  child.on("close", (code) => {
    if (size > maxBytes) {
      reject(new OutputLimitError(`git ${args[0]} output exceeds ${maxBytes} bytes`));
    } else if (code !== null && ok.includes(code)) {
      const bytes = Buffer.concat(out);
      resolve({ stdout: bytes.toString("utf8"), bytes, exitCode: code });
    } else {
      const message = Buffer.concat(err).toString("utf8").trim() || `exit code ${code}`;
      reject(new Error(`git ${args[0]} failed: ${message}`));
    }
  });
  return promise;
}

/**
 * Returns a repository-relative POSIX path, or throws for paths that could escape the repository
 * or be read as options. Accepts a leading `./`.
 */
export function repoPath(path: string): string {
  const normalized = path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    normalized.startsWith("-") ||
    normalized.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new Error(`Invalid repository-relative path: ${JSON.stringify(path)}`);
  }
  return normalized;
}

/** Resolves any directory inside a work tree to its canonical top level. */
export async function resolveRepo(dir: string, signal?: AbortSignal): Promise<string> {
  if (!isAbsolute(dir)) throw new Error("repo must be an absolute path");
  const info = await lstat(dir).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`repo is not a directory: ${dir}`);
  const { stdout } = await git(dir, ["rev-parse", "--show-toplevel"], { signal }).catch(() => {
    throw new Error(`Not inside a Git work tree: ${dir}`);
  });
  return realpath(stdout.trim());
}

/** Pins a user-supplied ref to a commit SHA; never falls back to another ref. */
export async function resolveCommit(repo: string, ref: string, signal?: AbortSignal) {
  if (ref.startsWith("-")) throw new Error(`Invalid ref: ${ref}`);
  const result = await git(
    repo,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { signal, ok: [0, 1] },
  );
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !sha) throw new Error(`Unknown commit: ${ref}`);
  return sha;
}

export async function emptyTree(repo: string, signal?: AbortSignal) {
  const { stdout } = await git(repo, ["hash-object", "-t", "tree", "/dev/null"], { signal });
  return stdout.trim();
}

/**
 * Reads a work tree file without following symbolic links out of the repository.
 * Returns undefined when the path is missing, not a regular file, or a symlink.
 */
export async function readWorktreeFile(repo: string, path: string, maxBytes: number) {
  const full = join(repo, path);
  const info = await lstat(full).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const real = await realpath(full);
  if (!real.startsWith(repo + sep)) return undefined;
  if (info.size > maxBytes) return { tooLarge: true as const, size: info.size };
  return { content: await readFile(real) };
}

/** Binary when the first 8000 bytes contain NUL, as Git decides, or the content is not UTF-8. */
export function isBinary(content: Buffer): boolean {
  if (content.subarray(0, 8000).includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return false;
  } catch {
    return true;
  }
}
