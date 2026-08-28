# Hot Handoff Design

Approved architecture for long-lived OMP sessions.

The handoff is the compaction. OMP `CompactionEntry` is only the storage/context-replacement primitive.

## Goals

After every handoff the main model should have:

- system / project instructions
- semantic hot handoff
- bounded recent raw tail
- fresh live-state capsule
- normal memory facilities

## Invariants

1. Project opt-in via `<cwd>/.omp/HANDOFF.md`.
2. Independent `@handoff` author, distinct from the working model.
3. Native safe compaction pipeline (`session.compacting`, not raw `session_before_compact` replacement).
4. Deterministic Snapshot A for the author; Snapshot B ephemeral on resume.
5. Previous semantic handoff is supplied exactly once via native `previousSummary`.
6. No second semantic summarizer.
7. Core seams stay generic: per-compaction `model` override and sanitized `getAgentSnapshot()`.

## Non-goals

No new session, no `/handoff` rewrite, no reviewer model, no strict schema, no bulk memory injection, no runtime-branch work, no upstream PR.
