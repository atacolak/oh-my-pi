# Persistent session PTY owner Implementation Plan

**Technical Spec:** `docs/superpowers/specs/2026-11-04-session-pty-owner.md`
**Design Brief:** `/home/sf/worlds/personal/designs/oh-my-pi/omp-daemon-socket-attach.md` (via spec; do not bypass)

> **For the project lead:** first `br where` in this repo. no board → `br init --prefix omp` here (never `~/.beads`). then one campaign parent bead for this plan, then task-by-task with isolated `builder` workers. Do not implement these tasks inline. Persist progress in this file's checkboxes **and** as one parent-child bead per Task (`br create --parent --body`). Title `tN: <ask>` (prefix `[done] ` after verifier pass). Description markdown, ≤800 characters, wrap at ~60 cols: `Asked:` paragraph, then `## Landed` with sha/tests/leftover (`not yet` while in flight). Do not paste this plan packet. After pass, keep the child `in_progress` (mgr Rolling), assignee cleared — do not defer, do not `br close` until the parent parks (closed = Past the Stand). Lined Up is only for minted-not-yet-claimed children.

**Existing parent:** reuse `omp-t4j`; do not mint a competing campaign. All implementation integrates to `cap/omp-daemon-socket`. No deployment branch, generation pin, publication or stacked capability.

**Goal:** a terminal can disappear and later reconnect to the same living OMP session while Web RPC remains connected, without a second writer or a detach exit entry.
**Architecture:** extend the existing daemon broker with terminal-stream subscriptions and atomic start-and-subscribe. An interactive owner child retains its PTY, `AgentSession`, `InteractiveMode` and session RPC socket; the outer CLI forwards raw terminal bytes. Attach-before-open resolution and strict lease adoption fence stale endpoints and concurrent cold resumes.
**Tech stack:** existing TypeScript/Bun, native `PtySession`/`IpcConnection`, current `RpcSessionSocket`, current OS-backed session lease implementation, `bun:test`.

---

## File structure and responsibility

All paths below are repository-relative; line ranges refer to the spec's inspected snapshot and must be re-located after the independently landing detach commit. Exported changes require LSP references if available; the planner's worktree server could not answer references.

| File | Change |
| --- | --- |
| `packages/coding-agent/src/launch/protocol.ts` | Typed terminal operations/results/events, validation, optional generation fence on `send`, terminal capability advertisement. |
| `packages/coding-agent/src/launch/client.ts` | Typed event sinks, distinguish completion and terminal frames, subscribe-before-request, connection-local cleanup. |
| `packages/coding-agent/src/launch/broker.ts` | Atomic terminal start, live subscription, generation-fenced writes/resize, responder ownership, bounded flow control, disconnect-only cleanup. |
| `packages/coding-agent/src/launch/session-owner.ts` (new) | Consume private startup context, persistent child launch specification and worker reentry. |
| `packages/coding-agent/src/launch/session-attach.ts` (new) | Read-only live-owner resolution, exact fail-closed decision table. |
| `packages/coding-agent/src/launch/terminal-mirror.ts` (new) | Raw stdin/stdout, drain acknowledgement, resize, local cleanup, broker stream ownership. |
| `packages/coding-agent/src/cli/worker-selectors.ts` | Session-owner hidden worker selector. |
| `packages/coding-agent/src/cli.ts` | Dispatch owner worker and make speculative composer child-only for broker-owned interactive startup. |
| `packages/coding-agent/src/main.ts` | Pre-manager owner/attach routing; retain existing RPC/ACP/print runners; no duplicate startup goal on live attach. |
| `packages/coding-agent/src/modes/interactive-mode.ts` | Narrow renderer-only refresh method and owner socket-lifetime integration. No controller remoting. |
| `packages/coding-agent/src/modes/rpc/rpc-command-surface.ts` | Optional interactive transport-control interception for refresh; keep host command refusals. |
| `packages/coding-agent/src/modes/rpc/rpc-socket.ts` | Optional broker terminal coordinates in discovery metadata, preserved through rebind. |
| `packages/coding-agent/src/session/session-storage.ts` | Strict reservation/adoption using existing in-process lease holder map. |
| `packages/coding-agent/src/session/session-manager.ts` | Opt-in fail-on-owner-conflict policy; reserve before mutation and never branch on contention in that path. |
| `packages/coding-agent/test/launch/terminal-fixture.ts` (new) | Real broker fixture shared by transport tests, not production fallback code. |
| `packages/coding-agent/test/fixtures/session-terminal-owner.ts` (new) | Real PTY owner fixture using existing mock-model provider; test-only control/gating, no live provider calls. |
| Tests named in tasks | Behavioral contracts at protocol, broker, UI, lease, CLI and process boundaries. |
| `docs/rpc.md`, `packages/coding-agent/CHANGELOG.md` | Document lifetime/reattach/stale behavior and limitations; one changelog entry in the existing Unreleased section. |

The transport and session integration are a single dependent subsystem, not independently shippable product subsystems; one staged plan is appropriate.

## Integration rules

- Each numbered stage is additive and independently testable. Do not switch ordinary interactive launches until Stage 8. Until then, internal worker/test entrypoints exercise the new path without changing the default runner.
- Owner of each implementation stage: **builder**. Acceptance owner: **lead or separately assigned verifier**, using observed bytes/processes/files rather than an implementer's summary.
- Builders write tests and code but skip running checks mid-flight. After the stage's complete edit set lands, the lead performs its RED/PASS verification against the parent and new commit in isolated worktrees. This respects the repository's single verification-owner rule. The RED step uses the new test against the previous implementation, never the assertion that an unexecuted test “would fail”.
- At each stage integration, retain the supplied RPC **343 passed / 0 failed** baseline selection and record its exact command in `omp-t4j`. Do not redefine that selection from a broad glob if the original receipt exists. The visible repository test runner is `bun test`; if the old selection is unavailable, the lead runs `bun test packages/coding-agent/test/rpc*.test.ts` as a conservative broader selection and records the actual count rather than claiming it is exactly 343. Added cases may increase counts; zero failures and no removed/skipped baseline cases are mandatory.
- The commands in each stage are targeted checks for the lead/verifier, from repo root. No planner checks have been run.
- Never use `mode:detached`, automatic restart, stop-on-mirror-close, endpoint-unlink-on-probe-failure, or catch-all cold-open fallback.

## 1. Stage 1 / Task 1: broker terminal wire and client event routing

