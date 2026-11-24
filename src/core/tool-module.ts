import type { McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Result } from "./contracts";

export const resultSchema = z.object({
  status: z.enum(["needs_input", "completed", "error", "closed"]),
  session_id: z.string().optional(),
  question_id: z.string().optional(),
  question: z.string().optional(),
  text: z.string().optional(),
  error: z.string().optional(),
  model: z.string().optional(),
});

export interface ToolSpec<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: S;
  annotations?: ToolAnnotations;
}

type ToolHandler<This, S extends z.ZodObject> = (
  this: This,
  args: z.output<S>,
  ctx: ServerContext,
) => Result | Promise<Result>;

type ToolEntry = {
  spec: ToolSpec | ((self: ToolModule) => ToolSpec);
  handler: ToolHandler<ToolModule, z.ZodObject>;
};

const entries = new WeakMap<ToolModule, ToolEntry[]>();

/**
 * A group of MCP tools declared with `@tool` methods. Dependencies arrive through the
 * subclass constructor; `register` exposes every decorated method on a server.
 */
export abstract class ToolModule {
  register(server: McpServer): void {
    for (const { spec, handler } of entries.get(this) ?? []) {
      const { name, ...config } = typeof spec === "function" ? spec(this) : spec;
      server.registerTool(
        name,
        { ...config, outputSchema: resultSchema },
        async (args: z.output<z.ZodObject>, ctx: ServerContext) => {
          try {
            return toolResult(await handler.call(this, args, ctx));
          } catch (error) {
            return toolResult({
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
    }
  }
}

function toolResult(result: Result) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    isError: result.status === "error",
  };
}

/**
 * Declares the decorated method as an MCP tool. The method receives parsed input and the
 * request context and returns a `Result`; thrown errors become `error` results.
 * Pass a function to derive the spec from the instance; it is evaluated at `register` time,
 * after construction, so it may read constructor-injected fields.
 */
export function tool<This extends ToolModule, S extends z.ZodObject>(
  spec: ToolSpec<S> | ((self: This) => ToolSpec<S>),
) {
  return (
    handler: ToolHandler<This, S>,
    context: ClassMethodDecoratorContext<This, ToolHandler<This, S>>,
  ): void => {
    context.addInitializer(function () {
      const list = entries.get(this) ?? [];
      list.push({ spec, handler } as unknown as ToolEntry);
      entries.set(this, list);
    });
  };
}
