# Hot Handoff

Hot handoff replaces ordinary LLM summarization for opted-in projects.

When context pressure reaches the configured compaction threshold, an independent model reconstructs the **current operational working state**. OMP stores that document as a `CompactionEntry`, keeps a bounded recent raw tail, and injects a fresh deterministic runtime snapshot into the first resumed model call.

The handoff **is** the compaction. There is no separate "compact then handoff" sequence.

```text
system / project instructions
        +
semantic HOT HANDOFF
        +
bounded recent raw tail
        +
fresh LIVE STATE capsule
        +
normal memory facilities
```

## What each layer is for

| Layer | Owner | Lifetime |
| --- | --- | --- |
| Handoff | independent `@handoff` model | persisted semantic working memory |
| Live state | deterministic sensors | Snapshot A for the author; Snapshot B ephemeral on resume |
| Tail | OMP `firstKeptEntryId` | recent raw conversational/tool continuity |
| Memory | Hindsight / configured backend | cold recoverable context |

Do not dump long-term memory into every handoff. The resumed agent uses ordinary `recall` / `reflect` when cold context is needed.

## Activation

Hot handoff is project opt-in. The reusable extension may be loaded globally (`-e` or `~/.omp/agent/extensions`), but it stays inert unless the current project contains:

```text
<cwd>/.omp/HANDOFF.md
```

Empty `HANDOFF.md` is treated as disabled.

Example project config:

```yaml
# .omp/config.yml

modelRoles:
  handoff: openai/gpt-5.6

compaction:
  enabled: true
  thresholdPercent: 70
  keepRecentTokens: 12000
  autoContinue: true
  methodOrder:
    - soft
```

The particular model selector is an example, not a required dependency. `@handoff` MUST resolve to an authenticated model distinct from the active working model. If it cannot, OMP warns once and uses stock compaction.

Load the extension:

```bash
omp -e packages/coding-agent/examples/extensions/hot-handoff
```

or copy that directory to `~/.omp/agent/extensions/hot-handoff`.

## Independent author

The main working model MUST NOT write its own hot handoff.

`session.compacting` may return a generic `model` selector for that native compaction request only. The active session model is unchanged before and after the operation.

The author request stays on OMP's native provider-conversion and secret-obfuscation path. Raw transcript serialization to a second provider is not used.

## Live State Capsule

Deterministic sensors capture:

- timestamp and cwd
- git/jj branch, HEAD, dirty flag, bounded changed paths
- open todos (`pending`, `in_progress`, `blocked`)
- running async jobs
- running/idle non-advisor peers

Sensor failure is field-local. One broken sensor does not block the handoff.

Snapshot A is given to the handoff author as additional context and is not persisted in `preserveData`.

Snapshot B is captured on the next provider-bound `context` event after commit and appended as a hidden custom developer message. It is not written to the transcript.

## Manual `/compact`

In an opted-in project, ordinary `/compact` uses the same hot-handoff contract. Stock `/handoff` is unchanged.

## Failure semantics

| Condition | Behavior |
| --- | --- |
| Missing `.omp/HANDOFF.md` | Extension is inert; stock compaction |
| Empty `.omp/HANDOFF.md` | Warn once; stock compaction |
| Missing/unauthenticated `@handoff` | Warn once; stock compaction |
| `@handoff` equals the working model | Warn once; stock compaction |
| Unresolvable compacting `model` override | Compaction fails rather than silently self-authoring |
| User abort | Cancellation propagates; no surprise stock fallback |

See [compaction.md](./compaction.md) for the native cut-point, tail, and persistence pipeline this extension reuses.