**Owner:** builder
**Files:**
- Modify: `packages/coding-agent/src/launch/protocol.ts:30-121,258-440`
- Modify: `packages/coding-agent/src/launch/client.ts:113-145,324-381`
- Test: `packages/coding-agent/test/launch/protocol.test.ts`
- Create: `packages/coding-agent/test/launch/client-terminal-events.test.ts`

**Acceptance / anti-gameable verification:** terminal envelopes decode to their own discriminated event variants; neither a terminal frame nor a malformed terminal frame is delivered as a daemon completion. Old `send`/completion frames still decode. Unsupported brokers produce an explicit capability error, not a silent alternate launch.
**Risk:** `client.ts` currently sends every event to completion handling; accidental widening can break service completion acknowledgements.

- [ ] **Step 1: add failing wire tests** in the existing protocol test module (use its imports, adding parsers where missing):

```ts
it("decodes terminal output without treating it as completion", () => {
  const frame = {
    event: "terminal_output", subscriptionId: "view-1",
    name: "mind-1", id: "generation-1", sequence: 1,
    data: "\x1b[2Jhello λ\r\n",
  };
  expect(parseDaemonWireMessage(frame)).toEqual(frame);
});
it("keeps the generation fence on terminal input", () => {
  const request = parseDaemonWireRequest({
    id: "request-1", token: "fixture-only", operation: {
      op: "send", name: "mind-1", id: "generation-1", data: "\u0003",
    },
  });
  expect(request.operation).toEqual({
    op: "send", name: "mind-1", id: "generation-1", data: "\u0003",
  });
});
```

Also exercise each operation's absent/invalid name/id/subscription, positive integer dimensions, monotonically nonnegative sequence and invalid data types. Pin unknown/malformed events to rejection without settling unrelated requests.

- [ ] **Step 2: RED verification**

Run: `bun test packages/coding-agent/test/launch/protocol.test.ts packages/coding-agent/test/launch/client-terminal-events.test.ts`
Expected on parent: terminal event decoding rejects an unknown event; the fenced input loses or rejects its new field. Record actual failure lines.

- [ ] **Step 3: implement typed wire and sinks**

Implement the spec's four terminal operations plus `terminal_ack` with `{ name, id, subscriptionId, sequence }`; define matching `DaemonRpcResult` variants. `terminal_start` returns a managed snapshot; attach returns its snapshot and accepted dimensions; resize/detach/ack identify the affected subscription. Advertise optional `terminalProtocolVersion:1` on ping results; absence means unsupported.

Define `DaemonTerminalNotification` as the union of `terminal_output`/`terminal_exit`. Add `DaemonBrokerClient.subscribeTerminal(subscriptionId, sink): () => void`. Register sinks before sending `terminal_start`/`terminal_attach`; remove them on client close without sending stop. Use explicit event narrowing:

```ts
if ("event" in message) {
  if (message.event === "daemon-completed") {
    void this.#deliverCompletion(message);
  } else {
    this.#terminalSinks.get(message.subscriptionId)?.(message);
  }
  return;
}
```

`#terminalSinks` is a new per-client map keyed by subscription id with the `DaemonTerminalNotification` callback type. Do not route unknown event shapes into completion processing.

- [ ] **Step 4: PASS verification**

Run the Step 2 command. Expected: PASS for old protocol tests and new terminal event cases; existing completion fixtures unchanged. Lead additionally runs the recorded RPC baseline selection.

- [ ] **Step 5: commit**

```bash
git add packages/coding-agent/src/launch/protocol.ts packages/coding-agent/src/launch/client.ts packages/coding-agent/test/launch/protocol.test.ts packages/coding-agent/test/launch/client-terminal-events.test.ts
git commit -m "feat(launch): define generation-fenced terminal stream protocol"
```

## 2. Stage 2 / Task 2: real broker output, input, resize and detach

**Owner:** builder
**Depends on:** Stage 1
**Files:**
- Modify: `packages/coding-agent/src/launch/broker.ts:95-120,511-640,690-900,965-971,1242-1269,1541-1555`
- Create: `packages/coding-agent/test/launch/terminal-fixture.ts`
- Create: `packages/coding-agent/test/launch/broker-terminal-stream.test.ts`
- Test: `packages/coding-agent/test/launch/broker-pty-startup-input.test.ts`

**Acceptance / anti-gameable verification:** a real child emits first paint before its start response, receives raw input, reports resized dimensions, survives subscription socket destruction and reattaches with the same snapshot id/PID. A mismatched input id writes no bytes. Another terminal cannot steal the stream. An unacknowledged stream overflow disconnects that view while a separate broker client still sees a live persistent child.
**Risk:** subscriber registration after spawn loses initial setup dialogs; backpressure must not block the PTY callback.

- [ ] **Step 1: write the fixture and failing integration tests**

`terminal-fixture.ts` exports `withTerminalBroker(body)` and `terminalSpec(projectDir,script)`. Copy the actual start/restore-env pattern from `broker-pty-startup-input.test.ts:13-30`, not a mocked broker. The fixture creates a `TempDir`, project/runtime subdirectories, a real `createDaemonBrokerClient`, starts `startDaemonBrokerFromEnvironment`, and in `finally` requests shutdown, closes the client, awaits broker completion, and disposes the temp directory. `body` receives `{client, projectDir}`. `terminalSpec` returns `DaemonSpec` with `application:process.execPath`, `args:["-e",script]`, `env:{}`, the project cwd, `pty:true`, `persist:true`, `detached:false`, `restart:"no"`, and a unique name. No real provider/API key is involved.

Core test (imports: Bun test assertions, `withTimeout`/`Snowflake`, and the fixture):

