# engineering-quality-mcp

A stdio MCP server that exposes a Pi agent to MCP clients. It uses MCP tool calls for agent-to-agent communication and does not require sampling, elicitation, or client-specific extensions.

## Requirements and startup

Bun `>= 1.4.5` is required. Build the server with `bun run build`; this creates `bin/index.js`. Run it with `bun bin/index.js`, or use the package command `eq-mcp` after installing or linking this package.

Configure an MCP client to run the built entry:

```json
{
  "mcpServers": {
    "eq": {
      "type": "stdio",
      "command": "bun",
      "args": ["/absolute/path/to/engineering-quality-mcp/bin/index.js"]
    }
  }
}
```

## Configuration

The server has its own Pi-compatible configuration directory. By default, it reads:

- `~/.eq/agent/settings.json`: global settings.
- `<server-startup-directory>/.eq/settings.json`: project settings, merged over global settings.
- `~/.eq/agent/models.json` and `auth.json`: model definitions and credentials.

Set `EQ_AGENT_DIR` to use another agent directory for the global settings, models and credentials. These files do not fall back to `~/.pi/agent`; project settings do not fall back to `.pi/settings.json`. Pi's provider API-key environment variables can still be used. To use the Pi CLI to configure credentials in the same directory, set its `PI_CODING_AGENT_DIR` to that directory before starting Pi.

The startup directory is the working directory of the MCP server process, as set by the client. Settings are loaded once at startup; restart the server after changes. `EQ_CWD` changes the default working directory for agent sessions, not where project settings are loaded.

Missing settings files are allowed; unreadable or malformed files prevent startup. Settings are read as snapshots without a file lock or a cross-file transaction. Avoid editing them while the server is starting; writers should replace each file atomically rather than modify it in place.

| Environment variable      | Default                   | Purpose                                            |
| ------------------------- | ------------------------- | -------------------------------------------------- |
| `EQ_AGENT_DIR`            | `~/.eq/agent`             | Global settings, models and credentials directory. |
| `EQ_CWD`                  | Server startup directory  | Default agent session working directory.           |
| `EQ_SESSION_DIR`          | `<EQ_AGENT_DIR>/sessions` | Session transcript directory.                      |
| `EQ_PROVIDER`, `EQ_MODEL` | Unset                     | Explicit model; set both or neither.               |
| `EQ_RUN_TIMEOUT_MS`       | `300000`                  | Whole-turn deadline, including reply wait.         |
| `EQ_IDLE_TIMEOUT_MS`      | `1800000`                 | Idle session retention.                            |
| `EQ_MAX_SESSIONS`         | `8`                       | Maximum number of sessions.                        |

## Tools

- `ask_pi({ prompt, session_id? })` starts a task or continues a completed session.
- `reply_pi({ session_id, question_id, answer })` answers a pending question and resumes that run.
- `cancel_pi({ session_id })` cancels or closes a session.
- `review_code({ repo, commit?, from?, to?, paths?, instructions? })` reviews Git changes and starts a session for follow-ups.

Include the task goal, relevant project constraints, acceptance criteria, and file paths in `prompt`. Pi does not inherit the host's instructions or automatically load project guidance such as `AGENTS` files or skills.

Results include a `status` of `completed`, `needs_input`, `error`, or `closed`. If a run asks a question, the response includes a `question_id`; pass it with the `session_id` to `reply_pi`. Results are available in `structuredContent` and as JSON text.

### `review_code`

`repo` is an absolute path inside a Git work tree. The other arguments choose the target:

| Arguments       | Reviews                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| none            | HEAD to the working tree: staged, unstaged, and untracked non-ignored files. Unborn branches use the empty tree. |
| `commit`        | The commit against its first parent; a root commit against the empty tree.                                       |
| `from` (+ `to`) | The merge base of `from` and `to`, up to `to` (default `HEAD`). Working tree changes are not included.           |

`commit` cannot be combined with `from`/`to`, and `to` requires `from`. Refs are pinned to commit SHAs first. Unknown refs, a broken HEAD, unresolved merge conflicts, parents missing from a shallow clone, and unrelated histories are errors. `paths` limits the review to repository-relative files or directories, matched literally. More than 100 reviewable changed files are rejected; narrow the target.

Files under `.git`, `.idea`, `.svn`, `.vscode`, `node_modules`, `target`, or `vendor` directories, binary files, patches over 512 KiB, symlinks, and submodules are listed as not reviewable. With no changes or no reviewable files, the tool returns `completed` without a session. `instructions` can provide additional reviewer guidance.

The diff is captured once per session. Pi reads it with `read_diff` and reads the pinned base and head revisions with `read_file_at`, `grep_at`, and `list_files_at`. In workspace mode the head is the live working tree, which can change during a session. Follow-ups through `ask_pi` keep the original diff; call `review_code` again after changing code.

The report contains a summary, findings with severity, category, location, trigger, impact, evidence, and recommendation, and review limits.

## Runtime boundaries

Live sessions and pending questions exist only in the server process; there is no session resumption after restart, crash recovery, or token-level streaming.

Each session's transcript is written for diagnosis as Pi JSONL at `<EQ_SESSION_DIR>/<timestamp>_<session_id>.jsonl`, once its first message exists. It contains prompts, model responses, tool calls and results (including file contents Pi read and host answers), and, when the session closes, a final `custom` entry with `customType: "eq_close"` and the close reason. Files are never pruned or read back by the server. Pi receives read-only file tools plus `ask_host`, and `review_code` sessions also receive its Git revision tools. Git runs without a shell, with optional locks, index refresh, fsmonitor, external diff, and textconv disabled. Extensions, skills, prompt templates, and `AGENTS` files are not loaded. This tool restriction is not an operating-system sandbox.
