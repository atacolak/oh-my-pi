# Native sessions: consumer card and API guide

Canonical location: repo `docs/native-session-api.md`; read it as `omp://native-session-api.md`. The RPC protocol reference (`docs/rpc.md`, `omp://rpc.md`) owns wire framing, negotiation and event payloads; this page owns session discovery, identity, naming, attachment, control and their consumer contract. When the two disagree, the loaded owner and the generated wire schema win.

## Consumer card

| Field | Contract |
|---|---|
| **Owner** | One OMP process holds the lease on each live session's journal and serves its commands. Name changes across a sessions root use the same catalog lock. The host owns its connection; plugins borrow it. Installing a new generation does not upgrade an already-running owner. |
| **Provides** | `NativeSessionApi` (Node/Bun facade), the `omp sock` CLI, the native RPC command family, the generated wire schema plus TypeScript/Python/Rust/Go clients, and name-conflict diagnostics. |
| **Consumes** | `NativeSessionApi` takes a transport with `request` and `observe`. Exocortex supplies it from its existing attachment; the facade does not open sockets or keep a roster. |
| **Entry** | `@oh-my-pi/pi-coding-agent/session/native-session-api` for the facade, `omp sock` for the CLI, and the [wire schema](../packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json) for independent clients. |
| **Authorization** | The caller's existing authenticated host session scope. Borrowing a transport grants nothing new, and the catalog is metadata read-only. Do not add a second authorization or identity store beside it. |
| **Freshness** | The catalog is metadata-only: the RPC `list_sessions` handler passes `probe: false`, so it never opens peer connections or refreshes live state. Live state comes from **your** existing attachment (`get_state`, events) or an explicit `omp sock status`/`context` inspect. No wrapping poll loop. |
| **Errors** | Typed codes on the response (`session_identity_conflict`, `ambiguous_session_reference`, `session_not_found`, plus bounded request codes). Code-less legacy refusal text stays code-less. `unknown` is never idle, and an accepted mail/control receipt is admission, not completion. |
| **Version** | Three separate versions: the generation you installed, the loaded owner's capabilities (probe with `get_refresh_preflight`), and the wire protocol (`protocolVersion` + `negotiate_protocol`). New wire fields are additive and optional, so a peer that does not know `conflicts` still parses the list. Older owners may refuse newer commands; show unsupported, do not simulate it. |

Hard rules for consumers: do not add another socket, parser, roster, daemon, registry, HTTP surface or polling loop. Do not spawn `omp` as a subprocess to fake a missing native operation. Do not edit journals. Do not delete or auto-repair sessions or names.

## The model

- **Session UUID:** the durable conversation ID. Keep it across naming, sleep, wake and restart.
- **Native name:** an optional, unique friendly address for that UUID, matched case-insensitively while preserving display spelling, including for sleeping sessions. A name is **not** a conversation title, profile, model or permission grant. `/rename` and `set_session_name` change the title; they never change the address. Names are unique **within one OMP sessions root** (the catalog root that owner scans), not across unrelated roots, and a name is not an authorization token.
- **Copied history:** a fork or automatic continuation with a new UUID starts unnamed. Its parent keeps its name. History links do not transfer name ownership.
- **Journal:** the canonical persisted conversation at `sessionFile`. Do not edit a live journal yourself.
- **Owner:** the single process holding the journal lease and publishing its RPC socket. Multiple views may attach; they do not create another owner. A saved session need not have a live socket.
- **Boot ID:** one owner incarnation. A restart changes this even if the operating-system PID stays the same.
- **Profile, generation and working directories:** saved launch policy and discovery scope. Naming does not change them or move memory into a new silo.

Discovery is read-only. Wake and attach deliberately revive that exact saved conversation, or refuse; they never substitute a new conversation.

## Name conflicts are data, never a winner

Two journals in one catalog root may already claim the same name (any case). That is a historical fact, not a request to pick an owner:

```json
{
  "sessions": [],
  "total": 0,
  "truncated": false,
  "conflicts": [
    { "code": "duplicate_handle", "handle": "repository-owner", "sessionIds": ["<uuid-a>", "<uuid-b>"] }
  ]
}
```