```ts
it("captures first bytes before start completes and fences input", async () => {
  await withTerminalBroker(async ({ client, projectDir }) => {
    const received: string[] = [];
    const echoed = Promise.withResolvers<void>();
    const subscriptionId = `view-${Snowflake.next()}`;
    const off = client.subscribeTerminal(subscriptionId, frame => {
      if (frame.event !== "terminal_output") return;
      received.push(frame.data);
      void client.request({ op: "terminal_ack", name: frame.name,
        id: frame.id, subscriptionId, sequence: frame.sequence });
      if (received.join("").includes("INPUT:q")) echoed.resolve();
    });
    try {
      const spec = terminalSpec(projectDir,
        'process.stdin.setRawMode(true);' +
        'process.stdout.write("FIRST\\x1b[31mλ\\x1b[0m\\r\\n");' +
        'process.stdin.on("data", b => process.stdout.write("INPUT:" + b));');
      const started = await client.request({ op: "terminal_start",
        subscriptionId, spec, columns: 93, rows: 31 });
      if (started.op !== "terminal_start") throw new Error("wrong result");
      await expect(client.request({ op: "send", name: spec.name,
        id: "not-this-generation", data: "BAD" })).rejects.toThrow();
      await client.request({ op: "send", name: spec.name,
        id: started.daemon.id, data: "q" });
      await withTimeout(echoed.promise, 5000, "missing real PTY echo");
      expect(received.join("")).toContain("FIRST\x1b[31mλ\x1b[0m");
      expect(received.join("")).not.toContain("INPUT:BAD");
    } finally { off(); }
  });
}, 15000);
```

Add real-process cases for stream-socket loss, resize (`process.stdout.columns/rows` on resize), generation replacement, Unicode/escape chunk splits, no acknowledgement overflow, live persistent record beyond idle grace, and exactly one responder. For the query case, child emits `CSI 6 n`; attached terminal simulator replies with a non-home coordinate, and child must receive it **once**, not both home and real replies. Detached child must receive fallback once.

- [ ] **Step 2: RED verification**

Run: `bun test packages/coding-agent/test/launch/broker-terminal-stream.test.ts`
Expected on Stage 1: broker rejects `terminal_start` as unsupported. Record the actual rejection rather than a timer expiry.

- [ ] **Step 3: implement subscription ownership inside existing broker**

Add per-record terminal subscription state and per-socket cleanup. Refactor the existing start path only enough to install the subscriber after record creation and before `#launch`; reuse the same record/readiness/persistence logic. Require `pty:true`, `persist:true`, `detached:false`, `restart:"no"` for session terminal start. Reject an already subscribed record on another attach. Bind identity checks before input/resize, not after.

Output callback structure:

```ts
const attached = this.#terminalSubscriptions.has(record.snapshot.id);
if (!attached) {
  const reply = responder.feed(chunk);
  if (reply) session.write(reply);
}
this.#publishTerminalOutput(record, generation, chunk);
this.#onOutput(record, generation, chunk);
```

`#terminalSubscriptions` and `#publishTerminalOutput` are introduced in this task: the map owns authenticated socket/subscription id, sequence, outstanding byte count and generation; publishing splits frames under the native line-frame ceiling and disconnects only an overflowing subscriber. `terminal_ack` retires acknowledged byte counts; reject acks beyond the sent sequence or belonging to another connection. Never await physical output drain inside the PTY callback. Preserve the Windows host-cursor handshake exception in the existing responder.

On subscription close, delete only that socket's subscription and resume fallback response mode. `terminal_detach` performs the same idempotent cleanup. `terminal_exit` is emitted by record settlement, not mirror close. Dimensions are supplied at initial spawn, updated with native PTY resize, and retained while detached. Add the optional expected id check at the start of `#send`. Expose `terminalProtocolVersion:1` only now that the broker implements it.

- [ ] **Step 4: PASS verification**

Run: `bun test packages/coding-agent/test/launch/broker-terminal-stream.test.ts packages/coding-agent/test/launch/broker-pty-startup-input.test.ts packages/coding-agent/test/launch/broker-idle-shutdown.test.ts`
Expected: PASS, real first-byte/echo/resize assertions, unchanged service startup-input behavior. Lead runs the recorded RPC baseline.

- [ ] **Step 5: commit**

```bash
git add packages/coding-agent/src/launch/broker.ts packages/coding-agent/test/launch/terminal-fixture.ts packages/coding-agent/test/launch/broker-terminal-stream.test.ts
git commit -m "feat(launch): stream supervised PTYs without binding child lifetime to views"
```

## 3. Stage 3 / Task 3: renderer refresh without session teardown

**Owner:** builder
**Depends on:** Stage 2 for its real query-routing probe; UI unit coverage can be authored independently.
**Files:**
- Modify: `packages/coding-agent/src/modes/interactive-mode.ts:6480-6515,7852-7876`
- Modify: `packages/coding-agent/src/modes/rpc/rpc-command-surface.ts:1988-2054`
- Test: `packages/coding-agent/test/rpc-interactive-socket.test.ts`
- Create: `packages/coding-agent/test/launch/terminal-refresh.test.ts`

**Acceptance / anti-gameable verification:** refreshing terminal I/O does not dispose the session, close its socket, clear draft/dialog state, emit shutdown or write `session_exit`. Web can still execute `get_state` during and after refresh. Real PTY probe shows modes/probes are restored with one responder.
**Risk:** `ui.stop()/start()` may leave cached differential/native state that a full repaint does not restore; falsify before CLI cutover.

- [x] **Step 1: add failing refresh tests**

In `rpc-interactive-socket.test.ts`, reuse its real `createInteractiveFixture`, `SocketPeer`, `frameOf`, and existing `fixture` cleanup. Add:

```ts
it("refreshes terminal I/O without ending its session or socket", async () => {
  fixture = await createInteractiveFixture([]);
  const peer = await SocketPeer.connect(fixture.endpoint);
  const dispose = spyOn(fixture.session, "dispose");
  const close = spyOn(fixture.socket, "close");
  const stop = spyOn(fixture.mode.ui, "stop").mockImplementation(() => {});
  const start = spyOn(fixture.mode.ui, "start").mockImplementation(() => {});
  const repaint = spyOn(fixture.mode.ui, "requestRender").mockImplementation(() => {});
  try {
    fixture.mode.refreshTerminalAttachment();
    peer.send({ type: "get_state", id: "still-alive" });
    expect((await frameOf(peer, "still-alive")).success).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(repaint).toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  } finally { peer.close(); }
});
```

Add a real-controller pending approval/draft test in `terminal-refresh.test.ts`: start a promise-backed UI selector with existing controller methods, refresh, assert it has not settled, then select via injected real input and assert its one original promise resolves. Do not test a replacement selector or a mocked pre-resolved approval. Exercise timeout/caller cancellation unchanged. The test uses the same mock-session constructor pattern as the interactive socket fixture, not a live model.

- [x] **Step 2: RED verification**

