import type { Check } from "@/features/checks/types";

import rubric from "./prompts/rubric.md" with { type: "text" };
import task from "./prompts/task.md" with { type: "text" };
import tool from "./prompts/tool.md" with { type: "text" };

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const TEST_NAME = /\.(?:test|spec)\.[^./]+$/;
const TEST_DIRS: Record<string, true> = { __tests__: true, test: true, tests: true };

/** Reviews JS/TS test files against the testing-quality rubric. */
export class TestCheck implements Check {
  readonly name = "test";
  readonly prompts = { tool: tool.trim(), task: task.trim(), rubric: rubric.trim() };
  readonly targetLabel = "test files";

  // A script under a test directory or named `*.test.*` / `*.spec.*`.
  readonly isTarget = (path: string): boolean => {
    if (!SCRIPT_FILE.test(path) || path.endsWith(".d.ts")) return false;
    return (
      TEST_NAME.test(path) ||
      path
        .split("/")
        .slice(0, -1)
        .some((segment) => Object.hasOwn(TEST_DIRS, segment))
    );
  };
}