- `conflicts` is optional and **omitted when empty**. Present, it is `{ code: "duplicate_handle", handle, sessionIds }` where `handle` is lowercased and `sessionIds` is the stable sorted claimant list.
- It is computed over the whole catalog **before** `query`, `limit` and `offset`, so a filtered or paged view still reports every historical collision. `total`, `truncated` and `nextOffset` describe sessions only. Older clients that predate the field simply parse without it, so a consumer that needs the diagnostics must use a client generated from a schema that includes `conflicts`.
- It does not fail the list, does not hide the raw claims, and does not authorize selecting a winner. A collided name cannot select a session: resolve or naming with it refuses `session_identity_conflict`.
- Resolution compares the reference case-insensitively as a name **and** as a session-ID prefix. One match resolves; a duplicated name is `session_identity_conflict`; any other multiple match is `ambiguous_session_reference`; no match is `session_not_found`. There is no precedence: a full UUID that also equals another session's literal name stays ambiguous rather than silently winning.

Resolution is a human/host decision, expressed by UUID:

```bash
# Rename only the intended conversation, by full UUID, to an unused name.
omp sock name <uuid-a> repository-owner-main

# Clear only that conversation's claim: in-session /name clear, or an exact identity
# patch from an attached client — the same UUID, journal, profile and memory access remain.
# {"type":"set_session_identity","expectedSessionId":"<uuid-a>","expectedSessionFile":"<abs journal path>","patch":{"actorHandle":null}}
```

The rename is scoped by UUID **and** canonical journal. Only the chosen session records the change; the other journals stay untouched. This is not a boot fence: fetch a new owner receipt after a restart. Another session's existing name is unavailable even while that session sleeps.

Malformed journals and the same UUID claimed by two journals remain fail-closed: the catalog refuses instead of guessing which file is real. Fix such a collision at its source owner before relying on the catalog.

## Native RPC, SDK and CLI

Three layers over one wire contract:

| Layer | What it is | Reach for it when |
|---|---|---|
| Raw RPC | JSONL frames (`{id, type, ...}` → `{type:"response", command, success, data\|error, code?}`) on stdio or the session socket. | You are debugging, or already hold a framed connection. |
| SDK | `NativeSessionApi` narrows the same frames into typed methods; `NativeSessionApiError` carries `code`. | You are a Node/Bun host (Exocortex, plugin) with a borrowed transport. |
| CLI | `omp sock` is the terminal interface. `list --json` prints the inventory; `raw` prints the complete RPC response envelope. | An operator or script inspects or controls a session. |

`omp sock raw <selector> '<json command>'` is the escape hatch that sends one raw command over the native path. Cross-session scanning still belongs to `list`/`where`, never to guessed paths.

### Native commands and exact request shapes

| Command | Request fields | Response data |
|---|---|---|
| `list_sessions` | `query?`, `limit?` (default 25, 1–1000), `offset?` | `NativeSessionList` with optional `conflicts` |
| `resolve_session` | `reference` (≤256 chars) | `NativeSessionInfo` |
| `wake_session` | `expectedSessionId`, `expectedSessionFile` | `NativeSessionInfo & { revived }` |
| `set_session_identity` | `expectedSessionId`, `expectedSessionFile`, `patch` (`actorHandle`, `assignments`, `generation`, `idleSleepSeconds`) | `SessionIdentityRecord` |
| `get_state` | — | attached owner's prompt, tools, queues, runtime state |
| `get_refresh_preflight` | — | owner receipt (`sessionId`, `sessionFile`, `bootId`) and refresh capabilities |
| `agent_mail_post_consented` / `agent_mail_list` | recipient and message / bounded inbox options | stored receipt / peer messages; neither starts a recipient turn |
| `agent_mail_restrict` | peer UUID, `block` or `reset` | restrict or revoke recipient-side consent; never grants it |

Invalid input is refused with a bounded code: `invalid_catalog_query`, `invalid_session_reference`, `invalid_wake_target`, `session_target_mismatch`. Both the socket and stdio dispatchers also map the typed identity failures to `session_identity_conflict`, `ambiguous_session_reference` and `session_not_found` instead of prose only.

```json
{"id":"c1","type":"list_sessions","query":"repository","limit":50}
{"id":"c2","type":"resolve_session","reference":"<full-uuid>"}
{"id":"c3","type":"set_session_identity","expectedSessionId":"<uuid>","expectedSessionFile":"/abs/path/<uuid>.jsonl","patch":{"actorHandle":"repository-owner"}}
```