Run: `bun test packages/coding-agent/test/rpc-interactive-socket.test.ts packages/coding-agent/test/launch/terminal-refresh.test.ts`
Expected on parent: `refreshTerminalAttachment` is absent. Then run the real Stage 2 query fixture with renderer refresh; record any duplicate reply/stale screen before implementation changes.

- [x] **Step 3: implement narrow refresh and optional transport-control hook**

Add exactly one renderer-only method:

```ts
refreshTerminalAttachment(): void {
  this.ui.stop();
  this.ui.start();
  this.ui.requestRender(true, { clearScrollback: true });
}
```

If the real probe requires invalidating existing renderer/native cache, do so through the existing TUI invalidation API inside this method; do not replace the component tree or call `InteractiveMode.stop()`. Add an optional `terminalControl` to `serveInteractiveSessionSocket` carrying expected owner coordinates and `refresh:()=>void`; wrap its per-connection surface to intercept `{type:"terminal_refresh",id,sessionId,generation}` before command dispatch. Reply `{type:"terminal_refreshed",id,sessionId,generation}` only after accepted refresh; return an explicit error frame on identity mismatch or unavailable capability. Ordinary RPC surfaces and host-command capabilities are unchanged. This hook is wired to real broker metadata in Stage 4.

- [x] **Step 4: PASS verification**

Run the Step 2 command. Expected: PASS; existing host-only `set_ask_dialog` rejection stays unchanged. Lead verifies the pending gate through real PTY input and records screen evidence, not just spy counts, plus the recorded RPC baseline.

- [x] **Step 5: commit**

```bash
git add packages/coding-agent/src/modes/interactive-mode.ts packages/coding-agent/src/modes/rpc/rpc-command-surface.ts packages/coding-agent/test/rpc-interactive-socket.test.ts packages/coding-agent/test/launch/terminal-refresh.test.ts
git commit -m "feat(session): refresh attached terminal without disposing UI or mind"
```

## 4. Stage 4 / Task 4: persistent owner worker and discovery coordinates

**Owner:** builder
**Depends on:** Stages 2–3
**Files:**
- Create: `packages/coding-agent/src/launch/session-owner.ts`
- Modify: `packages/coding-agent/src/launch/broker.ts:819-827` (inject actual record coordinates before child spawn)
- Modify: `packages/coding-agent/src/cli/worker-selectors.ts`
- Modify: `packages/coding-agent/src/cli.ts:114-118` and its existing worker dispatch table
- Modify: `packages/coding-agent/src/modes/rpc/rpc-socket.ts:43-60,227-235,344-358`
- Modify: `packages/coding-agent/src/modes/interactive-mode.ts:7857-7861`
- Create: `packages/coding-agent/test/launch/session-owner.test.ts`
- Test: `packages/coding-agent/test/rpc-socket.test.ts`

**Acceptance / anti-gameable verification:** a hidden owner entrypoint reenters normal interactive startup exactly once, publishes its own PID and broker coordinates, and survives loss of the launching mirror connection. Publication rebind carries the same broker generation but a changed session id. An unrelated child `omp` cannot inherit owner role.
**Risk:** source CLI works but worker selector packaging/profile bootstrap or context inheritance breaks installed binaries. A new bespoke executable entrypoint is prohibited.

- [ ] **Step 1: add failing context tests**

Define the new `consumeSessionOwnerContext(env)` API in this task: input is a mutable environment record, output is `SessionOwnerContext | undefined`, where context contains `{projectDir,name,id}`. It validates the private `OMP_SESSION_OWNER_CONTEXT` JSON, deletes that variable after consumption, and is called once at worker entry before normal startup. No secret/token is present in this metadata.

```ts
it("consumes owner context so descendants cannot impersonate this owner", () => {
  const env = { OMP_SESSION_OWNER_CONTEXT: JSON.stringify({
    projectDir: "/fixture/project", name: "mind-a", id: "generation-a",
  }) };
  expect(consumeSessionOwnerContext(env)).toEqual({
    projectDir: "/fixture/project", name: "mind-a", id: "generation-a",
  });
  expect(env.OMP_SESSION_OWNER_CONTEXT).toBeUndefined();
  expect(consumeSessionOwnerContext(env)).toBeUndefined();
});
```

Add socket metadata/rebind tests using the existing real socket fixture: optional `terminal` coordinates appear only for an owner publication; ordinary RPC fixtures still serialize their previous metadata. Identity changes refresh session id without changing broker coordinates.

- [ ] **Step 2: RED verification**

Run: `bun test packages/coding-agent/test/launch/session-owner.test.ts packages/coding-agent/test/rpc-socket.test.ts`
Expected on parent: new context API missing and terminal metadata absent.

- [ ] **Step 3: implement owner context and reentry**

Add `SESSION_OWNER_WORKER_ARG` to the existing worker selector/dispatch convention. `runSessionOwner(originalArgv)` consumes startup context into module-local state and reenters the normal root CLI with an internal owner guard; this is the existing CLI executable, not a separate worker source executable. Preserve profile flags, startup cwd, original goal/message argv and signal semantics. The broker injects the actual record coordinates after creating its managed record and before spawn; the caller cannot select a different generation through a stale environment value.

Use the ordinary hidden-worker dispatch route, not `runIpcSubprocessWorker`: `cli.ts:412-417` installs parent-death monitoring for IPC subprocess workers. The owner is supervised by the independent broker and must not establish an IPC-disconnect/parent-death dependency on the physical terminal process.

Metadata shape:

```ts
interface SessionOwnerContext {
  projectDir: string;
  name: string;
  id: string;
}
// Optional member on RpcSessionSocketMetadata:
// terminal?: SessionOwnerContext & { protocolVersion: 1 };
```

`createAgentSessionSocket` reads the process-local context, not mutable descendant environment. Pass Stage 3's optional terminal control from `attachSessionSocket` only for this owner. Keep the endpoint alive for the owner lifecycle; a renderer refresh never calls its close method. Integrate with the separately landing detach change by reusing its socket/view split rather than duplicating it.

- [ ] **Step 4: PASS verification**

Run the Step 2 command. Expected: PASS; ordinary socket metadata and v1/v2 transport cases remain valid. Lead runs hidden-worker startup through source CLI and, at final branch verification, the existing packaged worker smoke route; record which distributions were actually exercised.

- [ ] **Step 5: commit**

