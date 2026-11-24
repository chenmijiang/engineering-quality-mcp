import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createPiBridge } from "./bridge";
import { loadConfig } from "./config";
import { createServer } from "./server";

// stdout belongs exclusively to the MCP transport; route SDK console output to stderr.
console.log = console.info = console.debug = console.error;

const bridge = createPiBridge(loadConfig());
const handle = serveStdio(() => createServer(bridge), {
  onerror: (error) => console.error("MCP:", error.message),
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 2_000).unref();
  try {
    await bridge.shutdown();
    await handle.close();
  } catch (error) {
    console.error("Shutdown:", error instanceof Error ? error.message : String(error));
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.stdin.once("end", () => void shutdown());