```json
{"id":"c2","type":"response","command":"resolve_session","success":false,"error":"Session reference \"…\" matches more than one session…","code":"ambiguous_session_reference"}
```

`wake_session` never creates: it re-resolves the expected UUID, refuses `session_target_mismatch` if the saved journal moved, and starts only that saved conversation's owner. Whatever you render after it must come from the returned identity, not from the name you asked for.

## Terminal quick reference

Replace `<selector>` with a full UUID (preferred when a name collides), an unambiguous UUID prefix, or a non-colliding native name.

| Want | Command | Meaning |
|---|---|---|
| Discover | `omp sock list` | Native names plus eight recent unnamed sessions, attachable socket count, and any name-conflict lines. |
| Enumerate everything | `omp sock list --all --json` | Include all saved unnamed sessions; JSON keeps `conflicts`. |
| Filter | `omp sock list --query <text> [--live]` | `--live` keeps only owners that prove their identity. Conflicts remain catalog-wide. |
| Locate without waking | `omp sock where <selector>` | UUID, canonical journal and saved binding. |
| Inspect live availability | `omp sock status <selector>` | Unknown/unavailable is not idle. |
| Inspect actual context | `omp sock context <selector> --json` | The attached owner's `get_state`; does not wake sleepers. |
| Name or rename | `omp sock name <selector> <new-name>` | Same UUID/history; wakes the saved owner if necessary. `rename` is an equivalent spelling. Conflicts refuse. |
| Wake a saved session | `omp sock wake <selector>` | Starts only the saved conversation's owner. |
| Open its terminal | `omp sock attach <selector>` | Attach to the existing owner or wake the saved session; Ctrl-C detaches only the viewer. |
| Read history | `omp sock read <selector> -n 40` | Read the journal from disk without waking the owner. `--full` includes all display messages. |
| Follow | `omp sock read <selector> --follow` | Observe a live owner's conversation; Ctrl-C detaches. Does not wake. |
| Observe native events | `omp sock tap <selector>` | JSONL session/core events from the live owner over the existing native RPC path. Does not wake. |
| Send one raw command | `omp sock raw <selector> '<json>'` | Escape hatch to the live owner; exit code 1 on a failed response. Does not wake. |
| Stop the current turn | `omp sock stop <selector>` | Alias for `abort`; it does not kill or retire the session. |
| Sleep | `omp sock sleep <selector>` | Cooperative idle owner exit. Saved conversation remains discoverable and revivable. |
| Normal restart | `omp sock restart <selector>` | Refresh to the selected generation when settled, without asking the model to write a checkpoint. |
| Graceful restart | `omp sock restart <selector> --graceful` | Steer a checkpoint request, require model acknowledgment, then wait for all owned work/results. |
| Compact before restarting | `omp sock restart <selector> --graceful --compact` | Compaction failure leaves the current owner running. |
| Hard kill | `omp sock kill <selector>` | Kill only the broker-verified current owner. Can destroy in-memory work. No checkpoint conversation. |
| Select a published PID | `omp sock status --pid 12345` | PID is a selector, not authority. Kill revalidates session, boot, broker generation and spawned process handle. |
| Open a resource | `omp sock open <selector> profile` | `profile`, `transcript` or `folder`; uses the configured editor. |

Inside the existing OMP terminal:

| Command | Meaning |
|---|---|
| `/name` | Show the current attach name. |
| `/name <name>` | Set or change the attach name, with visible confirmation. |
| `/name clear` | Remove only the name; the same UUID, history, profile and memory access remain. `clear` is a reserved action, not a name argument. |
| `/rename <title>` (`/title`) | Change the conversation title, not its attach name. |

A new visible RPC chat (including an explicit fork with a fresh UUID) can opt into OMP's normal conversation titles with [`--auto-title`](./rpc.md#startup). Keep the stable attach name separate; a manual conversation title is not automatically replaced. Do not add the opt-in on attach, wake, or resume of an existing journal.

Names differing only by case cannot belong to different sessions. Historical case-colliding claims are reported, refuse selection, and are never rewritten automatically. `/context` opens OMP's context browser, and `/restart` runs the ordinary local restart path; the explicit graceful API/CLI is the checkpoint handshake. Already-running owners need a controlled upgrade before new slash commands are available.