```bash
git add packages/coding-agent/src/launch/session-owner.ts packages/coding-agent/src/launch/broker.ts packages/coding-agent/src/cli/worker-selectors.ts packages/coding-agent/src/cli.ts packages/coding-agent/src/modes/rpc/rpc-socket.ts packages/coding-agent/src/modes/interactive-mode.ts packages/coding-agent/test/launch/session-owner.test.ts packages/coding-agent/test/rpc-socket.test.ts
git commit -m "feat(session): host interactive sessions in persistent broker PTY workers"
```

## 5. Stage 5 / Task 5: read-only attach decision and explicit stale refusal

**Owner:** builder
**Depends on:** Stage 4 metadata
**Files:**
- Create: `packages/coding-agent/src/launch/session-attach.ts`
- Create: `packages/coding-agent/test/launch/session-attach.test.ts`
- Read/reuse: `packages/coding-agent/src/cli/session-arg.ts:7-26`
- Read/reuse: `packages/coding-agent/src/session/session-listing.ts`

**Acceptance / anti-gameable verification:** every decision table row in the spec is exercised; an unreachable endpoint cannot be represented as a cold-open decision. Read-only resolution never constructs a manager. Test actual stale local endpoint artifacts as well as pure decision logic.
**Risk:** treating connect failure as absence reproduces silent transcript divergence.

- [ ] **Step 1: add exhaustive decision tests**

This task defines `decideSessionAttach(probe)` and its input union:

```ts
type SessionAttachProbe =
  | { status: "live"; sessionId: string; terminal?: {
      protocolVersion: 1; projectDir: string; name: string; id: string;
    } }
  | { status: "unreachable"; sessionId: string; endpoint: string }
  | { status: "absent"; sessionId: string; leaseHeld: boolean | null };
```

Its output is `{kind:"attach", terminal}`, `{kind:"cold",sessionId}`, or `{kind:"refuse",code}`. Codes are `owner-unreachable`, `terminal-unavailable`, `owner-busy`, `ownership-unknown`. The probe builder `probeSessionAttach(fullId)` reads private discovery, connects, completes ready/get-state identity verification, and returns this union; it never deletes artifacts or opens a manager.

```ts
it.each([
  [{ status: "unreachable", sessionId: "s", endpoint: "/fixture/s.sock" },
   "owner-unreachable"],
  [{ status: "absent", sessionId: "s", leaseHeld: true }, "owner-busy"],
  [{ status: "absent", sessionId: "s", leaseHeld: null }, "ownership-unknown"],
  [{ status: "live", sessionId: "s" }, "terminal-unavailable"],
] as const)("refuses unsafe owner state %#", (probe, code) => {
  expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code });
});
it("allows cold ownership only with no publication and a free lease", () => {
  expect(decideSessionAttach({status:"absent",sessionId:"s",leaseHeld:false}))
    .toEqual({kind:"cold",sessionId:"s"});
});
```

Add real filesystem cases for stale sidecar without socket, stale socket without sidecar, mismatched session identity, matching reachable owner, and invalid/malformed metadata. None may call `SessionManager.open`; spy that export or inject a manager-construction trap in the root integration fixture.

- [ ] **Step 2: RED verification**

Run: `bun test packages/coding-agent/test/launch/session-attach.test.ts`
Expected on parent: new module absent. After adding the decision API but before probe implementation, actual stale-artifact cases must fail, not be skipped.

- [ ] **Step 3: implement probe and discriminated decision**

Use full ids resolved via existing listing/header readers; path/prefix arguments must be canonicalized read-only. `get_state` is an existing session RPC command; correlate its response and validate full identity. Bound connection/handshake waits with existing timeout helpers. Do not infer liveness from PID alone. Preserve observation errors as `unreachable` or unknown ownership; never turn a thrown probe into cold.

```ts
if (probe.status === "unreachable")
  return { kind: "refuse", code: "owner-unreachable" };
if (probe.status === "live")
  return probe.terminal
    ? { kind: "attach", terminal: probe.terminal }
    : { kind: "refuse", code: "terminal-unavailable" };
if (probe.leaseHeld === true) return { kind: "refuse", code: "owner-busy" };
if (probe.leaseHeld === null) return { kind: "refuse", code: "ownership-unknown" };
return { kind: "cold", sessionId: probe.sessionId };
```

- [ ] **Step 4: PASS verification**

Run the Step 2 command. Expected: PASS for every table row and real stale artifact, no manager construction and no artifact deletion. Lead runs recorded RPC baseline.

- [ ] **Step 5: commit**

```bash
git add packages/coding-agent/src/launch/session-attach.ts packages/coding-agent/test/launch/session-attach.test.ts
git commit -m "feat(session): resolve live attachment before opening a transcript"
```

## 6. Stage 6 / Task 6: strict reservation adoption and no-fork race fence

**Owner:** builder
**Depends on:** Stage 5
**Files:**
- Modify: `packages/coding-agent/src/session/session-storage.ts:537-543,640-656,1328-1359`
- Modify: `packages/coding-agent/src/session/session-manager.ts:1120-1144,1282-1319,1490-1499,1661,1793` and open options
- Modify: `packages/coding-agent/src/launch/session-owner.ts`
- Create: `packages/coding-agent/test/launch/session-owner-reservation.test.ts`
- Test: `packages/coding-agent/test/rpc-session-lease.test.ts`

**Acceptance / anti-gameable verification:** two OS processes contest the same cold resume; exactly one holds/adopts the lease and no sibling JSONL appears. Probe errors throw, not no-op ownership. Existing SDK default contention/fork tests stay unchanged. Reservation remains held after terminal detach and releases on true close/startup error.
**Risk:** separately acquiring a native lock then letting storage acquire it again can conflict with our own reservation; early release creates a TOCTOU window.

- [ ] **Step 1: add failing reservation and conflict tests**

Define `FileSessionStorage.reserveSession(sessionId,sessionPath)` in this task: returns an idempotent release handle backed by the existing holder map, or throws a typed busy/unavailable error; it propagates unexpected lock errors. `claimSession` in the same process increments the **same** holder count. Reservation owner releases its extra holder only after a manager has adopted a strict claim. Define opt-in manager ownership policy `"require-owner"` with default `"branch"` for existing API callers.

Core in-process assertion, with `sessionId`/`sessionPath` produced by the test's persisted real session fixture:

