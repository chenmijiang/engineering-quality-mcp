/** Prompts of one check, kept in its own `prompts/` directory. */
export interface CheckPrompts {
  /** Host-facing MCP tool description. */
  tool: string;
  /** Agent-facing review procedure, severity scale, and report format. */
  task: string;
  /** Agent-facing quality standard the review applies. */
  rubric: string;
}

/** A quality check over files in a project scope, exposed as the `check_<name>` tool. */
export interface Check {
  name: string;
  prompts: CheckPrompts;
  /** Plural noun for the reviewed files, used in schema text and errors, e.g. "test files". */
  targetLabel: string;
  /** Whether a project-relative POSIX path found through a directory or glob is reviewed. */
  isTarget: (path: string) => boolean;
}