**Starting a genuinely new conversation is different from waking:** launch `omp` normally, optionally with `--agent PROFILE --agent-cwd /definition/root`. The existing CLI/host launch owner creates its UUID. `wake_session` does not create, and RPC `new_session` switches the current owner rather than creating an independent actor. An Exocortex host must use its authoritative session-creation seam; do not spawn a second client or a Bun subprocess shim from a leaf plugin.

## Exocortex / Node: borrow the existing connection

DSH bridge candidate `705718c8e5` exposes `ctx.ompRpc.nativeSessionTransport(sessionId: SessionId): OmpNativeSessionTransport | undefined` from `@deepseek-ai/dsh-omp-rpc`. Check that the installed host exposes it. Its `request(command: OmpRpcCommand): Promise<unknown>` returns the parsed envelope; `observe(listener: (event: unknown) => void): () => void` returns the unsubscribe function.

- `sessionId` is the **host/DSH `SessionId`** of the session your caller already attached and is authorized to operate. It is not a guessed native UUID, a native name, or a catalog lookup.
- The call never attaches, wakes, spawns or reconnects. No live attachment returns `undefined` — render "not attached", do not wake.
- The returned object is frozen and covers that one attachment; **detach/rebind invalidates it** (requests reject). Acquire a new transport and a fresh native owner receipt rather than silently following another owner.
- `request` preserves the whole response envelope including refusal codes. `observe` starts at subscription time: it is not a replay source, and stopping it releases only that observer (a throwing listener stops only itself). Unsubscribe in your Cordis lifecycle; never close the shared connection.

This read-only example runs with an existing attachment. A catalog match is not enough: the connected owner must prove it serves the selected conversation.

```ts
import { NativeSessionApi, type NativeSessionApiTransport } from "@oh-my-pi/pi-coding-agent/session/native-session-api";

export async function inspectAttached(transport: NativeSessionApiTransport, name: string) {
  const api = new NativeSessionApi(transport);
  const saved = await api.resolve(name);
  const { restartReceipt: owner } = await api.preflight();
  const state = await api.state();
  if (!owner || !saved.sessionFile ||
      owner.sessionId !== saved.sessionId || owner.sessionFile !== saved.sessionFile ||
      state.sessionId !== owner.sessionId || state.sessionFile !== owner.sessionFile) {
    throw new Error("The attachment does not match the selected session");
  }
  return { sessionId: owner.sessionId, sessionFile: owner.sessionFile, bootId: owner.bootId };
}
```

From the host, call `const transport = ctx.ompRpc.nativeSessionTransport(dshSessionId)`; if it is absent, show “not attached”. Otherwise call `await inspectAttached(transport, name)`. On a mismatch, do not issue a mutation or create a replacement. `api.wake({ sessionId, sessionFile })` is an explicit action; it does **not** retarget the caller's transport. After waking, obtain the selected conversation's attachment from the host.

For a deliberate rename or clear on the verified attachment, use `api.setIdentity(owner, { actorHandle: newName })` or `{ actorHandle: null }`. For a restart, choose **one** operation: `api.control(owner, "restart")` for normal restart, or `api.control(owner, "restart", { graceful: true, compactBeforeRestart: true })` if preflight reports `refreshModes.graceful` and the operator wants a checkpoint.

These restart examples are alternatives, not a sequence: after a restart request, do not issue another using the old receipt. `control` also supports `abort`, `compact` and cooperative `sleep`. Exact refresh does not support force; refusal never falls back to signalling a PID.

**Hard kill is intentionally not a Node facade method yet.** Native CLI and the Bun-side `NativeSessionService.control(selector, "kill")` use the existing broker's stable spawned-process handle. The Node bridge currently has no equivalent authenticated supervisor operation. Exocortex must expose that operation through its existing authoritative host/broker seam before wiring a kill button; do not substitute `process.kill`, shell out to `omp`, or invent a transport. The same distinction applies to creating an independent new owner: use the host's actual creation API, not `wake` or `new_session`.

## Graceful restart is a handshake, not "kill later"

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

Mail is pull-only. Sending requires the sender's mail capability and the recipient's consent. Unknown senders cannot leave requests or wake recipients. An interactive introduction uses the sender's native terminal selector, not an `ask` tool call.

