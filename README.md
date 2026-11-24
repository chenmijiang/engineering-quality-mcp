# quality-analysis-mcp

A stdio MCP server that exposes a Pi agent and quality-check tools to MCP clients. It uses MCP tool calls for agent-to-agent communication and does not require sampling, elicitation, or client-specific extensions.

## Requirements and startup

Bun `>= 1.4.5` is required. Configure an MCP client to run the source entry:

```json
{
  "mcpServers": {
    "pi": {
      "type": "stdio",
      "command": "bun",
      "args": ["/absolute/path/to/quality-analysis-mcp/src/index.ts"]
    }
  }
}
```

`bun run build` creates `dist/index.js`; start the built entry with `bun dist/index.js`. The Pi SDK uses the existing Pi model and auth configuration; see `src/config.ts` for supported environment variables.

## Tools

- `ask_pi({ prompt, session_id? })` starts a task or continues a completed session.
- `reply_pi({ session_id, question_id, answer })` answers a pending question and resumes that run.
- `cancel_pi({ session_id })` cancels or closes a session.
- `check_test({ project_dir, scope?, instructions? })` reviews test files in a project.

Results include a `status` of `completed`, `needs_input`, `error`, or `closed`. If a run asks a question, the response includes a `question_id`; pass it with the `session_id` to `reply_pi`. Results are available in `structuredContent` and as JSON text.

### `check_test`

`project_dir` must be an absolute path. `scope` accepts paths or globs relative to that directory and defaults to the whole project. Directories and globs are filtered to test files; explicitly named files are reviewed as given. Empty/invalid scopes and scopes matching more than 50 files are rejected before the model runs. `instructions` can provide additional reviewer guidance.

The report contains a summary, findings grouped by file with severity and evidence, risk-based gaps, and review limits.

## Runtime boundaries

Sessions and pending questions exist only in the server process; there is no persistence, crash recovery, or token-level streaming. Pi receives read-only file tools plus `ask_host`. Extensions, skills, prompt templates, and `AGENTS` files are not loaded. This tool restriction is not an operating-system sandbox.
