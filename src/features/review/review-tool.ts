import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Result, SessionBroker } from "@/core/contracts";
import { tool, ToolModule } from "@/core/tool-module";

import { reviewTools } from "./agent-tools";
import { repoPath, resolveRepo } from "./git";
import taskPrompt from "./prompts/task.md" with { type: "text" };
import toolDescription from "./prompts/tool.md" with { type: "text" };
import { captureChanges, resolveTarget, type Change, type ReviewTarget } from "./target";

const ref = z.string().min(1).max(1000);
const reviewInput = z.object({
  repo: z.string().min(1).describe("Absolute path of a directory inside the Git work tree"),
  commit: ref.optional().describe("Review this commit against its first parent"),
  from: ref.optional().describe("Review the range from the merge base of from and to, up to to"),
  to: ref.optional().describe("End of the range; defaults to HEAD; requires from"),
  paths: z
    .array(z.string().min(1))
    .max(100)
    .optional()
    .describe("Limit to these repository-relative files or directories (literal, no globs)"),
  instructions: z
    .string()
    .max(10_000)
    .optional()
    .describe("Extra reviewer guidance, such as focus areas or report language"),
});
type ReviewInput = z.output<typeof reviewInput>;

function describeTarget(target: ReviewTarget, paths: string[]) {
  const lines = [
    `mode: ${target.mode}`,
    `requested: ${target.requested}`,
    `repository: ${target.repo}`,
    `base: ${target.base}`,
    `head: ${target.head ?? "working tree (live files)"}`,
  ];
  if (paths.length) lines.push(`paths: ${paths.join(", ")}`);
  return lines.join("\n");
}

function describeChange(change: Change) {
  const name = change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path;
  const notes = [
    change.untracked && "untracked",
    change.skipped && `not reviewable: ${change.skipped}`,
  ];
  const suffix = notes.filter(Boolean).join("; ");
  return `${change.status} ${name}${suffix ? ` (${suffix})` : ""}`;
}

/** `review_code`: pins a Git target and its diff on the server, then starts a Pi review session. */
export class ReviewTool extends ToolModule {
  constructor(private readonly sessions: SessionBroker) {
    super();
  }

  @tool({
    name: "review_code",
    description: toolDescription.trim(),
    inputSchema: reviewInput,
    annotations: { readOnlyHint: true },
  })
  async review(
    { repo: dir, commit, from, to, paths = [], instructions }: ReviewInput,
    ctx: ServerContext,
  ): Promise<Result> {
    const signal = ctx.mcpReq.signal;
    const scope = paths.map(repoPath);
    const repo = await resolveRepo(dir, signal);
    const target = await resolveTarget(repo, { commit, from, to }, signal);
    const changes = await captureChanges(target, scope, signal);
    const summary = describeTarget(target, scope);
    if (!changes.length)
      return { status: "completed", text: `No changes to review.\n\n${summary}` };
    const list = changes.map(describeChange).join("\n");
    if (changes.every((change) => change.skipped)) {
      return {
        status: "completed",
        text: `No reviewable files; nothing was reviewed.\n\n${summary}\n\n${list}`,
      };
    }

    const sections = [
      taskPrompt.trim(),
      `<target>\n${summary}\n</target>`,
      `<changes>\n${list}\n</changes>`,
    ];
    if (instructions) sections.push(`<host-instructions>\n${instructions}\n</host-instructions>`);
    return this.sessions.ask(
      { prompt: sections.join("\n\n"), cwd: repo, tools: reviewTools(target, changes) },
      signal,
    );
  }
}