```ts
// Send over the sender's connection. A raw RPC post cannot open a dialog.
const sent = await senderApi.sendMail({ to: "repository-owner", message: "Please inspect the saved patch." });
// Read or revoke through the recipient's connection.
const inbox = await recipientApi.readMail({ limit: 20 });
const older = inbox.nextBefore ? await recipientApi.readMail({ before: inbox.nextBefore }) : undefined;
await recipientApi.setMailContact(senderUuid, "block");
```

The same read is available from the terminal over the existing socket:

```sh
omp sock raw atlas '{"type":"agent_mail_list"}'
```

To try a first send without contacting a real session, run `bun packages/coding-agent/test/fixtures/mail-consent-demo.ts` from this source checkout in a terminal. Type `send the release note to games`. The demo uses a mock model and a disposable, offline `games` mailbox. After your choice it prints the stored count and whether the recipient stayed offline.

- **Live recipient:** the sender owner keeps the existing authenticated transport and completes the verified single-use capability handshake with the recipient owner before anything is stored. Do not add a second transport, a shadow inbox or a CLI subprocess wrapper.
- **Saved recipient:** with no live owner, the sender temporarily reserves that exact canonical journal through the session owner and appends under the journal lease. No owner process is created; a sleeping session stays asleep.
- **Receipt:** `{ messageId, threadId, admission: "stored", recipient, target }`. It means the journal holds the record. `target.bootId` is `null` only when there was no live owner; otherwise it is the exact storing owner incarnation. Acceptance never includes a wake, a read or a run.
- **UNKNOWN:** when the answer does not arrive, the outcome is unproved; **do not automatically resend**. There is no retry loop.
- **Read:** deliberate and bounded (`limit` default 20, max 100), newest last, optional `threadId`. Approved mail is in `inbox`. `requests` reads historical records only.
- **Paging:** `total` counts every match for the folder/thread and is stable across pages; `truncated` means older matches remain before the returned page. When `nextBefore` is present, pass it as `before` with the same folder/thread. There is no unread cursor, watch loop or retry queue.
- **Terminal introduction:** name the exact destination in a local editor submission. An `agent_mail` send to a new contact can then pause for review of the sender, recipient and message. Cancel stores nothing; send once approves that message only; always allow also saves a one-way grant between the session UUIDs. The model cannot supply the choice. A blocked contact cannot prompt. No interactive approval host means no introduction.
- **RPC:** `agent_mail_post_consented` uses an existing recipient grant. `setMailContact(peerUuid, "block" | "reset")` restricts or revokes it; neither operation grants access. External hosts cannot impersonate a terminal click. Do not fall back to submitting operator input to deliver mail.
- **Sender and authority:** show who sent the message. A peer can share observations or ask for work; the message does not grant operator permission.
- **Version boundary:** the post and live delivery opcodes are distinct from pre-consent owners; unsupported means unavailable. Never fall back to `agent_mail_send`, `agent_mail_post`, `agent_mail_deliver` or a raw prompt.
- **Scope:** this is mail, not a sandbox or an isolation boundary. Same-user processes can still reach files and sockets outside these APIs; do not claim otherwise.

A post emits **no** live `agent_mail` event: do not wait for a notification, poll an event stream for arrival, or claim the recipient was notified. Histories written by older runtimes may replay `agent_mail` records; treat those as historical data, not as proof that new mail arrived. Read deliberately instead. Use the host's existing event stream for core tool/message events and the native facade for its owned session events. Unknown event kinds stay unknown; do not forge success or idle.

### Correlation, reconnect and replay

- Responses correlate by the request `id` the host preserved; events are not responses and never resolve a pending request. See the protocol reference's Request/Response Correlation and Event Stream Schema (`docs/rpc.md`), and the payload fields in `wire/events.ts`.
- A newly attached or newly subscribed observer receives events from that moment. It is **not** sent earlier frames, and detaching is not cancellation. Rebuild state from the canonical history (`omp sock read`, `get_entries`, `get_state`), which is the replay authority — the live stream is not.
- A `tool_execution_end` you cannot match to a start you observed is missing correlation: report it as unknown provenance. Do not attribute it to the next call, and do not execute anything to "repair" history.
- Reconnect means re-acquire through the host pipeline and re-verify UUID/journal/boot. It does not mean reconnecting a private socket or resending a prompt.

