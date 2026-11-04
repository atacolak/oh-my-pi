# Persistent session PTY owner Technical Spec

**Design Brief:** `/home/sf/worlds/personal/designs/oh-my-pi/omp-daemon-socket-attach.md`
**Status:** sound
**Repo:** `/home/sf/worktrees/omp/cap/omp-daemon-socket`
**Capability / bead:** `cap/omp-daemon-socket` / `omp-t4j`
**Evidence:** inspected branch source on 2026-11-04; supplied baseline is `57d67200ab5e`, with a separately landing detach change. Line references below describe the inspected snapshot, not immutable future locations. All source paths are repo-relative. No production edits or checks were performed for this dossier.

## Intent (from the Brief — do not rewrite)

> A running `omp` mind must outlive its terminal. Closing a Herdr pane or losing the
> PTY must not kill the session, and must not kill Web UI clients attached to it.
> `omp --resume <id>` (or `omp` targeting a live id) must reconnect to the live owner
> rather than opening a second `SessionManager`, because a second opener does not
> error - it silently diverges onto a sibling transcript.

> Outcome demanded by the operator, verbatim in substance: killing a Herdr pane never
> kills the running OMP mind, and TUI + Web are simultaneous 1:1 views of one process.

Ratified decisions, quoted:

> Everything stays on `cap/omp-daemon-socket`. Caps do not stack; a second branch
> on top cannot be composed by the runtime integrator.

> Option (B): a session process owns a virtual PTY plus the `<sessionId>.sock` RPC
> server; an attaching terminal mirrors the PTY. Web remains an RPC client.

> Detach and dispose are different things. Detach keeps the session, the socket and
> the process alive; dispose is the real quit and keeps today's behaviour.

The Brief's prohibition on changes to `main`, `runtime`, and the generation pin means deployment branches/pins, not a prohibition on editing `src/main.ts`: the explicitly requested resume and socket lifetime seams live in that file. This work does not publish or change any runtime generation.

## Mapping onto the current system

### Observed / supplied evidence

| Concern | Current seam and consequence |
| --- | --- |
| Existing PTY substrate | `packages/coding-agent/src/launch/broker.ts:819-900` creates `PtySession`, retains it on the managed record, and receives output chunks; `:1242-1269` injects input and signals. Reuse, do not reconstruct. |
| Input/signal distinction | `broker.ts:1252` writes bytes; POSIX signals actually kill the process tree at `:1264-1266`. The `SIGINT` to Ctrl-C translation at `:1260-1262` is Windows-specific. Mirror disconnect must invoke neither path. |
| Missing output subscription | `launch/protocol.ts:30-68` contains request/response operations, no terminal attach/stream. Unsolicited messages already exist for completion (`:113-121`); `launch/client.ts:337-365` currently assumes every event is a completion. |
| Process independence | `launch/client.ts:306-321` spawns and unrefs the broker; `broker.ts:1541-1555` retains it for live persistent records. `persist:true` is essential. `detached:true` is wrong here: `broker.ts:924-943` redirects output to files and ignores input. |
| Service-oriented reuse | `launch/ensure.ts:1-6` names Chromium, browser relay and LSP mux. Session ownership is a new use of the substrate, not an existing session daemon feature. `describeDaemon` at `:55-84` distinguishes absent from unknown; quiet ensure failure is not safe authorization to open a transcript. |
| Owner's RPC publication | `main.ts:2818-2835` constructs sockets for RPC and interactive hosts. `rpc-socket.ts:344-358` publishes under the profile-independent config root's `run/`. Metadata currently lacks broker attachment coordinates (`:43-51`). |
| UI owns endpoint today | `modes/interactive-mode.ts:7857-7865` attaches and closes the interactive socket. `main.ts:788-798` is a **startup-error cleanup**, not a general `run()` finally; do not treat that line as evidence that every ordinary view departure ends the process. Actual terminal shutdown runs `interactive-mode.ts:8107-8168`. |
| Destructive UI teardown | `interactive-mode.ts:7866-7876` hides plan review, aborts dialog lifetime and disposes publishers. A mirror disconnect must not call `stop()`, `shutdown()`, or this body. |
| Transcript divergence | `session-manager.ts:2370-2376` says opening claims nothing; `:1120-1144` obtains ownership on writes; `:1496-1498`, `:1661`, `:1793` branch on another owner. |
| Lease authority | `session-storage.ts:640-656` exposes acquire and tri-state held probes. `:1334-1359` shares lease holders in-process. The legacy claim API converts unexpected acquire errors into a no-op release (`:1342-1344`); a strict owner reservation must not inherit that permissive behavior. |
| UI response gap | `rpc-command-surface.ts:971-973` can resolve a response **only for an existing pending request**. The interactive publisher creates its own unconnected pending map and no host (`:2024-2033`); host commands including `set_ask_dialog` are refused at `:1169`. There is no end-to-end Web approval path here. |