```ts
const storage = new FileSessionStorage();
const reservation = storage.reserveSession(sessionId, sessionPath);
try {
  const releaseManagerHolder = storage.claimSession(sessionId, sessionPath);
  expect(typeof releaseManagerHolder).toBe("function");
  reservation.release();
  expect(isSessionLeaseHeld(sessionId)).toBe(true);
  releaseManagerHolder!();
  expect(isSessionLeaseHeld(sessionId)).toBe(false);
} finally { reservation.release(); }
```

Also spawn separate Bun children which open the same persisted file with `require-owner`; coordinate their first acquisition using IPC/barrier bytes, not sleeps. The losing child exits with the typed conflict and **never appends**. Compare directory JSONL paths and original header id before/after. Exercise asynchronous append, synchronous append and atomic rewrite conflict paths; all must avoid `open-elsewhere` in strict mode.

- [ ] **Step 2: RED verification**

Run: `bun test packages/coding-agent/test/launch/session-owner-reservation.test.ts packages/coding-agent/test/rpc-session-lease.test.ts`
Expected on parent: reservation API absent; strict conflict cases currently branch or cannot enforce ownership. Record exact sibling/header evidence.

- [ ] **Step 3: implement shared-map reservation and strict policy**

Refactor acquire/holder bookkeeping within `session-storage.ts` so reservation and ordinary claim use one entry. Do not change legacy claim's permissive semantics for unrelated SDK callers. Strict acquire must never turn a lock exception into `()=>{}`. Before building the owner session, acquire reservation, recheck Stage 5 publication and abort/attach a reachable race winner rather than continue constructing the loser. On successful strict manager claim, release the bootstrap reservation holder.

Guard persistence at the existing branch boundary:

```ts
if (reason === "open-elsewhere" && this.#ownershipPolicy === "require-owner") {
  throw new SessionOwnershipConflictError(this.#sessionId, this.#sessionFile);
}
```

`#ownershipPolicy` is introduced through manager construction/open options in this task; `SessionOwnershipConflictError` is defined/exported here with full session id/file, no secrets. Strict owner startup claims before any extension/model/session writes, and identity transitions revalidate/reserve their selected target. Intentional fork/new commands still create their own identities rather than adopting an occupied source. Keep all default-policy callers and tests unchanged.

- [ ] **Step 4: PASS verification**

Run the Step 2 command. Expected: PASS, one real child wins; no new sibling files; retained lease survives mirror disconnection. Lead runs recorded RPC baseline including the existing lease cases.

- [ ] **Step 5: commit**

```bash
git add packages/coding-agent/src/session/session-storage.ts packages/coding-agent/src/session/session-manager.ts packages/coding-agent/src/launch/session-owner.ts packages/coding-agent/test/launch/session-owner-reservation.test.ts
git commit -m "fix(session): reserve cold resume ownership without silent transcript forks"
```

## 7. Stage 7 / Task 7: raw terminal mirror and process-isolation fixture

**Owner:** builder
**Depends on:** Stages 2–6
**Files:**
- Create: `packages/coding-agent/src/launch/terminal-mirror.ts`
- Create: `packages/coding-agent/test/launch/terminal-mirror.test.ts`
- Create: `packages/coding-agent/test/fixtures/session-terminal-owner.ts`
- Create: `packages/coding-agent/test/launch/session-terminal-lifetime.test.ts`

**Acceptance / anti-gameable verification:** SIGKILL the outer mirror process during a real delayed mock-model turn; same session PID completes via its open RPC socket, no exit diagnostic, writer lease remains held, and reattachment restores a draft/open gate. True quit subsequently produces the ordinary exit diagnostic and releases the lease.
**Risk:** accidentally sharing the pane process group, parent-death linkage or terminal fd makes the apparent detach split meaningless under actual pane death.

- [x] **Step 1: write real-process tests and fixture**

The new fixture builds a persisted `AgentSession` with `createMockModel`, `Agent`, `convertToLlm`, isolated settings and a real `RpcSessionSocket`, following `rpc-interactive-socket.test.ts:100-135`; unlike that fixture, use a real session directory, start the actual interactive renderer in a broker PTY and expose no production test hooks. It enters through the hidden owner worker from Stage 4. Test control uses a test-only extension/fixture command with a promise-backed gate and marker output, not a live model/provider. All processes and artifacts belong to `TempDir` and are cleaned in `finally`.

Define test fixture API in `session-terminal-lifetime.test.ts`: `startLifetimeFixture()` returns `{mirror,ownerPid,sessionId,sessionFile,web,resumeMirror,waitForCompletion,readExitEntries,listJsonl,close}`. `mirror` is a real spawned process running the mirror module; `web` is a real IPC RPC peer; `resumeMirror()` resolves current metadata and attaches the original owner; `readExitEntries()` parses persisted diagnostic entries using the existing journal format; `listJsonl()` enumerates that fixture's directory. `close()` requests true quit then tears down only fixture processes. Implement these functions in this task rather than stubbing them.

Core behavior test:

```ts
it("keeps the same mind and Web connection after the mirror is killed", async () => {
  const f = await startLifetimeFixture();
  try {
    const before = await f.listJsonl();
    f.web.send({ type: "prompt", id: "slow-turn", message: "delayed fixture turn" });
    await f.web.next(frame => frame.type === "agent_start");
    f.mirror.kill("SIGKILL");
    await f.mirror.exited;
    await f.waitForCompletion("slow-turn");
    f.web.send({ type: "get_state", id: "same-owner" });
    const state = await f.web.next(frame => frame.id === "same-owner");
    expect(state.success).toBe(true);
    expect(Process.fromPid(f.ownerPid)?.status()).toBe("running");
    expect(await f.readExitEntries()).toHaveLength(0);
    expect(await f.listJsonl()).toEqual(before);
    const attached = await f.resumeMirror();
    expect(await attached.waitForText("completed while detached")).toBe(true);
  } finally { await f.close(); }
}, 30000);
```

`waitForCompletion` correlates the real `prompt_result` and succeeds only on completion of the original delayed turn; fixture output contains the exact marker `completed while detached`. The reattached test mirror renders output into the repo virtual terminal or headless real-terminal harness so `waitForText` checks screen state, not a daemon log. `Process` is the existing native process API already used by the broker. Add a persisted gate/draft test and a true `/exit` disposal test.

- [x] **Step 2: RED verification**

Run: `bun test packages/coding-agent/test/launch/terminal-mirror.test.ts packages/coding-agent/test/launch/session-terminal-lifetime.test.ts`
Expected before mirror implementation: module/start path absent. Once raw forwarding exists, a version which forwards kernel hangup or tears down on close must fail the PID/Web/exit-entry assertions. Capture that failure if encountered; do not fake an OS signal with `mode.stop()`.