## Context and the old `actor` CLI

Use `omp sock context <session> --json`, `api.state()` or in-session `/context` to inspect the running session. `systemPrompt` is the effective text. `dumpTools` lists only top-level tools, with names, descriptions and parameter schemas. The agent calls `read({"path":"xd://"})` for its mounted devices and `read({"path":"xd://<device>"})` for a device's schema. These reads are tool calls, not RPC commands. See [`get_state` in the RPC reference](./rpc.md#get_state-payload). Keep inspection authenticated and session-scoped.

A composition that also provides `get_context` can expose ordered **base-source** layer metadata. Feature-detect it; match session/boot/generation/effective revision before joining it to `get_state`. Base source character counts are not a partition of effective prompt size. Preserve partial/unattributed/unavailable states; do not parse prompt text or sum layer weights into invented token totals.

This is **not yet full parity with Worlds' `actor context`**: its disk-wide capability catalog, boot-versus-current rule/profile drift, knowledge declarations and externally injected block provenance belong to their source owners. Do not import that CLI, run it as a subprocess, or copy its catalogs into a plugin to fake missing native fields.

The native `omp sock` command set replaces the socket-specific discovery/read/attach/control paths. It does not authorize deleting `actor`, `actors.json`, or non-socket project/cockpit/profile operations. Remove the old path only after its callers and saved bindings are migrated with parity proof. UUID-first use and optional on-demand naming do **not** require bulk migration first.

## Where the authoritative details live

| Topic | Source |
|---|---|
| Wire schema (generated) | `packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json`; regenerate with `bun run gen:rpc` in `packages/coding-agent` (writes `rpc-wire.generated.ts` and the SDK wire modules) |
| Commands and responses | `packages/coding-agent/src/modes/rpc/rpc-types.ts`; `docs/rpc.md#command-schema-canonical` |
| Events | `packages/coding-agent/src/modes/rpc/wire/events.ts`; `docs/rpc.md#event-stream-schema` and `#request-response-correlation` |
| Generated clients | `sdk/python/omp-rpc`, `sdk/rust/omp-rpc`, `sdk/go/omp-rpc` (`*_wire`/`wire.*` generated from that schema) |
| Node facade | `packages/coding-agent/src/session/native-session-api.ts` (exported as `@oh-my-pi/pi-coding-agent/session/native-session-api` via the package's `./*` export) |
| Negotiation and framing | `docs/rpc.md#transport-and-framing` (`ready` frame, `negotiate_protocol`, v2 chunking) |
| Tool registration and scoping | `docs/rpc.md#set_host_tools-payload` and `#set_host_uri_schemes-payload`; per-connection host tools, replaced by the host, never a global plugin registry |
| Cancellation | `abort`/`abort_and_prompt` for turns, `cancel_subagent` for subagents, `omp sock stop`/`abort` for a turn, cooperative `sleep` for an owner; none of them selects or creates a session |
| Lifecycle and compatibility | this page's restart/sleep/persistence sections plus `get_refresh_preflight` capabilities; legacy owner refusals remain code-less |
| Name conflicts | `SessionIdentityNameConflict` in the generated schema; `list_sessions` → `conflicts`; typed errors above |
| CLI surface | `omp sock --help` / `omp sock <action> --help`; `packages/coding-agent/src/cli/sock-cli.ts` |

## Failure rules

- Old owners may refuse newer commands. `NativeSessionApiError.code` is preserved when supplied; code-less legacy refusal text remains code-less. Show unsupported/unavailable rather than healthy/idle.
- A duplicated historical name refuses **selection**, as do mixed name/UUID ambiguity, ambiguous UUID prefixes, wrong journals, changed boot IDs and held leases. Do not retry under a different name, guess a claimant, or create a replacement conversation.
- A name conflict in the list is a diagnostic, not permission to mutate another session. Only an explicit UUID-scoped rename or clear changes a claim; nothing is deleted automatically.
- Sleep/restart scheduling is not completion. Verify actual owner exit or a fresh native boot receipt.
- One-hour detached idle sleep is the default (`session.idleSleepSeconds: 3600`); profiles and per-session metadata can override it, and `0` disables it. Pending work and attached viewers prevent idle retirement. Installing new code alone does not change already-running owners.