### Inferences / implementation risks

- Keeping the same `InteractiveMode`, component tree, controllers and `AgentSession` inside a persistent slave PTY avoids remoting the roughly 200 direct calls mentioned in the Brief. This is an architectural consequence, not a verified count.
- Reinitializing only the terminal renderer on reattach should restore an existing dialog and draft without settling it. Existing editor handoff uses `ui.stop(); ... ui.start(); ui.requestRender(true)` at `interactive-mode.ts:6480-6494` and `:6506-6515`; the actual PTY/mirror combination still needs a real probe.
- The broker's query responder is not a terminal emulator: `packages/utils/src/vterm/query-responder.ts:17-30` explicitly returns home-position reports. It cannot simultaneously answer probes that the physical terminal also answers.

## Architecture

### Answer 1 — extend the broker, do not self-daemonize

Choose the existing `launch/broker.ts` supervisor. Ownership tree:

```text
independent project broker
  owns PTY master + managed child record (persist=true, pty=true,
  detached=false, restart=no)
    session-owner child
      owns PTY slave / controlling terminal
      owns AgentSession + InteractiveMode + SessionManager writer lease
      owns <sessionId>.sock and its existing RPC command surface

Herdr pane process = terminal mirror only
  broker IPC: terminal stream / raw input / resize / unsubscribe
  session IPC: identity check + renderer refresh control
Web = existing <sessionId>.sock RPC client
```

“Session process owns a virtual PTY” is a logical lifetime boundary: the broker physically holds the PTY master, the session child physically holds the slave and the mind. Neither belongs to the Herdr pane. Losing the **outer physical** terminal is detach; losing the **inner session PTY master** is owner failure and is not promised to survive a broker crash.

Use `persist:true`, **not** broker `mode:detached`; the latter restarts as a non-PTY process (`broker.ts:1317-1320`). No automatic mind restart: restart cannot restore in-flight agent/tool state. An explicit quit disposes the child and lets the ordinary record settle. Ordinary broker idle grace must never stop a live session record.

The alternative is a dedicated self-daemonizing session host retaining its own PTY master and spawning the interactive child. It can satisfy the same operator invariants, but duplicates detached startup, authenticated IPC, launch races, PTY callbacks, signals, metadata, logging and shutdown. Its advantage is isolating sessions from a service-broker crash or explicit broker shutdown. That additional failure domain is not required by the Brief; the existing supervisor is the smaller maintainable implementation. Do not confuse “ignore SIGHUP in today's pane process” with either valid architecture: a killed pane can SIGKILL the process or close its terminal.

### Answer 2 — add streaming IPC frames, not another listener

Extend the **authenticated broker connection**, not the session RPC wire schema. Use a dedicated broker client connection for each terminal mirror, so control requests and streaming lifecycle have a clear owner. No second PTY-output socket is necessary.

New operations (names are the implementation contract):

