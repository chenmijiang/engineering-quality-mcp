import { z } from "zod";

import type { AgentTool } from "@/core/contracts";

import { git, isBinary, readWorktreeFile, repoPath } from "./git";
import { isExcluded, type Change, type ReviewTarget } from "./target";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINES = 400;
const MAX_LINE_CHARS = 2000;
const MAX_MATCHES = 200;
const MAX_LISTED = 1000;

const rev = z
  .enum(["base", "head"])
  .describe("base: the version changes are compared against; head: the version under review");
const optionalPath = z
  .string()
  .min(1)
  .optional()
  .describe("Repository-relative file or directory; omit for the whole repository");

function defineTool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.output<S>, signal?: AbortSignal) => Promise<string>,
): AgentTool {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema, { io: "input" });
  return {
    name,
    description,
    parameters,
    execute: (args, signal) => run(schema.parse(args), signal),
  };
}

function clip(line: string) {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [line truncated]` : line;
}

/**
 * Read-only views of the review target pinned to its base and head. In commit and range mode
 * these are the only way to read the reviewed revisions: the work tree may hold other content.
 */
export function reviewTools(target: ReviewTarget, changes: Change[]): AgentTool[] {
  const { repo } = target;
  const commitOf = (side: "base" | "head") => (side === "base" ? target.base : target.head);
  const label = (side: "base" | "head") => {
    const sha = commitOf(side);
    return sha ? `${side} ${sha.slice(0, 12)}` : "head (working tree)";
  };
  const optionalPathspec = (path?: string) => (path ? [repoPath(path)] : []);

  async function readText(side: "base" | "head", path: string, signal?: AbortSignal) {
    const sha = commitOf(side);
    if (!sha) {
      const file = await readWorktreeFile(repo, path, MAX_FILE_BYTES);
      if (!file) throw new Error(`${path} is not a regular file in the working tree`);
      if ("tooLarge" in file) throw new Error(`${path} is too large to read (${file.size} bytes)`);
      return file.content;
    }
    const object = `${sha}:${path}`;
    const type = await git(repo, ["cat-file", "-t", object], { signal, ok: [0, 128] });
    if (type.exitCode !== 0) throw new Error(`${path} does not exist at ${label(side)}`);
    if (type.stdout.trim() !== "blob") throw new Error(`${path} is not a file at ${label(side)}`);
    const size = Number((await git(repo, ["cat-file", "-s", object], { signal })).stdout.trim());
    if (size > MAX_FILE_BYTES) throw new Error(`${path} is too large to read (${size} bytes)`);
    return (await git(repo, ["cat-file", "blob", object], { signal })).bytes;
  }

  return [
    defineTool(
      "read_diff",
      "Read the captured unified diff of one changed file listed in the task. Accepts the new path, or the old path of a rename or deletion.",
      z.object({ path: z.string().min(1).describe("Changed file path as listed in the task") }),
      async ({ path }) => {
        const wanted = repoPath(path);
        const matches = changes.filter((c) => c.path === wanted || c.oldPath === wanted);
        if (!matches.length) throw new Error(`${path} is not a changed file of this review`);
        return matches
          .map((c) => {
            const name = c.oldPath ? `${c.oldPath} -> ${c.path}` : c.path;
            const header = `# ${c.status}${c.untracked ? " (untracked)" : ""}: ${name}`;
            return c.skipped ? `${header}\nNot reviewable: ${c.skipped}` : `${header}\n${c.patch}`;
          })
          .join("\n\n");
      },
    ),
    defineTool(
      "read_file_at",
      `Read numbered lines of a file at the base or head revision of the review, up to ${MAX_LINES} lines per call.`,
      z.object({
        path: z.string().min(1).describe("Repository-relative file path"),
        rev,
        start_line: z.int().min(1).default(1),
        line_count: z.int().min(1).max(MAX_LINES).default(MAX_LINES),
      }),
      async ({ path, rev: side, start_line, line_count }, signal) => {
        const file = repoPath(path);
        const content = await readText(side, file, signal);
        if (isBinary(content)) throw new Error(`${file} is binary`);
        const lines = content.toString("utf8").split("\n");
        if (lines.at(-1) === "") lines.pop();
        if (start_line > Math.max(lines.length, 1)) {
          throw new Error(`start_line ${start_line} is past the end (${lines.length} lines)`);
        }
        const end = Math.min(lines.length, start_line + line_count - 1);
        const body = lines
          .slice(start_line - 1, end)
          .map((line, index) => `${start_line + index}\t${clip(line)}`);
        const more = end < lines.length ? `\n[more: start_line=${end + 1}]` : "";
        return `${file} @ ${label(side)}, lines ${start_line}-${end} of ${lines.length}\n${body.join("\n")}${more}`;
      },
    ),
    defineTool(
      "grep_at",
      `Search text files at the base or head revision for a literal, case-sensitive string. Returns up to ${MAX_MATCHES} path:line matches.`,
      z.object({ text: z.string().min(1), rev, path: optionalPath }),
      async ({ text, rev: side, path }, signal) => {
        const sha = commitOf(side);
        const args = ["grep", "-n", "-z", "-I", "-F", "--no-color", "-e", text];
        if (sha) args.push(sha);
        else args.push("--untracked");
        const { stdout } = await git(repo, [...args, "--", ...optionalPathspec(path)], {
          signal,
          ok: [0, 1],
        });
        const prefix = sha ? `${sha}:` : "";
        const matches = stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\0"))
          .map(([file = "", lineNo, ...rest]) => ({
            file: file.startsWith(prefix) ? file.slice(prefix.length) : file,
            line: `${lineNo}: ${clip(rest.join("\0"))}`,
          }))
          .filter(({ file }) => !isExcluded(file));
        if (!matches.length) return `No matches at ${label(side)}`;
        const shown = matches.slice(0, MAX_MATCHES).map(({ file, line }) => `${file}:${line}`);
        const note =
          matches.length > MAX_MATCHES
            ? `\n[${matches.length - MAX_MATCHES} more matches; narrow path or text]`
            : "";
        return `${shown.join("\n")}${note}`;
      },
    ),
    defineTool(
      "list_files_at",
      `List files at the base or head revision, up to ${MAX_LISTED} paths.`,
      z.object({ rev, path: optionalPath }),
      async ({ rev: side, path }, signal) => {
        const sha = commitOf(side);
        const args = sha
          ? ["ls-tree", "-r", "-z", "--name-only", sha]
          : ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"];
        const { stdout } = await git(repo, [...args, "--", ...optionalPathspec(path)], { signal });
        const files = stdout
          .split("\0")
          .filter((file) => file && !isExcluded(file))
          .sort();
        if (!files.length) return `No files at ${label(side)}`;
        const note =
          files.length > MAX_LISTED ? `\n[${files.length - MAX_LISTED} more; narrow path]` : "";
        return `${files.slice(0, MAX_LISTED).join("\n")}${note}`;
      },
    ),
  ];
}
