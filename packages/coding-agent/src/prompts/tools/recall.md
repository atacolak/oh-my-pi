Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`{{toolRefs.recall}}`: specific facts or entries. `{{toolRefs.reflect}}`: synthesized answer across many memories.

Recall gears:
- `budget`: search depth. `low` = quick lookup (server recall ~4s), `mid` = everyday default (~6s), `high` = multi-hop history across linked memories (~11s).
- `xhigh`: one `high` recall plus client-side scoring of the top 2400 trace candidates (measured ~32s at 2400; scales with scope). Buys precision when one server ranking is not enough.
- `max`: no recall at all; scores every consolidated observation plus any pending or failed raw facts in the tag-scoped bank. Raw `world`/`experience` rows that observations already represent are not re-scored (measured ~14s at 2k memories; critical use only, scales with scope). Reports truncation (`Deep recall truncated: …`) only when memories remain unread at the sweep ceiling.
- `maxTokens`: size of the return, in tokens of surviving memories, clamped to 512..16384.
- `types`: fact-type filter: `observation`, `world`, or `experience`.

Omitted gears use the session's configured recall controls. Start at `mid`; raise to `high` when the question spans history or several linked decisions; drop to `low` for one narrow lookup. Spend `xhigh`/`max` only on hard or high-stakes questions that justify the seconds.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Before any `{{toolRefs.memory_edit}} update`, MUST fetch full row: `read memory://<id>`.