```ts
{ op: "terminal_start", subscriptionId: string,
  spec: DaemonSpec, columns: number, rows: number }
{ op: "terminal_attach", subscriptionId: string,
  name: string, id: string, columns: number, rows: number }
{ op: "terminal_resize", subscriptionId: string,
  name: string, id: string, columns: number, rows: number }
{ op: "terminal_detach", subscriptionId: string,
  name: string, id: string }

// New unsolicited variants of DaemonWireMessage:
{ event: "terminal_output", subscriptionId: string,
  name: string, id: string, sequence: number, data: string }
{ event: "terminal_exit", subscriptionId: string,
  name: string, id: string, exitCode?: number, reason?: string }
```
Extend existing `send` with an optional expected record `id`; terminal mirrors always supply it, and the broker rejects a mismatch before writing. Legacy service callers can omit it. Bound outstanding streamed bytes with per-subscription sequence acknowledgements (`terminal_ack`); the mirror acknowledges only after its stdout drain accepts the chunk. Retire a subscription on its configured byte ceiling without waiting on or stopping the owner. This is flow control for the required output path, not session RPC telemetry.


`id` is `DaemonSnapshot.id`, not a PID. Every subscription is bound to that generation; replacement never silently moves a mirror to another mind. `terminal_start` installs its subscriber **before** `#launch` so the first paint and setup dialog cannot be lost between a normal `start` response and `attach`. It delegates the existing start mechanics, not a second spawn implementation. Its stream sink is installed by the client before sending the request, keyed by `subscriptionId`.
Feed output at `broker.ts:844-856`, before `#onOutput` sanitizes log text (`:965-970`). Never mirror `logs`, `terminalRows`, or `sanitizeText` output: a TUI needs escapes and incremental cursor motion, not plain text. Bound frames below the native frame limit and preserve string/code-point order; the existing native PTY callback supplies strings. Sequence numbers detect loss; an overflow closes the **mirror subscription**, not the PTY or mind. Never silently drop frames. Reconnect obtains a new full repaint, not a potentially truncated log replay.

A reconnect subscribes first, then sends a transport-local `terminal_refresh` frame to the session endpoint; the child reinitializes terminal modes and forces a full repaint from its existing component tree. This frame is intercepted by the interactive socket adapter before `RpcCommandSurface.dispatch`, is available only when that publication has broker-owner attachment metadata, and does not become a new `RpcCommand` or host capability for ordinary RPC hosts. It carries the expected session id and broker generation; mismatches are rejected. The first mirror needs no refresh because `terminal_start` captures initialization from byte one.

During a reattach, only `ui.stop()/ui.start()` and forced repaint run, never `InteractiveMode.stop()` or `AgentSession.dispose()`. Raw log replay is deliberately rejected: it can replay clipboard writes, notifications and external-editor effects, and bounded logs are not complete terminal state. `launch/terminal-output.ts:21-44` is a text-row replay helper, not a styled terminal-state serializer.

Query ownership is singular: with no mirror, use the existing responder; with a mirror, forward probes and accept the physical terminal's replies. Change responder mode before triggering renderer refresh. Do not run a second `ProcessTerminal` parser in the mirror: it passes raw stdin bytes, including bracketed paste and terminal replies, to the existing broker `send`. On detaching, resume fallback query responses; never convert a disconnect into Ctrl-C. Resize calls the native PTY resize API and updates the inner TUI through its ordinary SIGWINCH/resize path (`interactive-mode.ts:2172-2176`). Keep the last dimensions while detached.

The Brief requires Web plus TUI, not several independently sized TUI renderers. Keep one writable terminal subscription per managed session: a second attach reports terminal-busy without stealing or disposing the first. Web clients are not terminal subscriptions and remain simultaneous. This avoids two physical terminals answering the same query or racing viewport size; multi-terminal sharing/arbitration is outside this capability.

### Answer 3 — attach-before-open; stale is an explicit refusal

