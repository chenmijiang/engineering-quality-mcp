import { TestCheck } from "./test/test-check";
import type { Check } from "./types";

export type { Check } from "./types";

/** Checks registered by default, each exposed as `check_<name>`. */
export function builtinChecks(): Check[] {
  return [new TestCheck()];
}
