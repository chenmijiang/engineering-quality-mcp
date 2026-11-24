import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { SessionBroker } from "@/core/contracts";
import { tool, ToolModule } from "@/core/tool-module";

import { resolveScope } from "./scope";
import type { Check } from "./types";

export const MAX_CHECK_FILES = 50;

const scopeField = z.array(z.string().min(1)).min(1).max(100).default(["."]);
const checkInputSchema = z.object({
  project_dir: z.string().min(1).describe("Absolute path of the project root"),
  scope: scopeField,
  instructions: z
    .string()
    .max(10_000)
    .optional()
    .describe("Extra reviewer guidance, such as focus areas or report language"),
});
type CheckInput = z.output<typeof checkInputSchema>;

/** Same input for every check; only the scope description names the check's targets. */
function checkInput(targetLabel: string): typeof checkInputSchema {
  return checkInputSchema.extend({
    scope: scopeField.describe(
      `Paths or globs relative to project_dir; directories and globs keep only ${targetLabel}`,
    ),
  });
}

/** `check_<name>`: resolves the scope on the server, then starts an agent review session in it. */
export class CheckTool extends ToolModule {
  constructor(
    private readonly check: Check,
    private readonly sessions: SessionBroker,
  ) {
    super();
  }

  @tool((self: CheckTool) => ({
    name: `check_${self.check.name}`,
    description: self.check.prompts.tool,
    inputSchema: checkInput(self.check.targetLabel),
    annotations: { readOnlyHint: true },
  }))
  async review({ project_dir, scope, instructions }: CheckInput, ctx: ServerContext) {
    const files = await resolveScope(project_dir, scope, {
      isTarget: this.check.isTarget,
      label: this.check.targetLabel,
      maxFiles: MAX_CHECK_FILES,
    });
    const sections = [
      this.check.prompts.task,
      `<rubric>\n${this.check.prompts.rubric}\n</rubric>`,
      `<files>\n${files.join("\n")}\n</files>`,
    ];
    if (instructions) sections.push(`<host-instructions>\n${instructions}\n</host-instructions>`);
    return this.sessions.ask(
      { prompt: sections.join("\n\n"), cwd: project_dir },
      ctx.mcpReq.signal,
    );
  }
}