Place the decision **before `createSessionManager`** in the root interactive startup path (`main.ts:2112-2196`, and the explicit target resolution in `:1313-1357`). Resolve full id/path/prefix using read-only listing/header resolution; do not use `SessionManager.open` to discover identity. Apply the same attach gate after the startup picker and for implicit continue/auto-resume target selection before opening their target. Explicit `--fork` intentionally creates a different session and retains its current semantics.

Probe `<baseConfigRoot>/run/<fullId>.sock` and discovery metadata, not socket-file existence alone. Complete the existing ready/`get_state` exchange and verify full session identity. An optional metadata `terminal` object supplies `{ protocolVersion: 1, projectDir, name, id }`; its absence is not proof of death. The session child writes it on publication/rebind, deriving it from its broker-provided launch context. Broker name/generation stay stable across in-process `/new` or session switches; `<sessionId>.sock` follows the actual session identity as it already does.

Decision table:

| Observation | Action |
| --- | --- |
| Reachable matching session and valid broker terminal coordinates | Attach that generation, refresh its renderer, return from outer startup without constructing an `AgentSession` or opening a manager. |
| Reachable session but no terminal capability (legacy interactive host or RPC-only host) | Report a live owner without attach capability. Do not cold-open or silently branch. Existing RPC clients remain usable. |
| Socket or metadata exists but connect/identity/attach fails | Fail with a session-specific unreachable-owner error. Do not unlink it, spawn a replacement, open the transcript, or retry through `createSessionManager`. This is the stale-but-unreachable decision. |
| No publication, but lease is held or cannot be probed | Fail closed: owner busy/unreachable or ownership unknown. No manager open. |
| No publication, lease demonstrably free | Start a broker-owned child to resume from disk; obtain a **strict ownership reservation** before any session mutation. Recheck publication after reservation. A race loser attaches to the winner when reachable, otherwise refuses. |
| Fresh interactive session | Use atomic `terminal_start`; only its child creates the manager. |

A stale sidecar may therefore require explicit owner/artifact recovery outside this command even if its PID is dead. This intentionally conservative behavior answers the Brief's stale-endpoint choice without inventing a destructive auto-recovery policy. A cleanly stopped owner withdraws its publication and permits normal cold resume.

The strict reservation is an opt-in owner path backed by the existing storage lease map, held through manager adoption/close; do not acquire then release a temporary probe lock before opening. Add a strict storage acquire path that propagates unknown lock failures instead of the no-op fallback at `session-storage.ts:1342-1344`. Transfer it into the same in-process holder accounting used by `FileSessionStorage.claimSession`, avoiding a second lock against our own reservation. Add a fail-on-owner-conflict manager policy for this owner path: all attempted `#moveOffSessionFile("open-elsewhere")` become an explicit error, never a sibling transcript. Preserve legacy SDK/explicit-fork semantics by leaving their default policy unchanged.

### Answer 4 — detach must run none of `#doDispose`

Detach means removing the broker subscription and restoring **the outer mirror's** local terminal state. The inner PTY, renderer, pending dialogs, session socket, writer lease and running work remain alive. It is not “dispose except for `SESSION_EXIT`”. The following entire teardown is forbidden on detach:

