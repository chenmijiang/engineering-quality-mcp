import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** Load application settings once, leaving parsing, migration and scope merging to Pi. */
export function createReadOnlySettings(projectCwd: string, agentDir: string): SettingsManager {
  const paths = {
    global: join(agentDir, "settings.json"),
    project: join(projectCwd, ".eq", "settings.json"),
  };
  // These synchronous, read-only snapshots require no writer lock and never create lock files.
  // Each scope is read once; there is no cross-file transaction. Writers should replace files
  // atomically (rename), not mutate them in place, to avoid exposing a partially written file.
  const snapshots = new Map<string, string | undefined>();
  const manager = SettingsManager.fromStorage({
    withLock(scope, callback) {
      if (!snapshots.has(scope)) {
        try {
          snapshots.set(scope, readFileSync(paths[scope], "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          snapshots.set(scope, undefined);
        }
      }
      if (callback(snapshots.get(scope)) !== undefined) {
        throw new Error(`Cannot write read-only ${scope} settings: ${paths[scope]}`);
      }
    },
  });
  const errors = manager.drainErrors().map(
    ({ scope, error }) =>
      new Error(`Cannot load ${scope} settings at ${paths[scope]}: ${error.message}`, {
        cause: error,
      }),
  );
  if (errors.length) {
    throw new AggregateError(errors, errors.map((error) => error.message).join("\n"));
  }
  return manager;
}
