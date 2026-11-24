# Native sessions: API cheatsheet

Use this guide when connecting Exocortex, a plugin, or an agent to OMP sessions. These interfaces belong to the native socket capability; a source checkout or a new viewer does not upgrade an already-running owner. Check the loaded owner, not just the version selected for the next launch.

## The model

- **Session UUID:** the durable conversation ID. Keep it across naming, sleep, wake and restart.
- **Native name:** an optional, unique friendly address for that UUID. Names match case-insensitively while preserving their display spelling, including sleeping sessions. A name is not a conversation title, profile, model or permission grant. Rename changes the address, not the conversation.
- **Journal:** the canonical persisted conversation. Do not edit a live journal yourself.
- **Owner:** the single process holding the journal lease and publishing its RPC socket. Multiple views may attach; they do not create another owner.
- **Boot ID:** one owner incarnation. A restart changes this even if the operating-system PID stays the same.
- **Profile and working directories:** saved launch policy and discovery scope. Naming does not change them or move memory into a new silo.

A saved session need not have a live socket. Discovery is read-only. Wake and attach deliberately revive that exact saved conversation, or refuse; they never substitute a new conversation.

## Terminal quick reference

Replace `atlas` with a full UUID, an unambiguous UUID prefix, or a native name.

| Want | Command | Meaning |
|---|---|---|
| Discover | `omp sock list` | All native names plus eight recent unnamed sessions; includes verified attachable socket count. |
| Enumerate everything | `omp sock list --all --json` | Include all saved unnamed sessions. |
| Locate without waking | `omp sock where atlas` | UUID, canonical journal and saved binding. |
| Inspect live availability | `omp sock status atlas` | Unknown/unavailable is not idle. |
| Inspect actual context | `omp sock context atlas --json` | The attached owner's `get_state`: effective system prompt, tool inventory, queues and runtime state. Does not wake sleepers. |
| Name or rename | `omp sock name atlas repository-owner` | Same UUID/history; wakes the saved owner if necessary. `rename` is an equivalent spelling. Conflicts refuse. |
| Wake a saved session | `omp sock wake atlas` | Starts only the saved conversation's owner. |
| Open its terminal | `omp sock attach atlas` | Attach to the existing owner or wake the saved session; Ctrl-C detaches only the viewer. |
| Read history | `omp sock read atlas -n 40` | Read the journal without waking the owner. `--full` includes all display messages. |
| Follow | `omp sock read atlas --follow` | Observe the live conversation; Ctrl-C detaches. |
| Observe native events | `omp sock tap atlas` | JSONL session/core events over the existing native RPC path. |
| Stop the current turn | `omp sock stop atlas` | An alias for `abort`; it does not kill or retire the session. |
| Sleep | `omp sock sleep atlas` | Cooperative idle owner exit. Saved conversation remains discoverable and revivable. |
| Normal restart | `omp sock restart atlas` | Refresh to the selected generation when settled, without asking the model to write a checkpoint. |
| Graceful restart | `omp sock restart atlas --graceful` | Steer a checkpoint request, require model acknowledgment, then wait for all owned work/results. |
| Compact before restarting | `omp sock restart atlas --graceful --compact` | Compaction failure leaves the current owner running. |
| Hard kill | `omp sock kill atlas` | Kill only the broker-verified current owner. Can destroy in-memory work. No checkpoint conversation. |
| Select a published PID | `omp sock status --pid 12345` | PID is a selector, not authority. Kill revalidates session, boot, broker generation and spawned process handle. |
| Inspect a resource path | `omp sock where atlas` | Prefer paths in this result to guessing a profile or journal location. |
| Open a resource | `omp sock open atlas profile` | `profile`, `transcript` or `folder`; uses the configured editor. |

Inside the existing OMP terminal:

| Command | Meaning |
|---|---|
| `/name` | Show the current attach name. |
| `/name repository-owner` | Set or change the attach name, with visible confirmation. |
| `/name clear` | Remove only the name; the same UUID, history, profile and memory access remain. `clear` is a reserved action, not a name argument. |
| `/title Working on the repository` | Change the conversation title, not its attach name. `/rename` remains an equivalent title command. |

Names differing only by case cannot belong to different sessions. Historical case-colliding claims refuse instead of selecting or rewriting either conversation. `/context` opens OMP's context browser, and `/restart` runs the ordinary local restart path. Use the explicit graceful API/CLI for checkpoint-before-restart behavior; `/restart` is not that handshake. Already-running owners need a controlled upgrade before new slash commands are available.