| Current `agent-session.ts` lines | Must NOT execute because of mirror loss |
| --- | --- |
| `6385` | `beginDispose()` and its work-admission barrier. |
| `6389-6394` | Clear cache-warmer callbacks or cancel warming. |
| `6395-6399` | Record session exit, cancel the exit recorder, or cancel fatal-recovery hints. In this snapshot the record call is **6395**, not 6396. |
| `6400-6404` | Emit extension `session_shutdown`. |
| `6407-6411` | Clear extension timers; abort retry, compaction, post-prompt tasks or the agent. |
| `6412-6422` | Dispose-time post-prompt/autolearn/memory-transition draining. |
| `6424-6434` | Detach mnemopi state; flush/release sharpshooter; close advisor recorder. |
| `6435` | Release owned shell sessions. |
| `6436-6446` | Dispose owned async jobs/eval kernels; release browser tabs/computer sessions; disconnect owned MCP; close advisors; perform shutdown Hindsight/mnemopi/embed/sharpshooter flushing. |
| `6455-6461` | Release power assertion; clean moved empty session; clear move tracking; close provider sessions; cancel speculation; clear/dispose Hindsight state. |
| `6462-6467` | Disconnect agent; run remaining disposers; clear event, run-state or session-change listeners. |
| `6478-6493` | Remove provider/SSE interceptors or wait for idle as a terminal dispose drain. |
| `6505-6506` | Seal/close the session manager, releasing its writer. This continuation is essential even though the question's supplied range ended at 6480. |
| `6514-6537` | Release retained conversation memory or account-pool scope, immediately or through deferred terminal finalization. |

Also forbidden on detach: `InteractiveMode.stop()/shutdown()/#teardown()`, dialog-lifetime abort and plan-review dismissal (`interactive-mode.ts:7866-7873`), collaboration goodbye (`:8128`), live/BTW teardown (`:8129-8130`), `ServedSessionSocket.close()` (`rpc-command-surface.ts:2047-2051`), and process postmortem cleanup. None is called from broker subscription close.

True quit retains all of the above, once, including its terminal journal diagnostic. Existing direct-host detach-on-hangup work may land first but is not the persistent-host mechanism: an owner whose **inner** PTY really disappears still takes its normal failure/exit path. Do not install a hangup-swallowing handler in the persistent PTY child.

### Answer 5 — Web cannot answer those interactive requests today; bridge is not in scope

**No end-to-end support today.** `rpc-command-surface.ts:971-973` accepting `extension_ui_response` does not make the interactive UI's pending requests available to that map. The interactive publisher omits `host` (`:2024-2033`), and `set_ask_dialog` is a host command rejected at `:1169`. Adding `host` alone is insufficient and would accidentally expose unrelated RPC-runner services.

This capability preserves the in-process interactive UI host. When no physical TUI is attached, a permission dialog/ask remains in the live component/controller tree and waits for reattachment; existing caller cancellation and configured timeout behavior remain unchanged. Do not auto-approve, synthesize an answer, deny on detach, or claim a Web-only unattended approval flow. TUI reattachment renders the pending gate and can answer it. Other non-gated work continues and Web state/events/prompts retain their existing support.

A future bridge has a clean hook: inject a shared interactive UI request broker into `serveInteractiveSessionSocket` alongside a narrow `setAskDialog` capability, feeding the **same** pending map and UI controller cancellation lifetime. It would need routing/claiming, response ownership, TUI-versus-Web races, and disconnect semantics. That is a separate operator-visible behavior; no general approval protocol or host-service extraction is hidden in this plan.

## Components and interfaces

