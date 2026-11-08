Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`{{toolRefs.recall}}` returns matching entries; `{{toolRefs.reflect}}` synthesizes an answer across many of them.

Recall depth follows how much of your own past experience the question needs in view:
- `low`: one specific fact or name you know exists.
- `mid`: everyday context around the current work.
- `high`: connected history across sessions and decisions.
- `xhigh`: a broad deep sweep when phrasing may have shifted.
- `max`: the largest bounded sweep; scopes above its 4800-candidate ceiling use a ranked shortlist.

Start at `mid`; go wider when the answer spans history or several linked decisions, narrower for one lookup.

`types` narrows by memory shape: `observation` carries distilled living beliefs; reach for `world` or `experience` when the answer needs verbatim detail — an exact SHA, an error string, or a dated event.

target a project directly with `tags: ["project:<id>"]`, such as `project:exocortex`, `project:oh-my-pi`, `project:vms-lab`, `project:browser-ops`, `project:hcom`, `project:herdr`, or `project:memory`. this replaces the default project filter and can bring the scope below the sweep ceiling for exhaustive evaluation. `tags: ["project:*"]` widens project-bound coding recall across coding projects. `area:<subsystem>` and `memory_shape:<shape>` remain additive filters. the session's hard scope boundary still applies; project tags do not grant personal-memory access.

the coverage header and result details distinguish a whole-scope sweep from a ranked shortlist, show the number actually scored and the available collection total, and identify effective tags and gear. unavailable totals or scores remain unknown. candidate `kept` flags describe relevance filtering before token packing or context deduplication.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Each entry links its bank id as `[memory://<id>]`; `read memory://<id>` returns the full memory with its source memories and consolidation history. Before any `{{toolRefs.memory_edit}} update`, MUST fetch the full row first.