- [x] **Step 3: implement mirror, no second UI parser**

`runTerminalMirror` takes a broker client, subscribed terminal identity and real/injectable local input/output descriptors. It installs raw stdin, forwards unchanged strings via `{op:"send",name,id,data}`, writes `terminal_output.data` in sequence, and acknowledges after local stdout drain. On resize, send `terminal_resize`; on stream exit, return the owner's status. Install disconnect/signal handlers whose cleanup is idempotent:

```ts
const detach = async (): Promise<void> => {
  unsubscribeTerminal();
  restoreLocalTerminal();
  await client.request({ op: "terminal_detach", name, id, subscriptionId })
    .catch(() => undefined);
  client.close();
};
```

`unsubscribeTerminal`, `restoreLocalTerminal`, `name`, `id` and `subscriptionId` are owned by `runTerminalMirror` in this task; restoration removes only this mirror's listeners, restores raw mode and physical terminal modes, and never calls a session shutdown API. Physical keyboard Ctrl-C remains `data:"\u0003"`; process SIGTERM/SIGHUP means local detach. SIGKILL has no cleanup but broker socket loss performs equivalent unsubscribe. Use existing terminal cleanup conventions for local mode reset; do not instantiate a second `ProcessTerminal` that consumes the child's capability replies.

For reconnect, subscribe first, then call the transport-local `terminal_refresh` on the verified session endpoint. If refresh fails, detach only this mirror. Do not replay logs or startup prompts to fake a restored display.

- [x] **Step 4: PASS verification**

Run the Step 2 command. Expected: PASS including real SIGKILL, same PID, completed turn, surviving socket, original JSONL only, pending gate and real quit. Lead runs recorded RPC baseline once this stage lands.

- [x] **Step 5: commit**

```bash
git add packages/coding-agent/src/launch/terminal-mirror.ts packages/coding-agent/test/launch/terminal-mirror.test.ts packages/coding-agent/test/fixtures/session-terminal-owner.ts packages/coding-agent/test/launch/session-terminal-lifetime.test.ts
git commit -m "feat(session): mirror persistent PTYs across terminal process death"
```

