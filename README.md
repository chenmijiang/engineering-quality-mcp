# quality-analysis-mcp

A stdio MCP server that exposes a [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) agent to any MCP client. Agent-to-agent communication uses only MCP tool calls; it does not require sampling, elicitation, or client-specific extensions.

## Requirements

Bun >= 1.4.5 is the only supported runtime. Pi reuses its existing model and auth configuration (`~/.pi/agent` by default).

## Client configuration

```json
{
  "mcpServers": {
    "pi": { "type": "stdio", "command": "bun", "args": ["/absolute/path/src/index.ts"] }
  }
}
```

`bun run build` produces a single-file `dist/index.js` that can replace the source entry.

## Prompts

All model-facing text lives in `src/prompts/*.md`: Pi's system prompt (`pi-system.md`), its `ask_host` tool description, the server's MCP `instructions`, and the MCP tool descriptions. They are loaded as Bun text imports and inlined into the build.

## Protocol

| Tool                                          | Purpose                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| `ask_pi({prompt, session_id?})`               | Start a task, or follow up on a completed session    |
| `reply_pi({session_id, question_id, answer})` | Answer Pi's pending question and resume the same run |
| `cancel_pi({session_id})`                     | Abort or close a session; idempotent                 |

Every result is returned in `structuredContent`, with the same JSON in text content: `status` is `completed`, `needs_input`, `error`, or `closed`. When Pi calls its internal `ask_host` tool, the MCP call returns `needs_input` with `question_id` and `question`; the host answers it with `reply_pi`, which resolves the suspended Pi tool call rather than sending a new prompt. Each `reply_pi` returns the next `needs_input` or `completed`.

Pi has only the read-only `read`, `grep`, `find`, and `ls` tools plus `ask_host`; extensions, skills, prompt templates, and AGENTS files are not loaded. This is not an OS sandbox.

## Environment

| Variable                   | Default                  | Meaning                                               |
| -------------------------- | ------------------------ | ----------------------------------------------------- |
| `PI_PROVIDER` + `PI_MODEL` | Pi default model         | Model override; set both or neither                   |
| `PI_AGENT_DIR`             | Pi SDK default directory | Existing Pi auth, models, and settings directory      |
| `PI_CWD`                   | Process cwd              | Workspace Pi inspects                                 |
| `PI_RUN_TIMEOUT_MS`        | `300000`                 | Whole-turn deadline, including waiting for `reply_pi` |
| `PI_IDLE_TIMEOUT_MS`       | `1800000`                | Retention for completed sessions                      |
| `PI_MAX_SESSIONS`          | `8`                      | Concurrent session limit                              |

## Limits

Sessions and suspended questions live only in the server process: there is no persistence or crash recovery, and no token-level streaming. A run deadline or MCP request cancellation closes the affected session. OAuth refresh may update Pi's `auth.json`; settings are never written.
