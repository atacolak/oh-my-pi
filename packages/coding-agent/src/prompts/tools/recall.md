Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`{{toolRefs.recall}}` returns matching entries; `{{toolRefs.reflect}}` synthesizes an answer across many of them.

Recall depth follows how much of your own past experience the question needs in view:
- `low`: one specific fact or name you know exists.
- `mid`: everyday context around the current work.
- `high`: connected history across sessions and decisions.
- `xhigh`: a broad deep sweep when phrasing may have shifted.
- `max`: every consolidated belief and unmerged fact in scope, so nothing hides.

Start at `mid`; go wider when the answer spans history or several linked decisions, narrower for one lookup.

`types` narrows by memory shape: `observation` carries distilled living beliefs; reach for `world` or `experience` when the answer needs verbatim detail — an exact SHA, an error string, or a dated event.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Each entry links its bank id as `[memory://<id>]`; `read memory://<id>` returns the full memory with its source memories and consolidation history. Before any `{{toolRefs.memory_edit}} update`, MUST fetch the full row first.
