# Todo Attention Projection Contract

## Boundary
Raw Beads is durable work storage. Todo is an actor's current attention projection, not a second work database. OMP core exposes only generic continuing/passive phases and the `getTodoPhases` / `setTodoPhases` (RPC: `get_state` / `set_todos`) read-modify-write seam. The repository contains no Beads runtime; an external producer owns Beads queries and preserves phases it does not own.

## Scope
Only descendants of the actor's current sprint epic project into current attention. Provenance links are metadata, not work, and never create attention items.

## Project-lead projection
- `SPRINT`: current owned epic; passive.
- `NOW`: ready/working descendants plus live workers/verifiers; continuing.
- `WAITING`: non-executable current-sprint descendants with a real dependency or wait; passive.
- `FOR USER`: model-authored human `REPORT`/`DECISION` items; passive and preserved by projection refresh.

These names are a project-lead convention only. Core does not recognize them.

## Graph and lifecycle vocabulary
Derived states are `READY`, `WORKING`, `WAITING`, `DEFERRED`, `AWAITING_REVIEW`, `DONE`. `DEFERRED` maps to Beads `deferred`; `DONE` maps to `closed`; `READY` is open/unblocked/not-deferred; `WORKING` is `in_progress` plus a live assigned worker; `WAITING` and `AWAITING_REVIEW` are graph/runtime-derived. Graph unfolding promotes newly ready current-sprint descendants into `NOW` on refresh.

## Types and link semantics
Agents may mint only `epic`, `feature`, `bug`, `task`, and `docs`. `parent-child` is hierarchy. `blocks` and `conditional-blocks` are ordering. `waits-for` is an external wait. `discovered-from` is provenance and does not project as work.

## Refresh seam
1. Read the current Todo phases.
2. Query the current owned sprint epic and its descendant graph outside coding-agent.
3. Recompute only projection-owned phases, preserve model-owned phases, and write the merged list atomically through the existing whole-list setter.
4. Do not poll in core; refresh cadence belongs to the external producer.

A producer must therefore emit only the two known literals. The Python RPC read path (`parse_todo_phase` in `python/omp-rpc/src/omp_rpc/protocol.py`) raises `ValueError` for any other `kind` value when it parses `get_state`, while the TypeScript session deliberately keeps running with an unrecognized persisted kind degraded to continuing — so a novel kind fails the RPC client, not core.

## Live contract audit (2026-09-16)
Read-only observations of the live village and agent config. Nothing in this section was applied outside this repository.

- `/home/sf/worlds/base/agents/project-lead.md:67` queries `br ready --unassigned` plus orphaned `in_progress`, but no deferred sweep. Because `br ready` excludes deferred, it cannot enforce its own line 70 museum check.
- `/home/sf/.omp/agent/skills/beads-ready-front/SKILL.md:108` already defines lined-up as `open ready or deferred`; lines 123–125 say live worker iff `in_progress`, campaign epics close only after Ata accepts, non-front/superseded work closes rather than defers, defer is only for dated real work, and empty ready plus deferred P0s is a museum.
- Recommended live-file text (do **not** apply in this repo): project-lead wake step 4 should query `br ready --unassigned` **plus** `br list --status deferred --json` for the same prefix, plus owned `in_progress` with no living worker.
- Neither live file documents `conditional-blocks`, `waits-for`, `discovered-from`, or provenance. Recommend copying the Types and link semantics paragraph into the owning live source in a separately authorized change.

## Producer questions reserved for operator decision
1. **`AWAITING_REVIEW` with no live verifier.** The Brief puts "ready/working descendants + live workers/verifiers" in `NOW`. A descendant awaiting review with *no* verifier in flight is neither ready nor working, and has no dependency or wait — so the Brief's predicates place it in no section at all. Should it surface in `NOW` as actionable ("go verify it"), or fall out of current attention?
2. **`DEFERRED` descendants.** The Brief's `WAITING` predicate requires "a real dep/wait", which a deferred-by-choice bead lacks — so deferred descendants project nowhere. That is consistent with the museum guidance (`SKILL.md:125`), but it also removes from view exactly the set the operator's *stale lined-up = open-ready-or-deferred* rule says must stay visible. Do deferred descendants project into `WAITING` as passive items, or out of attention entirely?
3. **`DONE` descendants.** `DONE` is in the derived vocabulary but has no section in the four-section mapping. Does recently-closed work surface in the current-sprint projection — and if so, with what retention — or never?
4. **Refresh that drops in-flight state.** When a refresh removes a `NOW` task the model had marked `in_progress` (its bead left the ready front), is that a silent replacement, or must it surface to the operator? This is the reconciliation behavior that the move from model convention to deterministic projection makes newly observable.

These questions concern a future Beads projection producer only. They do not change the generic passive-phase capability, the state model, or the read-modify-write seam described above.