**Acceptance evidence (builder, `e67b346ea2`):** `bun test test/launch/session-terminal-lifetime.test.ts` is 4 pass / 0 fail: SIGKILL mid-turn with the owner completing and a fresh mirror repainting the transcript, background work across a mirror death reaped only by `/exit`, a clean `terminal_detach` mid-turn as the abrupt-drop control, and a second mirror after a kill. The composer-status fix `d4546da91f` is a prerequisite unrelated to mirror death: `InteractiveMode.init()` → `syncComposerShape()` schedules the coalesced 1s status persist, and the payload serialized while the first turn is in flight carries `statusLine.model`, whose mock `calls[0].options` is `{...config}` and therefore contains that same model, so `JSON.stringify` throws; without the fix the uncaught throw exits the owner. Mirror kill and clean detach appear in neither the scheduling stack (`init:2577` → `syncComposerShape:4368` → `#scheduleComposerStatusPersist:4467`) nor the throw stack (`#persistComposerStatus` → `writeStatus` → `#putShared`), so terminal-subscription loss is not the trigger. `packages/tui/test/composer-cache.test.ts` pins a non-serializable write leaving the cache usable and the last good row intact. `test/launch/` is 152 pass / 0 fail and `test/rpc-*.test.ts test/session/rpc-*.test.ts` is 349 pass / 0 fail (counts include the generation's newer tests); `bunx tsgo -p packages/coding-agent/tsconfig.json --noEmit` is clean.

## 8. Stage 8 / Task 8: CLI cutover, branch-wide acceptance and operator docs

**Owner:** builder
**Depends on:** all previous stages; sequential integration owner for `main.ts`/CLI.
**Files:**
- Modify: `packages/coding-agent/src/main.ts:1261-1388,1827-1940,2112-2330,2818-2893`
- Modify: `packages/coding-agent/src/cli.ts:539-551`
- Modify: `packages/coding-agent/src/launch/session-owner.ts`
- Modify: `packages/coding-agent/src/launch/session-attach.ts`
- Create: `packages/coding-agent/test/launch/session-resume-cli.test.ts`
- Modify: `docs/rpc.md` (session socket discovery/lifetime section)
- Modify: `packages/coding-agent/CHANGELOG.md` (existing Unreleased section)

**Acceptance / anti-gameable verification:** actual `omp --resume <id>` after killing an actual terminal pane/mirror reconnects to the same process, original journal and ongoing Web RPC peer. Stale artifacts refuse explicitly and create no new manager/journal. Picker/continue/auto-resume share attach-before-open semantics. RPC baseline remains at least the supplied 343 passing cases, zero failures, none removed/skipped. Stage is not accepted on transport unit tests alone.
**Risk:** a less common startup path (picker, auto-resume, path/prefix target or extension-owned flags) bypasses the early decision and opens a second manager.

- [ ] **Step 1: add CLI-level failing cases**

Use the real Stage 7 process fixture to run the repository CLI with its existing source entrypoint. `session-resume-cli.test.ts` defines `runResumeCli(args,fixtureEnv)` using `Bun.spawn([process.execPath,"packages/coding-agent/src/cli.ts",...args],...)` under a native PTY with isolated profile/config and original fixture cwd. It captures actual exit status and rendered screen. Never run the outer CLI inside the owner's process.

```ts
it("refuses a stale endpoint without opening or forking the journal", async () => {
  const f = await startLifetimeFixture();
  try {
    const before = await f.listJsonl();
    await f.makeEndpointUnreachable();
    const result = await runResumeCli(["--resume", f.sessionId], f.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unreachable");
    expect(await f.listJsonl()).toEqual(before);
    expect(await f.readExitEntries()).toHaveLength(0);
  } finally { await f.close(); }
});
```

Extend the Stage 7 fixture with `env` and `makeEndpointUnreachable()` in this task: the latter creates a controlled stale publication scenario within the fixture's private endpoint directory while keeping owner process/socket evidence available to fixture cleanup; use a separate synthetic target when moving the live endpoint would conflate owner behavior with broker endpoint-loss shutdown. Test both stale-but-dead and alive-but-unreachable metadata. Include exact id, prefix, explicit session path, startup picker, continue and auto-resume targets. Creation-only flags/messages on live attach must be rejected rather than resubmitted or used to open a second session. Explicit fork, print, RPC and ACP retain their existing semantics.

- [ ] **Step 2: RED verification**

Run: `bun test packages/coding-agent/test/launch/session-resume-cli.test.ts`
Expected before cutover: CLI opens its normal interactive manager instead of terminal attachment, or fails to reconnect; stale case exposes the old open/branch path. Record journal path/id evidence and actual error text.

- [ ] **Step 3: cut over before manager construction and document behavior**

Route only native interactive root startup into owner/mirror; hidden owner recursion guard bypasses that route. Resolve resume/picker/continue/auto-resume read-only before their existing `SessionManager.open` callsites. Return from outer startup after live attach rather than continuing into session creation. Cold target starts a strict owner; fresh target uses atomic `terminal_start`. Preserve argv/profile/cwd and existing flag validation, rejecting invalid creation-only flags on live attach without mutating the owner. Remove obsolete bypass paths rather than retaining a fallback that can write.

Routing structure (the functions below are introduced in this stage and call earlier stage APIs):

```ts
if (isInteractive && !isSessionOwnerProcess()) {
  const target = await resolveInteractiveTargetReadOnly(parsedArgs, cwd);
  if (target.kind === "existing") {
    const decision = decideSessionAttach(await probeSessionAttach(target.sessionId));
    if (decision.kind === "refuse") throw attachResolutionError(target, decision);
    if (decision.kind === "attach") {
      await attachLiveTerminal(target, decision.terminal);
      return;
    }
  }
  await startOwnedInteractiveTerminal(parsedArgs, rawArgs, target);
  return;
}
```

Define `resolveInteractiveTargetReadOnly` by extracting the current listing/picker/continuation resolution without manager creation; it returns existing full id/path or fresh. `isSessionOwnerProcess` reads Stage 4's process-local context; `attachLiveTerminal` validates live-attach flags then uses Stage 7; `startOwnedInteractiveTerminal` constructs the Stage 4 hidden-worker spec and invokes Stage 2 atomic start plus Stage 7 mirroring. `attachResolutionError` maps the Stage 5 codes to existing clean `SessionResolutionError`, naming full id and endpoint. No catch here may call the old manager path. Disable outer speculative prepaint at `cli.ts:539-551` while retaining owner-child startup input buffering.

Update docs with: owner/mirror distinction; same-process Web/TUI; detach versus real quit; `--resume` attach decision; stale/unreachable refusal; broker-crash boundary; one writable terminal; and Web approvals **not** supported on the interactive socket. Explain that pending gates survive and require TUI reattachment, retaining existing timeout/cancellation. Add the changelog feature entry following existing style. Do not claim publication/live operator acceptance from tests.

- [ ] **Step 4: PASS and final independent acceptance**

Run targeted CLI/lifetime tests:

`bun test packages/coding-agent/test/launch/session-resume-cli.test.ts packages/coding-agent/test/launch/session-terminal-lifetime.test.ts`

Expected: PASS for live attach, stale refusal, all native target resolution paths, no duplicate journal or exit entry, true quit unchanged.

Then lead/verifier runs the recorded RPC baseline and all launch tests:

`bun test packages/coding-agent/test/launch`

Expected: zero failures; record exact test counts and whether the original 343-case selection was used. Run the repo's existing typecheck/build/packaged smoke checks only under the lead's verification assignment, with actual commands and results recorded in the bead. Do not invent evidence for installed binaries not exercised.

Final operator-facing proof: in a real Herdr pane with a fixture session and simultaneous RPC peer, start a delayed turn, record PID/id/file, kill the pane process, observe completion through RPC, launch `omp --resume <id>` in a new pane, and answer a gate that was pending before detach. Record PID/id equality, JSONL path equality, zero detach exit diagnostics, one real-quit exit diagnostic and screen evidence. This final proof is not a requirement to change Herdr or actor-bridge source.

- [ ] **Step 5: commit**

```bash
git add packages/coding-agent/src/main.ts packages/coding-agent/src/cli.ts packages/coding-agent/src/launch/session-owner.ts packages/coding-agent/src/launch/session-attach.ts packages/coding-agent/test/launch/session-resume-cli.test.ts packages/coding-agent/test/fixtures/session-terminal-owner.ts docs/rpc.md packages/coding-agent/CHANGELOG.md
git commit -m "feat(cli): attach resume to the live session owner without transcript divergence"
```

## Coverage / handoff

| Spec requirement | Stages |
| --- | --- |
| Broker rather than new daemon substrate, one capability | 2, 4, 8 |
| First-byte output, input, resize, generation binding, flow control | 1, 2, 7 |
| Singular query responder and full reattach display | 2, 3, 7 |
| Fresh owner and preserved startup argv/profile | 4, 8 |
| Probe before open, stale refusal, strict cold race ownership | 5, 6, 8 |
| Detach calls none of `#doDispose`, socket survives | 3, 7, 8 |
| Same-process Web and TUI, true quit unchanged | 7, 8 |
| No conversion of ~200 InteractiveMode callsites | 3, 4, 8; retain in-process controllers |
| UI requests wait for TUI; no invented Web approval | 3, 7, 8 docs |
| RPC 343/0 preservation and green stage boundaries | lead verification after every stage |

Handoff to lead: spawn one builder packet per task; integrate in dependency order and use independent verifier evidence. Do not implement inline. This document contains proposed commands/tests, not executed verification.

**Single riskiest assumption:** renderer-only `ui.stop()/ui.start()` plus full repaint correctly reestablishes keyboard/native terminal modes and redraws the original pending dialog/draft through a fresh physical mirror, without settling its promise or needing any of the ~200 UI callsites remoted.

**Cheapest falsifying probe:** before Stage 8, run the Stage 2 real PTY subscriber against the Stage 3 live interactive fixture with a typed draft and open approval. Destroy the mirror socket, subscribe a fresh raw terminal, issue `terminal_refresh`, then type a non-ASCII character, a bracketed paste and the approval key. Fail the assumption if the original pending promise resolves on detach, screen/draft differs, the child sees duplicate cursor replies, or input is decoded incorrectly. Keep a Web `get_state` peer open throughout and assert no exit journal entry. This is a bounded implementation acceptance probe for a builder/verifier, not production code or an experiment performed by the planner.
