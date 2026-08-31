# Hot Handoff

Hot handoff replaces ordinary LLM summarization for opted-in projects.

The independent `@handoff` model reconstructs **semantic hot working state through cursor C**. OMP stores that document as a `CompactionEntry`, keeps **every raw session entry after C**, and injects a fresh deterministic runtime snapshot into the first resumed model call.

The handoff **is** the compaction. There is no separate "compact then handoff" sequence.

Normal successful path:

```text
main keeps working
      │
      │ native speculative lead (~12.5% of threshold, clamped 8k–32k)
      ▼
Snapshot A at C
      │
      ▼
@handoff ─────────────► H(C) armed
      │
main keeps working ───► raw delta after C
      │
      ▼
threshold
      │
      ▼
instant commit: H(C) + ALL raw after C
      │
      ▼
fresh Snapshot B
      │
      ▼
same main model continues
```

Resumed context:

```text
system / project instructions
        +
H(C)
        +
all raw activity after C
        +
fresh LIVE_STATE (Snapshot B)
        +
normal memory facilities
```

Handoff latency is off the main model's critical path when speculation arms before threshold.

## What each layer is for

| Layer | Owner | Lifetime |
| --- | --- | --- |
| H(C) | independent `@handoff` model | persisted semantic working memory through cursor C |
| Raw delta | OMP `firstKeptEntryId` from the speculative preparation | every retained entry created after C |
| Snapshot A | deterministic sensors at C | author input only; allowed to go stale |
| Snapshot B | deterministic sensors at resume | ephemeral on the first provider `context` |
| Memory | Hindsight / configured backend | cold recoverable context |

Do not dump long-term memory into every handoff. The resumed agent uses ordinary `recall` / `reflect` when cold context is needed.

`keepRecentTokens: 12000` is the **preparation target**, not a post-speculation cap. Once H(C) is generated at C, every later entry stays raw even if that temporarily exceeds 12k.

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
  autoContinue: true
  methodOrder:
    - soft
```

`asyncEnabled: true` is required for speculative generation. The particular model selector is an example, not a required dependency. `@handoff` MUST resolve to an authenticated model distinct from the active working model. If it cannot, OMP warns once and uses stock compaction.

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

- lead = 12.5% of threshold, clamped to 8k–32k
- `snapshotLeafId` + `firstKeptEntryId` from the speculative `prepareCompaction()` are the cursor
- an armed result is reused at threshold without another `session.compacting` / author call
- reset/branch/compaction after C invalidates the armed result
- if threshold arrives while the author is still running, native deferral awaits the in-flight run instead of starting a duplicate
- an extension-authored armed result does **not** refresh-on-growth. Recutting would punch a hole between H(C) and the newest 12k.

If speculative generation fails, the armed slot is discarded. The next automatic maintenance pass uses stock compaction rather than blocking the main model on a fresh Hot Handoff call. Manual `/compact` still runs Hot Handoff synchronously.

## Live State Capsule

Deterministic sensors capture:

- timestamp and cwd
- git/jj branch, HEAD, dirty flag, bounded changed paths
- open todos (`pending`, `in_progress`, `blocked`)
- running async jobs
- running/idle non-advisor peers

Every dynamic string is field-capped. The serialized capsule has a hard budget of 10 KiB. Truncation is explicit (`…[truncated]`). Values are JSON-escaped inside `<LIVE_STATE>` and framed as runtime data, not instructions.

Sensor failure is field-local. One broken sensor does not block the handoff.

Snapshot A is captured when the speculative author input is frozen. It is allowed to become stale; later world changes belong to the raw delta and Snapshot B.

Snapshot B is captured on the first provider-bound `context` event after commit, bound to the session that produced the Hot Handoff, and appended as a hidden custom developer message. It is not written to the transcript. Session switch/branch/shutdown clears a pending injection so it cannot leak across sessions.

If Snapshot B conflicts with older handoff prose about volatile state, Snapshot B wins.

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
| Speculative author fails | Armed result discarded; later automatic maintenance stock-compacts |
| Threshold while author is running | Native deferral; no duplicate author |
| User abort | Cancellation propagates; no surprise stock fallback |

See [compaction.md](./compaction.md) for the native cut-point, tail, and persistence pipeline this extension reuses.
