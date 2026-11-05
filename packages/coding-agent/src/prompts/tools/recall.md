Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`{{toolRefs.recall}}`: specific facts or entries. `{{toolRefs.reflect}}`: synthesized answer across many memories.

Recall gears:
- `budget`: search depth. `low` = quick lookup, `mid` = everyday default, `high` = multi-hop history across linked memories.
- `maxTokens`: size of the return, in tokens of surviving memories, clamped to 512..16384.
- `types`: fact-type filter: `observation`, `world`, or `experience`.

Omitted gears use the session's configured recall controls. Start at `mid`; raise to `high` when the question spans history or several linked decisions; drop to `low` for one narrow lookup.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Before any `{{toolRefs.memory_edit}} update`, MUST fetch full row: `read memory://<id>`.
