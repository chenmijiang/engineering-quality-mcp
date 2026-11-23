import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

void serveStdio(() => new McpServer({ name: "quality-analysis-mcp", version: "1.0.0" }));
