# quality-analysis-mcp

A stdio MCP server that exposes a Pi agent and quality-check tools to MCP clients. It uses MCP tool calls for agent-to-agent communication and does not require sampling, elicitation, or client-specific extensions.

## Requirements and startup

Bun `>= 1.4.5` is required. Build the server with `bun run build`; this creates `bin/index.js`. Run it with `bun bin/index.js`, or use the package command `qa-mcp` after installing or linking this package.

Configure an MCP client to run the built entry:

```json
{
  "mcpServers": {
    "pi": {
      "type": "stdio",
      "command": "bun",
      "args": ["/absolute/path/to/quality-analysis-mcp/bin/index.js"]
    }
  }
}
```

## Configuration

The server has its own Pi-compatible configuration directory. By default, it reads:

- `~/.qa/agent/settings.json`: global settings.
- `<server-startup-directory>/.qa/settings.json`: project settings, merged over global settings.
- `~/.qa/agent/models.json` and `auth.json`: model definitions and credentials.

Set `QA_AGENT_DIR` to use another agent directory for the global settings, models and credentials. These files do not fall back to `~/.pi/agent`; project settings do not fall back to `.pi/settings.json`. Pi's provider API-key environment variables can still be used. To use the Pi CLI to configure credentials in the same directory, set its `PI_CODING_AGENT_DIR` to that directory before starting Pi.

The startup directory is the working directory of the MCP server process, as set by the client. Settings are loaded once at startup; restart the server after changes. `QA_CWD` changes the default working directory for agent sessions, not where project settings are loaded. Likewise, `check_test.project_dir` does not change the settings source.

Missing settings files are allowed; unreadable or malformed files prevent startup. Settings are read as snapshots without a file lock or a cross-file transaction. Avoid editing them while the server is starting; writers should replace each file atomically rather than modify it in place.

| Environment variable      | Default                   | Purpose                                            |
| ------------------------- | ------------------------- | -------------------------------------------------- |
| `QA_AGENT_DIR`            | `~/.qa/agent`             | Global settings, models and credentials directory. |
| `QA_CWD`                  | Server startup directory  | Default agent session working directory.           |
| `QA_SESSION_DIR`          | `<QA_AGENT_DIR>/sessions` | Session transcript directory.                      |
| `QA_PROVIDER`, `QA_MODEL` | Unset                     | Explicit model; set both or neither.               |
| `QA_RUN_TIMEOUT_MS`       | `300000`                  | Whole-turn deadline, including reply wait.         |
| `QA_IDLE_TIMEOUT_MS`      | `1800000`                 | Idle session retention.                            |
| `QA_MAX_SESSIONS`         | `8`                       | Maximum number of sessions.                        |

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

Live sessions and pending questions exist only in the server process; there is no session resumption after restart, crash recovery, or token-level streaming.

Each session's transcript is written for diagnosis as Pi JSONL at `<QA_SESSION_DIR>/<timestamp>_<session_id>.jsonl`, once its first message exists. It contains prompts, model responses, tool calls and results (including file contents Pi read and host answers), and, when the session closes, a final `custom` entry with `customType: "qa_close"` and the close reason. Files are never pruned or read back by the server. Pi receives read-only file tools plus `ask_host`. Extensions, skills, prompt templates, and `AGENTS` files are not loaded. This tool restriction is not an operating-system sandbox.
