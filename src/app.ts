import { McpServer } from "@modelcontextprotocol/server";

import type { AgentRuntime, SessionBroker } from "@/core/contracts";
import { InMemorySessionBroker } from "@/core/session-broker";
import type { ToolModule } from "@/core/tool-module";
import { SessionTools } from "@/features/session-tools";
import { PiRuntime } from "@/runtimes/pi/pi-runtime";

import type { Config } from "./config";
import serverInstructions from "./server-instructions.md" with { type: "text" };

export interface AppOverrides {
  /** Agent backend; defaults to the Pi SDK runtime built from `config`. */
  runtime?: AgentRuntime;
}

/** Composition root: the only place that chooses concrete implementations. */
export class App {
  readonly #runtime: AgentRuntime;
  readonly #sessions: SessionBroker;
  readonly #tools: ToolModule[];

  constructor(config: Config, overrides: AppOverrides = {}) {
    this.#runtime = overrides.runtime ?? new PiRuntime(config);
    this.#sessions = new InMemorySessionBroker(this.#runtime, config);
    this.#tools = [new SessionTools(this.#sessions)];
  }

  /** Creates the MCP server for one connection; all connections share the app's sessions. */
  createServer(): McpServer {
    const server = new McpServer(
      { name: "engineering-quality-mcp", version: "1.0.0" },
      { instructions: serverInstructions.trim() },
    );
    for (const tool of this.#tools) tool.register(server);
    return server;
  }

  async shutdown() {
    await this.#sessions.shutdown();
    await this.#runtime.shutdown();
  }
}