**Starting a genuinely new conversation is different from waking:** launch `omp` normally, optionally with `--agent PROFILE --agent-cwd /definition/root`. The existing CLI/host launch owner creates its UUID. `wake_session` does not create, and RPC `new_session` switches the current owner rather than creating an independent actor. An Exocortex host must use its authoritative session-creation seam; do not spawn a second client or use a Bun subprocess shim from a leaf plugin.

## Exocortex / Node: borrow the existing connection

```ts
import {
  NativeSessionApi,
  type NativeSessionApiTransport,
} from "@oh-my-pi/pi-coding-agent/session/native-session-api";

export function nativeSessionApi(transport: NativeSessionApiTransport) {
  return new NativeSessionApi(transport);
}
```

`transport.request(command)` returns the host's parsed response envelope. `transport.observe(listener)` returns an unsubscribe function. Exocortex supplies these from its existing exact-session OmpBridge attachment (`ctx.ompRpc.nativeSessionTransport(...)` where mounted). OMP narrows responses/events. Do not add another socket, parser, roster, daemon, registry or polling loop. Unsubscribe when the plugin's owning context is disposed; do not close the host's connection.

```ts
const api = nativeSessionApi(transport);
const page = await api.catalog({ query: "repository", limit: 25, offset: 0 });
const saved = await api.resolve("atlas");
if (!saved.sessionFile) throw new Error("No canonical saved journal");
// Wake is an explicit action, not part of rendering a list.
await api.wake({ sessionId: saved.sessionId, sessionFile: saved.sessionFile });
```

Catalog live state belongs to existing host attachments; the metadata-only RPC does not open connections to peers. After wake, the host rebinds its existing session connection to the same selected UUID/journal and verifies the returned identity. Never call a generic create fallback because attach or wake failed.

Operate on the selected session's own borrowed attachment:

```ts
const preflight = await api.preflight();
const owner = preflight.restartReceipt;
if (!owner) throw new Error("Native owner identity unavailable");

await api.setIdentity(owner, { actorHandle: "repository-owner" });
const context = await api.state(); // effective systemPrompt and mounted dumpTools

// Normal restart: no checkpoint steer. Busy owners schedule at idle.
await api.control(owner, "restart");

// Graceful restart: capability comes from this loaded owner.
if (!preflight.refreshModes.graceful) throw new Error("Graceful restart unavailable");
await api.control(owner, "restart", { graceful: true, compactBeforeRestart: true });
```

These restart examples are alternatives, not a sequence: after a restart request, do not issue another using the old receipt. `control` also supports `abort`, `compact` and cooperative `sleep`. Exact refresh does not support force; refusal never falls back to signalling a PID.

**Hard kill is intentionally not a Node facade method yet.** Native CLI and the Bun-side `NativeSessionService.control(selector, "kill")` use the existing broker's stable spawned-process handle. The Node bridge currently has no equivalent authenticated supervisor operation. Exocortex must expose that operation through its existing authoritative host/broker seam before wiring a kill button; do not substitute `process.kill`, shell out to `omp`, or invent a transport. The same distinction applies to creating an independent new owner: use the host's actual creation API, not `wake` or `new_session`.

## Graceful restart is a handshake, not “kill later”

1. Read `get_refresh_preflight`; capture UUID, canonical journal and `restartReceipt.bootId`. Unknown work inventories are not proof of idle.
2. Send `upgrade_runtime` with those three expected owner fields, `refresh: true`, and `graceful: true`. Add `compactBeforeRestart: true` if wanted.
3. The owner steers a native restart notice into this conversation. It explains responsibilities, checkpointing, persistent versus process-local state, and recovery after boot.
4. The model finishes the safe step, saves unfinished responsibilities and results, then calls the mounted `upgrade_runtime` **tool** with the notice's request ID and finishes its turn. The tool acknowledges an existing request; it cannot initiate an arbitrary restart.
5. The owner waits for acknowledgment, turn completion, session-owned tools/subagents/background jobs to settle, and their results to be consumed. Missing or expired-but-unsaved results keep restart blocked. It does not cancel children to make the gate pass.
6. Optional compaction and journal flush complete before teardown. Target, journal lease and boot are checked again. A preparation failure preserves the live owner.
7. The replacement reopens the same journal. Reattach/rebind through the host and require the same UUID/journal with a **new boot ID**. Only this proves restart happened; `{ scheduled: true }` does not.