1. **Broker terminal subscription** — extend `launch/protocol.ts`, `broker.ts`, `client.ts`. Own per-connection stream state and generation fences. Existing service operations retain behavior and wire compatibility. Check the installed broker's terminal capability before use; an old broker must reject explicitly rather than degrade into disk opening. Do not restart an old broker that owns live service processes as a silent compatibility maneuver.
2. **Session owner launcher** — new `launch/session-owner.ts`, with a hidden CLI worker selector following `cli.ts:114-118` and existing worker dispatch. Reenter the existing CLI with original argv/profile/cwd and a private owner-role guard. Only ordinary interactive launches enter this route; print/RPC/ACP/SDK use their current hosts. `--no-session` can use the same ephemeral owner path but remains unresumable by a future invocation.
3. **Terminal mirror** — new `launch/terminal-mirror.ts`. Raw byte forwarding, output delivery, resize, local terminal restoration and detach. No `AgentSession`, no session manager and no TUI command dispatch in this process. Suppress speculative startup composer creation in the outer process (`cli.ts:539-551`); retain it in the owner child so one process owns startup input from the beginning.
4. **Live target resolution** — new `launch/session-attach.ts`, called by `main.ts` before manager construction. Reuse listing/header resolution and lease primitives; implement the decision table above as a discriminated result, never a broad catch-to-cold fallback.
5. **Owner publication and refresh** — optional broker coordinates in `rpc-socket.ts` metadata and an optional transport-local frame handler on the interactive socket adapter. `InteractiveMode.refreshTerminalAttachment()` performs only renderer stop/start/repaint. Keep endpoint publication scoped to the owner; refreshing a mirror never closes it.
6. **Strict writer reservation** — extend `session-storage.ts` holder accounting and `session-manager.ts` conflict policy solely for broker-owned native resumes. Release on startup failure/real quit, not mirror close. Revalidate on session switches, while intentional fork/new commands keep their explicit transition semantics.
Consume broker-provided owner environment context into process-local module state and remove it from `process.env` before normal startup. Descendant tool processes must not inherit a role marker that makes a later, unrelated `omp` invocation skip the mirror/owner decision.

The hidden owner route must not inherit physical-terminal parent-death/IPC-disconnect monitoring. `cli.ts:412-417` installs a watchdog inside `runIpcSubprocessWorker`; use normal worker dispatch/reentry, with the broker as the actual independent parent, not that helper with a mirror-owned IPC transport.


### Direct `InteractiveMode` call-site impact

No broad RPC conversion. Approvals, plan proposals, OAuth prompts, widgets, job subscriptions, user input submission and extension UI remain in-process. Specifically unchanged: `main.ts:428-490` direct submission, consent/approval hooks at `interactive-mode.ts:2413-2437`, extension UI host at `:9531-9537`, and existing controller methods called through `InteractiveModeContext`.

The narrow touches are constructor/owner bootstrap plumbing, `attachSessionSocket` lifetime ownership, the new renderer-refresh method, terminal startup/prepaint routing, and final owner shutdown. The existing external-editor stop/start sites remain local. No requirement to convert the ~200 calls, or to move their UI into the outer mirror. LSP references were unavailable in this worktree, so this is a seam inventory rather than a claimed exhaustive symbol-reference count; builders must use references if their server is available before exported changes.

## Data / control flow

**Fresh launch:** root parser selects interactive → outer prepaint disabled → broker `terminal_start` subscribes before spawn → child reenters existing CLI with owner guard → child constructs manager/session/InteractiveMode → child publishes existing RPC endpoint with broker coordinates → terminal sees real startup bytes; Web attaches independently.

**Detach:** outer PTY closes, outer process is killed, or broker stream disconnects → subscription removed → fallback responder takes terminal queries → persistent broker record and inner PTY stay live → session keeps writing same journal; Web connection stays open. No session RPC connection is required for detach.

**Reattach:** resolve id read-only → connect/verify live RPC identity → obtain broker coordinates → attach exact live generation → mirror enables raw byte path → interactive transport-local refresh restarts renderer I/O/probes and forces full paint → original draft/dialog/turn remains in the original process. Reattachment does not resubmit CLI startup prompts/goals or replay side-effectful startup flags against the live session; reject incompatible creation-only arguments explicitly rather than silently applying them to a second owner.

**Cold resume:** no publication + free lease → strict child reservation → publication recheck → manager adopts reservation and original file → ordinary startup. Concurrent losers do not write sibling files.

**Real quit:** input bytes reach existing `/exit` or existing Ctrl-C semantics → normal interactive teardown/session disposal → exit journal entry and socket withdrawal → broker terminal-exit event → mirror restores physical terminal and exits with child status.

## Error handling

