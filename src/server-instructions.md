Delegate tasks to Pi, a read-only coding agent, over plain MCP tool calls.

1. Call ask_pi({prompt}) for a task, or review_code({repo}) to review Git changes. The result status is completed, needs_input, or error.
2. On needs_input, answer the question yourself or ask your user, then call reply_pi with the exact session_id and question_id. Never call ask_pi on a waiting session.
3. On completed, reuse session_id in ask_pi for a follow-up, or call cancel_pi when finished.

Session IDs live only in this server process. Do not delegate Pi's questions back to Pi.