The RPC `upgrade_runtime` command and the model-facing `upgrade_runtime` acknowledgment tool are different surfaces. Normal restart does not send the checkpoint steer. Hard kill has neither that conversation nor its drain guarantees.

### What persists and what resets

| Persists durably | Recreated / not safe to assume survives |
|---|---|
| UUID, journal/history, durable native name and assignments | In-memory variables, evaluator/tool kernels and process-local handles |
| Saved profile binding, profile-discovery directory and execution directory | Loaded code, settings, extensions, tools and connections are reloaded |
| Saved conversation model selection, subject to explicit policy/overrides | Old boot ID and old send capabilities; obtain fresh receipts |
| Files and checkpoints already saved; journaled mail provenance | Unfinished process-local work: graceful drains it first, normal/kill do not promise that |
| Memory stored by the configured memory service | Any unsaved result, unwritten checkpoint or speculative in-memory state |

Do not replay interrupted side effects or automatically respawn historical child tool calls. A restored transcript is evidence, not proof its old jobs remain alive. Detached external services are outside the graceful owner inventory; preflight reports them as uninspected, not as zero.

## Mail and events

```ts
const sent = await api.sendMail({
  to: "repository-owner", message: "Please inspect the saved patch.", delivery: "queue",
});
const inbox = await api.readMail({ limit: 20 });
const unsubscribe = api.observe(event => {
  if (event.type === "agent_mail") renderMail(event.mail);
});
```

`queue` versus `steer` is explicit, not inferred from intent. Mail wakes the exact saved recipient where supported and records sender, recipient, message, thread and boot provenance. An accepted receipt means input admission, not model inference or a reply. `unknown` means delivery cannot be proved: **do not automatically resend**. Replies carry `threadId` and `replyTo`; render structured data/events, not text markers in a tool body.

`renderMail` is the application's renderer, not an OMP API. Use the host's existing event stream for core tool/message events and the native facade for its owned session events. Unknown event kinds stay unknown; do not forge success or idle.

When building a tool mirror, follow the [native tool lifecycle and replay contract](./rpc.md#tool-lifecycle-declaration-execution-and-replay). Match the final declaration by call ID and tool name; an executor's normalized arguments or a gap in this viewer's stream must not invalidate the conversation.

## Context and the old `actor` CLI

OMP now provides native session context inspection through `omp sock context`, `api.state()` and in-session `/context`, all backed by the session owner. `systemPrompt` is the effective text; `dumpTools` is the owner's mounted inventory. Keep inspection authenticated and session-scoped.

A composition that also provides `get_context` can expose ordered **base-source** layer metadata. Feature-detect it; match session/boot/generation/effective revision before joining it to `get_state`. Base source character counts are not a partition of effective prompt size. Preserve partial/unattributed/unavailable states; do not parse prompt text or sum layer weights into invented token totals.

This is **not yet full parity with Worlds' `actor context`**: its disk-wide capability catalog, boot-versus-current rule/profile drift, knowledge declarations and externally injected block provenance belong to their source owners. Do not import that CLI, run it as a subprocess, or copy its catalogs into a plugin to fake missing native fields.

The native `omp sock` command set replaces the socket-specific discovery/read/attach/control paths. It does not authorize deleting `actor`, `actors.json`, or non-socket project/cockpit/profile operations. Remove the old path only after its callers and saved bindings are migrated with parity proof. UUID-first use and optional on-demand naming do **not** require bulk migration first.

## Failure rules

- Old owners may refuse newer commands. `NativeSessionApiError.code` is preserved when supplied; code-less legacy refusal text remains code-less. Show unsupported/unavailable rather than healthy/idle.
- Name conflicts, ambiguous UUID prefixes, wrong journals, changed boot IDs and held leases refuse. Do not retry under a different name or create a replacement conversation.
- Sleep/restart scheduling is not completion. Verify actual owner exit or a fresh native boot receipt.
- One-hour detached idle sleep is the default (`session.idleSleepSeconds: 3600`); profiles and per-session metadata can override it, and `0` disables it. Pending work and attached viewers prevent idle retirement. Installing new code alone does not change already-running owners.
