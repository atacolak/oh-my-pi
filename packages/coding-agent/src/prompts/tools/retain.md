Store ≥1 fact in long-term memory for future sessions.

Use: durable, reusable knowledge—user preferences, project decisions, architectural choices; anything improving future responses. No ephemeral task state.

Each item MUST be specific, self-contained: who, what, when, why. Batch related facts per call; deduplicated and consolidated.

Routing: each fact has exactly one visibility project (`project:<repo>` or `project:global`).
- Omit `project` to use the session default: git-root basename when the cwd is inside a repo, otherwise unscoped (no invented folder tag).
- Set `project` to a repo name when this fact belongs to that repo even if the session cwd is elsewhere.
- Set `project` to `global` only for explicit cross-project publication. Do not infer global from content.
- A multi-repo session keeps some facts in repo A and some in repo B by setting `project` per item. One fact cannot be two projects.
