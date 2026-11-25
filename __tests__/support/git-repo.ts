import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitRepo = {
  dir: string;
  git(...args: string[]): Promise<string>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  /** Stages everything and commits; returns the new commit SHA. */
  commit(message: string): Promise<string>;
  remove(): Promise<void>;
};

/** A throwaway repository on branch `main` with an isolated, deterministic Git identity. */
export async function createRepo(): Promise<GitRepo> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eq-review-")));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = async (...args: string[]) =>
    (await execFileAsync("git", args, { cwd: dir, env })).stdout.trim();
  await git("init", "-q", "-b", "main");
  return {
    dir,
    git,
    async write(path, content) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    },
    async commit(message) {
      await git("add", "-A");
      await git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}