- Stale, unreachable, mismatched, old-protocol or non-terminal live owners: explicit failure, no open/fork fallback. Include full session id and endpoint in the error; do not expose broker tokens.
- Broker connection failure: terminal detaches; no `stop`, `signal`, `mode:detached` or child teardown. A broker crash can end its slave PTYs; this design does not promise broker-crash survival.
- Slow mirror: bounded subscription queue, disconnect on overflow; no unbounded buffering and no backpressure that stalls the mind or Web. Reattach forces repaint.
- Mirror signal: local cleanup only. Keyboard Ctrl-C is raw input and retains the inner application's normal behavior; kernel SIGTERM/SIGHUP delivered to the mirror is not forwarded.
- Renderer refresh failure: report attach failed and close that mirror only. The session and Web remain alive; do not dispose or cancel approvals to make the display recover.
- Owner startup failure: settle the managed record, close only its publication, release reserved lease; report actual exit status. Do not leave an immortal empty record on a launch that never produced a session.
- Endpoint/identity mutation: use current sidecar and session socket identity; reject a stale generation instead of following PID reuse or an unrelated replacement.

## Testing (behavioral contracts; exact tests live in the plan)

Every stage has `builder` ownership; the lead owns independent verification. Keep this one capability green between commits. The supplied **343 passed / 0 failed RPC baseline is a floor, not a new measurement**. Record its exact existing test selection in the bead and rerun that same selection at each stage integration; new tests increase the count and never justify dropping an old file or skipping a case.

Required independent evidence:

- Real broker/PTY output reaches a mirror from the first byte, includes split escapes/Unicode, and is ordered. Raw keyboard input and resize arrive at the same child. Dropping its stream cannot stop that child.
- Kill a separate process representing the physical terminal with SIGKILL during a delayed mock-model turn; keep a real Web-like RPC connection open. Same PID/id/journal completes the turn; no exit entry and no sibling journal appear. `omp --resume <id>` opens no second manager and shows a marker produced while detached.
- Reattach an idle renderer with a draft and open approval; state remains pending, no implicit denial, and keyboard input can settle it after refresh. Verify cursor positions and terminal query replies, not just log text.
- Stale socket, stale sidecar, alive PID/unreachable endpoint, absent publication/held lease, unknown lease and simultaneous cold resumes all fail closed or elect exactly one owner. A negative assertion on sibling files and persistence notices is required.
- True `/exit` still disposes exactly once and writes its exit diagnostic. Service-daemon persist/session/detached modes and existing RPC v1/v2 multi-client behavior remain unchanged.

## Non-goals

- Stateless TUI/RPC-client conversion, cross-machine attach, multiple independent mind writers, Web approval implementation, broker-crash recovery, automatic provider restart, new recurring automation, changes to deployment branches or runtime pins.
- No production code, tests, builds, checks, commits or runtime installation are part of this planning assignment.
- “Independent stages” means independently verifiable additive increments on the same capability branch, not separate product features or stacking capabilities. The terminal transport and session integration form one dependent subsystem and use one implementation plan.

## Implementation approach chosen (and rejected internals)

1. **Chosen:** existing persistent broker + interactive owner child + new broker terminal frames + renderer refresh. Reuses spawn/input/leases/socket surface and leaves UI calls local.
2. **Rejected valid alternative:** dedicated self-daemonizing PTY host. Same operator result, more ownership/process/IPC infrastructure; pays for stronger broker-failure isolation not requested here.
3. **Rejected transport internal:** second raw-output listener per session. Requires additional endpoint permissions, discovery, stale cleanup and input/output lifetime coordination; existing broker event framing already supports multiplexing.
4. **Rejected restoration internal:** replay bounded daemon logs or plain terminal rows. Not a complete screen or protocol state and can replay external side effects. Refresh the still-live renderer instead.

## Open questions

No unsettled product questions. Engineering assumption to falsify before cutover: renderer-only stop/start plus a full repaint, after switching query ownership to the attached terminal, restores terminal modes and the original component tree without losing a pending gate. That determines the implementation seam, not a weaker operator contract.
