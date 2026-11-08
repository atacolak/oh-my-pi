Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`{{toolRefs.recall}}` returns matching entries; `{{toolRefs.reflect}}` synthesizes an answer across many of them.

recall depth:
- `default`: evaluate up to 1200 available records.
- `deep`: evaluate up to 2400 available records.
- `max`: evaluate the whole named project; bank-wide recall evaluates up to 4800 records.

smaller scopes are evaluated in full. start at `default`; use `deep` or `max` when exhaustive project coverage matters.

{{#if coverage}}
last recall: {{coverage.evaluatedCount}}/{{coverage.total}} ({{coverage.percentage}}) available records in [{{coverage.scope}}], {{coverage.mode}} at gear={{coverage.gear}}, as of {{coverage.evaluatedAt}} utc. this is a timestamped measurement, not a live inventory.
{{else}}
scope coverage is unknown until a recall completes; do not assume exhaustive evaluation.
{{/if}}

`types` narrows by memory shape: `observation` carries distilled living beliefs; reach for `world` or `experience` when the answer needs verbatim detail — an exact SHA, an error string, or a dated event.

stay in the default project scope unless the question explicitly concerns another repository. target that named project with `tags: ["project:<id>"]`, for example `project:exocortex` or `project:oh-my-pi`. this replaces the default project filter and can bring the scope below the sweep ceiling for exhaustive evaluation. `area:<subsystem>` and `memory_shape:<shape>` remain additive filters. the session's hard scope boundary still applies; project tags do not grant personal-memory access.

the coverage header and result details distinguish a whole-scope sweep from a ranked shortlist, show the number actually scored and the available collection total, and identify effective tags and gear. unavailable totals or scores remain unknown. candidate `kept` flags describe relevance filtering before token packing or context deduplication.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Each entry links its bank id as `[memory://<id>]`; `read memory://<id>` returns the full memory with its source memories and consolidation history. Before any `{{toolRefs.memory_edit}} update`, MUST fetch the full row first.
