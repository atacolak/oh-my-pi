# Hot Handoff

Hot handoff replaces ordinary LLM summarization for opted-in projects.

The independent `@handoff` model reconstructs **semantic hot working state through the Speculation Checkpoint**. OMP stores that document as a `CompactionEntry`, keeps **every raw session entry after that checkpoint**, and injects a fresh deterministic runtime snapshot into the first resumed model call.

The handoff **is** the compaction. There is no separate "compact then handoff" sequence.

Normal successful path:

```text
main keeps working
      │
      │ native speculative lead (12.5% of threshold, clamped 8k–32k;
      │ optional speculationMinLeadTokens raises that floor)
      ▼
Author State at Speculation Checkpoint
      │
      ▼
@handoff ─────────────► Handoff Document armed
      │
main keeps working ───► Raw Continuation
      │
      ▼
Commit Threshold
      │
      ▼
instant commit: Handoff Document + ALL Raw Continuation
      │
      ▼
fresh Resume State
      │
      ▼
same main model continues
```

Resumed context:

```text
system / project instructions
        +
Handoff Document
        +
all Raw Continuation after the Speculation Checkpoint
        +
fresh LIVE_STATE (Resume State)
        +
normal memory facilities
```

Handoff latency is off the main model's critical path when speculation arms before the Commit Threshold.

## What each layer is for

| Layer | Owner | Lifetime |
| --- | --- | --- |
| Handoff Document | independent `@handoff` model | persisted semantic working memory through the Speculation Checkpoint |
| Raw Continuation | OMP `firstKeptEntryId` derived after `snapshotLeafId` | every retained entry created after the checkpoint |
| Author State | deterministic sensors at the checkpoint | author input only; allowed to go stale |
| Resume State | deterministic sensors at resume | ephemeral on the first provider `context` |
| Memory | Hindsight / configured backend | cold recoverable context |

Do not dump long-term memory into every handoff. The resumed agent uses ordinary `recall` / `reflect` when cold context is needed.

`keepRecentTokens` remains the **stock compaction** preparation target. Successful Hot Handoff speculation does not use it as the semantic/raw boundary. Once a Handoff Document is generated at the Speculation Checkpoint, every later entry stays raw even if that temporarily exceeds 12k.

## Activation

Hot handoff is project opt-in. The reusable extension may be loaded globally (`-e` or `~/.omp/agent/extensions`), but it stays inert unless the current project contains:

```text
<cwd>/.omp/HANDOFF.md
```

Empty `HANDOFF.md` is treated as disabled. Lookup is exact cwd; no ancestor walk.

Example project config:

```yaml
# .omp/config.yml

modelRoles:
  handoff: openai/gpt-5.6

compaction:
  enabled: true
  asyncEnabled: true
  thresholdPercent: 70
  keepRecentTokens: 12000
  speculationMinLeadTokens: 18000
  autoContinue: true
  methodOrder:
    - soft
```

`asyncEnabled: true` is required for speculative generation. `speculationMinLeadTokens` is optional; unset keeps the native 12.5%/8k–32k lead. The particular model selector is an example, not a required dependency. `@handoff` MUST resolve to an authenticated model distinct from the active working model. If it cannot, OMP warns once and uses stock compaction.

Load the extension:

```bash
omp -e packages/coding-agent/examples/extensions/hot-handoff
```

or copy that directory to `~/.omp/agent/extensions/hot-handoff`.

## Independent author

The main working model MUST NOT write its own hot handoff.

`session.compacting` may return a generic `model` selector for that native compaction request only. The active session model is unchanged before and after the operation.

The author request stays on OMP's native provider-conversion and secret-obfuscation path. Raw transcript serialization to a second provider is not used.

Hot Handoff stays on OMP's `soft` LLM transport. It does not switch to the built-in `handoff` method.

## Speculation

OMP owns scheduling, cursor, invalidation, and commit:

- native lead = 12.5% of threshold, clamped to 8k–32k
- optional `compaction.speculationMinLeadTokens` raises that floor
- `snapshotLeafId` is the Speculation Checkpoint
- semantic generation covers active history through that checkpoint, including what stock `prepareCompaction()` would have called `recentMessages`
- at commit, checkpoint-bound `firstKeptEntryId` uses the stock keepRecentTokens cut so the raw window is recent exact context, overlapping the Handoff Document. If that native cut would skip post-snapshot entries the semantic author never saw, fall back to the first entry after the checkpoint
- an armed result is reused at the Commit Threshold without another `session.compacting` / author call
- reset/branch/compaction after the checkpoint invalidates the armed result
- if the Commit Threshold arrives while the author is still running, the real pass waits leftover generation time instead of aborting
- a checkpoint-bound armed result does **not** refresh-on-growth during the band; at commit, a post-checkpoint tail larger than `keepRecentTokens` is recut once through the current leaf. The recut author may see the region later kept raw. Recut failure keeps the original armed result and does not emit the yellow fallback
- after commit, the next author does **not** start until residual context grows by the speculation lead from that compact's `tokensAfter`; a checkpoint-bound residual is treated as headroom so stock shake/prune does not eat the raw continuation. The same hold applies while a checkpoint-bound author is in flight or armed. An unresolved `session.compacting` hook is held conservatively; once it resolves without a Hot Handoff model, stock prune/shake resume

If speculative generation fails, the armed slot is discarded and OMP emits the extension's `failureNotice` once (warning). The next automatic maintenance pass uses stock compaction rather than blocking the main model on a fresh Hot Handoff call. Manual `/compact` still runs Hot Handoff synchronously.

## Live State Capsule

Deterministic sensors capture:

- timestamp and cwd
- git/jj branch, HEAD, dirty flag, bounded changed paths
- open todos (`pending`, `in_progress`, `blocked`)
- running async jobs
- running/idle non-advisor peers

Every dynamic string is field-capped. The serialized capsule has a hard budget of 10 KiB. Truncation is explicit (`…[truncated]`). Values are JSON-escaped inside `<LIVE_STATE>` and framed as runtime data, not instructions.

Sensor failure is field-local. One broken sensor does not block the handoff.

Author State is captured when the speculative author input is frozen. It is allowed to become stale; later world changes belong to the Raw Continuation and Resume State.

Resume State is captured on the first provider-bound `context` event after commit, bound to the session that produced the Hot Handoff, and appended as a hidden custom developer message. It is not written to the transcript. Session switch/branch/shutdown clears a pending injection so it cannot leak across sessions.

If Resume State conflicts with older handoff prose about volatile state, Resume State wins.

## Manual `/compact`

In an opted-in project, ordinary `/compact` uses the same hot-handoff contract and waits for the author. Stock `/handoff` is unchanged.

## Failure semantics

| Condition | Behavior |
| --- | --- |
| Missing `.omp/HANDOFF.md` | Extension is inert; stock compaction |
| Empty `.omp/HANDOFF.md` | Warn once; stock compaction |
| Missing/unauthenticated `@handoff` | Warn once; stock compaction |
| `@handoff` equals the working model | Warn once; stock compaction |
| Unresolvable compacting `model` override | Compaction fails rather than silently self-authoring |
| Speculative author fails | Warning once via `failureNotice`; armed result discarded; later automatic maintenance stock-compacts |
| Commit Threshold while author is running | Native deferral; no duplicate author |
| User abort | Cancellation propagates; no surprise stock fallback |

See [compaction.md](./compaction.md) for the native cut-point, tail, and persistence pipeline this extension reuses.
