# Changelog

## [Unreleased]

### Fixed

- Fixed `lsp status` matching live clients against unresolved catalog `definitions` instead of the PATH-resolved `servers` overlay, so a started server is reported as ready instead of configured-not-started.
- Fixed language-server diagnostics published on a file's real path missing the document opened through an in-workspace symlink, so `waitForDiagnostics` still matches that physical file instead of timing out as clean.
- Fixed `rename_file` skipping `workspace/didRenameFiles` for parent or sibling language servers when overlay reconciliation fails after a nested directory move, so those remaining servers still receive the rename before the error is surfaced.
- Fixed shutdown restoring a session that was disposed while a shared language-server process was still tearing down, so a force-kill survivor is no longer kept alive by that unreachable owner.
- Fixed releasing the last nested owner that configured `idleTimeoutMs` leaving the language-server idle checker running on a shared process with no remaining timeout, so SDK and embedded sessions can still exit after that owner is disposed.
- Fixed overlapping sessions keeping a released nested owner's spawn-root idle timeout on a shared language-server process, so a later idle sweep uses remaining owners' session timeouts instead of shutting down a sibling that never configured one.
- Fixed `lsp status` restoring per-owner command and `fileTypes` routing when shutdown cannot confirm a shared client exited, so a force-kill survivor is still reported as started under each remaining owner's catalog.
- Fixed `lsp` workspace symbol search ignoring already-started nested language servers when the session cwd has no root marker, so `symbols` with `file=*` still queries those clients instead of reporting no server.
- Fixed `lsp status` reporting a reused language server as not started after `reload *` changed only the command spelling to the same resolved binary, so status matches the catalog identity instead of listing the live process twice.
- Fixed overlapping sessions that share one extra-root language server overwriting each other's `fileTypes` on the live client, so `lsp status` still matches the catalog that acquired that process.
- Fixed `/move` keeping a nested extra-root language server when the new cwd catalog only changed `rootMarkers`, so the next file operation starts the marker-selected replacement instead of leaking the old process.
- Fixed `/move` applying every remaining workspace's idle timeout to retained extra-root clients, so a shorter timeout cached on an additional root cannot reap a still-active session's servers.
- Fixed `/move` restarting a retained extra-root language server whose catalog entry still used a bare command, so a lazily discovered nested process is kept when that command resolves to the same binary.
- Fixed `/move` failing after the cwd change already committed when a stale extra-root language server refused to exit, so the command still reports success and refreshes from the new directory.
- Fixed `/move` keeping a language server started from the previous cwd catalog after an additional workspace is promoted to the session cwd, so the new cwd's command, args, or settings replace that identity.
- Fixed eager language-server warmup ignoring `idleTimeoutMs` because startup loaded config without caching it, so a warmed unused process still shuts down after the configured timeout.

- Fixed `/move` shutting down a still-covered language server after a rolled-back cwd change or equivalent workspace-alias move, so only extra-root identities absent from the new session catalog are retired.
- Fixed `lsp reload *` crashing or re-reading language-server config for idle-timeout peeks, so a newly written `.omp/lsp.json` is observed once and missing cached config is treated as no timeout.
- Fixed `lsp status` reporting a reused language server as not started after `reload *` changed only `fileTypes`, so the live client keeps the catalog's routing metadata instead of appearing twice.
- Fixed `/move` keeping a previous session cwd in extra-root idle-timeout origins, so a nested client covered by a retained additional workspace uses the settled session timeout instead of the old cwd's shorter timeout.
- Fixed `/move` leaving extra-root language servers running under the previous session's command, args, or settings when the new cwd's catalog differs, so the next operation under that extra root starts the current identity instead of leaking the old process.
- Fixed code actions skipping `workspace/executeCommand` when overlay reconciliation fails after the filesystem edit already committed, so the originating server still runs its follow-up command.
- Fixed language-server idle timeout lookup pinning the session catalog on first nested spawn, so a later `rename_file` still sees the current server config instead of an empty cached snapshot.
- Fixed nested language-server clients ignoring a session-cwd idle timeout, so a nested process still shuts down after inactivity when only the session config sets `idleTimeoutMs`.
- Fixed nested language-server idle timeouts leaking from unsuccessful probes or failed starts, and dropping after a shutdown that the process survived, so a later session is not reaped with another workspace's timeout and a surviving nested process still inherits the session idle timeout.
- Fixed server-initiated workspace edits reporting `applied: false` after the filesystem mutation already committed when overlay reconciliation later failed, so the requesting language server is not told to retry an already-applied edit.
- Fixed workspace edits that unpublish an overwrite-destination language server skipping watched-file notifications to that still-live client, so a follow-up command still sees files it did not have open.
- Fixed edit language-server writethrough using construction-time cwd and omitting extra-root directories and session ownership, so `/move`, `!cd`, and `--add-dir` still bound nested format and diagnostics.
- Fixed native edit move and delete notifying language servers from session cwd only, so an extra-root nested client still receives watched-file events.
- Fixed workspace edits that overwrite a still-initializing destination leaving that client key permanently tombstoned, so a replacement language server can start for the new project.
- Fixed interactive `!cd` skipping deferred language-server owner cleanup, so a later command still runs in the new directory and uncovered roots are released after the cwd change commits.
- Fixed workspace edits that overwrite the originating language server's project root skipping overlay refresh on that unpublished client, so a follow-up command still sees the committed documents.
- Fixed workspace edits aborting while waiting for a still-initializing overwrite destination skipping retirement of the successfully moved source root.
- Fixed `rename_file` reporting an unreadable source as a crash or missing path when `stat` failed after `lstat` succeeded.
- Fixed workspace edits that overwrite a still-initializing nested project root leaving that pending language-server process attachable through overlay reconciliation.
- Fixed workspace edits that overwrite a destination directory symlink shutting down another session's language server at the unchanged physical target.
- Fixed deferred overwrite-destination shutdown dropping language-server owners before process exit was confirmed, so a surviving process could not be republished as ownerless or untracked.

- Fixed code actions that overwrite the originating language server's project root shutting that process down before a follow-up command, so the command still runs against the live client.
- Fixed workspace-edit retirement shutting down a replacement language server started at an overwritten destination after overlay reconciliation.
- Fixed `rename_file` of a directory symlink dropping a remaining physical owner route for the same session, so that session still keeps the unchanged nested language-server process.
- Fixed `lsp status` matching started clients by command only, so two configured servers that share a binary no longer report each other's processes or hide a nested identity.
- Fixed `/move`, `/wt`, and interactive `!cd` leaving language-server owner routes on a previous workspace symlink after moving to an equivalent alias, so `lsp status` and later reload still match the retained client from the current workspace.
- Fixed `rename_file` skipping `workspace/didRenameFiles` for a nested client kept alive by another session when overlay reconciliation fails after the directory move.
- Fixed overlapping sessions sharing one language-server config object inheriting each other's reload generation stamps, so a later session's first `lsp reload *` no longer treated a pre-reload nested config as current.
- Fixed `rename_file` skipping language-server retirement when overlay reconciliation fails after a nested project directory has already moved.
- Fixed workspace edits that overwrite an existing nested project directory leaving that destination's language server published through overlay reconciliation, so another session can no longer reuse the displaced-root process.
- Fixed workspace edits that successfully move or delete a nested project root skipping language-server retirement when overlay reconciliation later fails.
- Fixed workspace edits that rename an ordinary nested directory through a symlink parent leaving another session's language server published at the vanished physical path.
- Fixed workspace edits that rename a directory symlink leaving a still-initializing alias-only language-server client published ownerless at the unchanged physical target.
- Fixed code-action, rename, and server-initiated workspace edits leaving a nested language-server process initialized at a directory that was itself moved or recursively deleted, so a later operation under the destination no longer kept the vanished-root server running.
- Fixed code actions that both move a nested project root and run a follow-up command shutting the language server down before that command, so the command still runs against the live client.
- Fixed workspace edits that rename or delete a directory symlink shutting down another session's language server at the unchanged physical target.
- Fixed server-initiated workspace edits that remove their own nested root waiting for a shutdown reply the message reader could not consume, so graceful teardown no longer times out and force-kills the process.
- Fixed `shutdownAll()` resetting owner reload generations while captured language-server configs kept their pre-shutdown stamps, so a later `lsp reload *` no longer started obsolete command, args, or settings.
- Fixed `/remove-dir` dropping the last owner route for a language-server client acquired only through an extra-root symlink of a remaining workspace, so `lsp status` and later reload still report that retained client from the canonical cwd.
- Fixed `lsp status` interpolating unsanitized nested server labels, so a fallback command path no longer leaks the home directory or breaks TUI rendering.
- Fixed `lsp status` omitting a still-owned nested language server after an extra-root symlink of a remaining workspace was removed, so the retained alias is reported instead of the first-inserted extra-root route.
- Fixed `rename_file` omitting the pre-move identity of a workspace-symlink project root from owner-scoped failure cleanup, so a nested initialization failure recorded at the canonical target is cleared when that alias moves.
- Fixed `rename_file` capturing surviving nested language-server clients by server name only, so a renamed directory with multiple same-name nested projects still notifies each overlapping session's process.
- Fixed `rename_file` applying `willRenameFiles` edits once per symlink URI spelling of the same physical file, so a length-changing first edit no longer corrupts the second application.
- Fixed `rename_file` skipping `workspace/didRenameFiles` for a nested language-server client kept alive by another session when the renamed project root is a workspace symlink, so the surviving process is still notified after the alias moves.
- Fixed a cancelled overlapping `lsp reload *` restoring a shared client owner after a later reload had already snapshotted relevance, so that later reload no longer finishes attached to the superseded process and its replacement.
- Fixed cancelled `lsp reload *` leaving a rejected workspace reload barrier, so a later unused nested language server under the same workspace no longer fails with the cancellation error.
- Fixed cancelled `lsp reload *` restoring only unowned pending identities, so a session that shared a live client with another session could not reattach after abort.
- Fixed a cancelled overlapping `lsp reload *` writing the earlier generation back over a later in-flight reload, so captured nested configs could start superseded command, args, or settings.
- Fixed file/glob diagnostics and raw `lsp request` stamping nested language-server configs after overlapping `lsp reload *` finished, so those operations no longer start superseded command, args, or settings.
- Fixed `/move`, `/wt`, and interactive `!cd` releasing language-server ownership before the cwd transition committed, so a failed move that rolled the session back no longer dropped source clients from status.
- Fixed `lsp status` omitting a still-owned nested language server after an equivalent extra-root alias was removed, so the remaining workspace route is reported instead of the stale first alias.
- Fixed `shutdownAll()` dropping live session owners before a language-server process that survived force-kill was republished, so owner-filtered status no longer went blank and an overlapping session could not tear that still-running client down.
- Fixed `lsp reload *` reattaching a reloading session to a superseded overlapping language-server client after the reload barrier had already been removed, so a late old-config request no longer shares that process and the replacement.
- Fixed `lsp reload *` starting a nested language server from a config captured before reload when that identity had not been started yet, so a sequential `rename_file` server list no longer keeps obsolete command, args, or settings.
- Fixed `shutdownAll()` leaving routed workspace aliases on live session owners, so a later restart through a different alias no longer reports or filters on a workspace that no longer exists.
- Fixed `lsp reload *` reattaching a reloading session to a superseded nested language-server client after the reload barrier, so a concurrent old-config request no longer shares an overlapping session's process and the replacement.
- Fixed overlapping sessions that share one nested language-server client through different workspace aliases omitting that client from status, reload, and workspace-removal checks.
- Fixed `rename_file` skipping `workspace/didRenameFiles` for a nested client still owned by another session after owner-scoped moved-root release, so the surviving process is notified of the vanished root.
- Fixed nested workspace routing attaching a file to the session cwd when an additional root is a nested symlink to a shorter disjoint path, so that extra workspace no longer inherits the cwd's language-server executable.
- Fixed `rename_file` rebuilding extra-workspace `willRenameFiles` edit URIs against the session cwd, so an unopened file under an additional-root directory symlink still notifies that workspace's language server.
- Fixed `lsp status` omitting a nested language server whose project root is a workspace symlink after the client canonicalized to the target path.
- Fixed workspace-edit overlay refresh updating only the first equivalent symlink alias on one language-server client, so a later request on the other alias no longer used stale content.
- Fixed a session that joined an in-flight language-server initialization through a format-on-write probe remaining invisible to `lsp reload *`, so that session could keep the superseded client beside its replacement.
- Fixed idle language-server shutdown dropping live session owners when the process survived force-kill, so owner-filtered status went blank and an overlapping session could tear the still-running client down.
- Fixed a shared language-server initialization that exited before initialize recorded only the creating session, so a waiting session's later `lsp reload *` still hit the three-minute negative cache.
- Fixed `rename_file` leaving a nested language-server process initialized at a directory that was itself moved, so a later operation under the destination no longer kept the vanished-root server running.
- Fixed workspace-edit overlay refresh and watched-file notifications using one language server's document URI for every client when a file sits on both sides of an in-workspace directory symlink.
- Fixed language-server reload and removed-root cleanup missing a nested client whose project root is a workspace symlink, so that process no longer survives beside its replacement.
- Fixed diagnostics and format-on-write querying every language server with the first server's document URI when a file sits on both sides of an in-workspace directory symlink.
- Fixed idle language-server shutdown dropping ownership of a replacement client published under the same identity before the old process exited.
- Fixed `lsp reload *` reattaching a reloading session to a cached language-server client kept alive by an overlapping session, so that owner no longer uses both the old and replacement configurations.
- Fixed language-server routing following an in-workspace directory symlink out of the project, so hover and diagnostics on files under that alias stay on the containing server.
- Fixed `lsp reload *` keeping a leftover teardown barrier for every language server at a shared project root when only one identity failed to exit, so a successfully stopped server in that project could start again.
- Fixed `rename_file` and watched-file notifications following a leaf symlink out of a nested project, so the alias's language server still receives will/didRenameFiles and filesystem change events.
- Fixed write and edit language-server routing after `/move`, `/wt`, or interactive `!cd`, so format-on-write and diagnostics use the new cwd instead of the construction-time workspace.
- Fixed `rename_file` sending every nested language server the full directory rename pair list, so a sibling project no longer rejects or duplicates another project's file operations.
- Fixed `lsp reload *` leaving a nested pending start permanently tombstoned when another server survived mixed teardown, so later operations for that project no longer fail as “configuration was superseded.”
- Fixed `lsp reload *` keeping a workspace-wide reload barrier after mixed teardown when only one nested server survived, so sibling projects could still start.
- Fixed language-server routing following a leaf symlink out of the workspace, so hover and diagnostics on an in-workspace alias stay on that project's server.
- Fixed `lsp reload *` restoring ownership of nested servers that already exited during a mixed teardown, so a later reload could not rediscover that project.
- Fixed language-server document URIs following a leaf symlink out of the workspace, so hover and diagnostics stay on the alias's project instead of the target's.
- Fixed `/move`, `/wt`, and interactive `!cd` leaving language-server ownership on the previous cwd, so a later session in that directory could not replace a superseded server.
- Fixed `rename_file` using lexical overlay URIs when the workspace itself is a symlink, so an already-open canonical document was not closed and recreating the old path skipped `didOpen`.
- Fixed `rename_file` telling language servers that a symlink target moved when only the alias was renamed, so import rewrites no longer miss the moved path.
- Fixed `lsp reload *` skipping a nested initialization failure seen only through the three-minute fast-fail cache, so a later session still hit that cache after an explicit reload.
- Fixed language-server ownership surviving process exit and idle shutdown, so another session that later started the same identity could not replace it.
- Fixed `/remove-dir` restoring language-server ownership after a failed extra-root teardown, so a later replacement client stayed owned by the session that no longer had that workspace.
- Fixed `lsp reload *` skipping a nested initialization failure when another session joined the same pending start, so the waiting session still hit the three-minute negative cache.
- Fixed `/remove-dir` skipping the prompt refresh and confirmation when language-server teardown for the removed root failed, so the session stayed mutated while the active prompt still listed that workspace.
- Fixed `/remove-dir` installing a language-server reload barrier over the retained session cwd, so a stuck extra-root teardown could block or supersede new clients under the remaining workspace.
- Fixed write and edit language-server fallback owners remaining after a public ToolSession disposed, so an overlapping session could not replace those clients.
- Fixed a failed language-server initialization leaving the session as a phantom owner, so a later successful session could not reload or replace that identity.
- Fixed `rename_file` leaving sibling nested language servers with stale overlays when `workspace/willRenameFiles` also edited files outside the renamed project.
- Fixed `lsp reload *` starting a nested language server from a config captured before the reload barrier, so a changed command, args, or settings could survive teardown.
- Fixed format-on-write probes recording a session as a language-server owner when no client existed, so an overlapping session could not replace that later-started identity.
- Fixed `lsp reload *` letting a nested language server start from old config after the reload snapshot, so that process could survive teardown.
- Fixed write and edit language-server clients started without a session owner being treated as unowned, so a reload from an overlapping session could shut them down.
- Fixed `/remove-dir` shutting down a nested language-server client still covered by a remaining workspace root when the removed additional directory was more specific than that root.
- Fixed nested language servers spawning twice when a project-local executable was reached through a symlink workspace and its canonical path.
- Fixed language-server document URIs using a symlink spelling after the client initialized at the canonical project root, so later canonical-path operations no longer sent a second didOpen.
- Fixed `/remove-dir` shutting down language-server clients still covered by the session cwd or remaining additional roots when the removed directory overlapped those roots.
- Fixed nested language servers sending `workspace/applyEdit` for a sibling or session-root file leaving those clients with stale overlays after the filesystem edit.
- Fixed `/remove-dir` skipping language-server cleanup when write or edit could still start clients because the model-facing `lsp` tool was not registered.
- Fixed `lsp reload *` caching a nested initialization failure when teardown superseded an in-flight client, so the next file operation retried instead of failing from the three-minute negative cache.
- Fixed code-action and rename workspace edits under `--add-dir` leaving additional-root language servers with stale overlays after the files changed on disk.
- Fixed `/remove-dir` leaving language-server processes from the removed workspace running for the rest of the session, so a later `reload *` could not release them and another session could not replace them.
- Fixed `lsp reload *` leaving a cancelled nested client permanently tombstoned, so later requests for that identity failed with “configuration was superseded”.
- Fixed `rename_file` sending duplicate will/didRenameFiles requests when the same nested root was addressed through a symlink and its canonical path.
- Fixed nested language-server clients being spawned twice when the same project was addressed through a symlink and its canonical path.
- Fixed nested workspace routing attaching a file to the outer language server when a long symlink cwd outranked a shorter nested additional workspace.
- Fixed creating a file under a workspace opened through a symlink skipping nested language-server formatting and diagnostics because the new path could not be realpath'd yet.
- Fixed nested-root rename and code-action apply leaving sibling and root language servers with stale overlays when the workspace edit also changed files outside the nested project.
- Fixed public `LspTool` construction allocating a new unreleasable owner on every call, so a later `reload *` could not stop clients started by an earlier tool on the same session.
- Fixed `lsp reload *` leaving a nested initialization failure cached when the workspace was opened through a symlink but the file path used the canonical target.
- Fixed nested language-server routing skipping files when a workspace is opened through a symlink but the file path uses the canonical target.
- Fixed edit and write language-server clients started from a lazy session owner being treated as unowned and torn down by overlapping sessions.
- Fixed writes after `/add-dir` skipping nested language-server formatting and diagnostics because the write tool kept construction-time workspace roots.
- Fixed the public LSP factory ignoring `enableLsp=false`, so SDK advisor sessions that disable LSP no longer receive the tool.
- Fixed language servers in nested projects (for example `python/pyproject.toml` under a monorepo root) staying inactive until omp was started inside that subdirectory; concrete file operations now discover the nearest matching root lazily without recursively scanning the workspace at startup ([#1648](https://github.com/can1357/oh-my-pi/issues/1648)).
### Changed
## [18.2.11] - 2026-09-23

### Fixed

- Fixed nested `eval` Todo updates not being reflected by the Todo tracker, including cases where a cell fails after committing an update.
- Fixed strict-mode structured-output validation for JSON Schemas without a root `type`, preserving their `items` and `required` keywords.
- Improved streamed TTSR whole-buffer matching to avoid repeated scans from the beginning of the buffer.
- Fixed plural browser queries when compiled binaries provide shallow stack traces.
- Fixed browser `tab.fill` timing out on pages whose animation frames stall.
- Fixed the first LSP diagnostics request returning no results while a newly started language server is still analyzing.
- `/shake thinking` now reports the number of tokens freed.

## [18.2.10] - 2026-09-22
## [18.13.3] - 2026-10-28

### Added

- Manual compactions (RPC `compact`, `/compact`, extension `ctx.compact()`) emit `manual_compaction_start` and `manual_compaction_end` session events, so RPC hosts can show compaction progress; `docs/rpc.md` documents these with the other progress events (`retry_fallback_applied`, `ttsr_triggered`, `goal_updated`) ([#17247](https://github.com/can1357/oh-my-pi/pull/17247) by [@Quelaan1](https://github.com/Quelaan1))
- Added `retry.rateLimitWalksChain` (default `false`): with it on, a 429 rate limit after a turn with signed Claude thinking moves to the next model in `retry.fallbackChains` at once instead of retrying the throttled model until `retry.maxRetries` is spent ([#17232](https://github.com/can1357/oh-my-pi/pull/17232) by [@sjawhar](https://github.com/sjawhar))
- Sessions can be renamed from the resume picker: the new title persists as a user title without loading the session, and renames of live sessions are refused instead of forking the transcript ([#17262](https://github.com/can1357/oh-my-pi/pull/17262) by [@Twilight0](https://github.com/Twilight0))
- Added `display.advisorCollapsedLines` (Settings → Appearance → Display) to cap how many note lines a collapsed advisor card shows; the default keeps the full preview ([#17228](https://github.com/can1357/oh-my-pi/pull/17228) by [@bluecapone](https://github.com/bluecapone))
- `omp config list --scope global|project` lists only the keys that layer sets, with the values as written: path-scoped `enabledModels`, `enabledProviders` and `disabledProviders` entries (`{ path, … }`) stay unresolved, so a host can edit the global value without dropping them ([#17246](https://github.com/can1357/oh-my-pi/pull/17246) by [@Quelaan1](https://github.com/Quelaan1))
- `tools.xdevNotices: false` hides the `xd://: mounted …` notices shown as MCP servers connect, without turning on `startup.quiet` ([#17263](https://github.com/can1357/oh-my-pi/pull/17263) by [@MaisonnatM](https://github.com/MaisonnatM))

### Changed

- Updated Bun engine requirement to ≥1.4.4

### Fixed

- A running job's glance keeps the whole a meter counts instead of the bare numerator: a widget whose headline restated `140` beside a `140/190` bar now draws `140/190` in the job card, the HUD pill and the status line ([#17226](https://github.com/can1357/oh-my-pi/pull/17226) by [@iacore](https://github.com/iacore))
- Fixed the managed-skills root guard rejecting a symlinked store outright; a root that resolves to a directory now accepts writes inside its target, while a broken link or a link to a non-directory is still refused ([#17201](https://github.com/can1357/oh-my-pi/pull/17201) by [@iacore](https://github.com/iacore))
- Fixed experimental context rollover repeatedly running during tool calls when the fixed prompt and tool schemas already exceed the recovery band ([#17205](https://github.com/can1357/oh-my-pi/issues/17205))
- Fixed Ctrl+D during deferred extension startup falsely reporting an extension exit error and exiting 1 instead of closing cleanly ([#17259](https://github.com/can1357/oh-my-pi/issues/17259)).
- Resuming a session, or reviving a parked or restored subagent, after a prewalk or plan-yolo handoff continues on the model and effort the handoff switched to instead of falling back to the planning model ([#17229](https://github.com/can1357/oh-my-pi/pull/17229) by [@shgew](https://github.com/shgew))
- Fixed one interrupt silently stopping a session from ever waking on its own background job results again: an interrupt (Esc, the RPC `abort` command, an ACP cancel, a collab guest stop, an extension's `ctx.abort()`) that stops no run and no queued work no longer suppresses those wakes, and after an interrupt that did stop a run they come back once a later turn has run and ended. Esc on the "waiting on background jobs" row still ends that wait: its results land in context for your next prompt, as before ([#17243](https://github.com/can1357/oh-my-pi/pull/17243) by [@sjawhar](https://github.com/sjawhar))
- Fixed `!` commands on zsh/fish waiting forever at interactive prompts (e.g. the Oh My Zsh update question on `!code .`); keystrokes now go to the running command while it runs, and Esc still cancels ([#17210](https://github.com/can1357/oh-my-pi/issues/17210))
- Fixed auto-compaction firing early on OpenAI-compatible chat-completions models that don't replay past reasoning ([#15797](https://github.com/can1357/oh-my-pi/issues/15797), [#17231](https://github.com/can1357/oh-my-pi/pull/17231) by [@ghisguth](https://github.com/ghisguth))
- Eval's `tool.<name>(…)` now accepts `xd://<name>` and the Claude Code `mcp__<server>__<tool>` spelling like direct tool calls, and reports registered but unavailable tools instead of "Unknown tool" ([#17250](https://github.com/can1357/oh-my-pi/issues/17250))
- Updated the `ask` prompt to encourage assistants to show missing decision context before the dialog opens ([#17242](https://github.com/can1357/oh-my-pi/pull/17242) by [@jasonharrison](https://github.com/jasonharrison))
- Custom LiteLLM providers now refresh cached model rosters after paginated `/v2/model/info` discovery was fixed; cached first-page-only lists no longer hide later-page models ([#17237](https://github.com/can1357/oh-my-pi/pull/17237) by [@maykonmichel](https://github.com/maykonmichel)).
- Fixed hosted search repeating the same request when the active model is also its search target but uses a cloned or refitted model object ([#17202](https://github.com/can1357/oh-my-pi/pull/17202) by [@mateo-bolanos](https://github.com/mateo-bolanos)).
- Fixed a killed or failed inline browser tab worker keeping its connection to the browser relay, which left Chrome's "started debugging this browser" bar on every tab until the omp session exited ([#17212](https://github.com/can1357/oh-my-pi/pull/17212) by [@nickzitzer](https://github.com/nickzitzer))
- Fixed a live tool card dropping the model's `i` intent, which the harness strips from the args `tool_execution_start` carries; the card now keeps it, so a bash call in Tern shows its description instead of a bare "Bash" as it already did in a resumed session ([#17197](https://github.com/can1357/oh-my-pi/pull/17197) by [@iacore](https://github.com/iacore))
- RPC sessions now report settled (`isSettled: true`, `session_settled`) after a turn whose failed `todo` call queued a reminder for the next prompt, instead of appearing busy until another prompt arrives ([#17238](https://github.com/can1357/oh-my-pi/pull/17238) by [@kmccleary3301](https://github.com/kmccleary3301))
- `/annotate` keeps notes and an unfinished note when the overlay is closed without sending them: reopening the same source restores them, **Saved draft** resumes any of the session's drafts, and **Discard notes and close** drops one ([#17271](https://github.com/can1357/oh-my-pi/pull/17271) by [@H4vC](https://github.com/H4vC), based on [#17230](https://github.com/can1357/oh-my-pi/pull/17230) by [@Shadorain](https://github.com/Shadorain)).
- Annotation feedback names each note's source line, so notes on blank or repeated lines stay distinguishable ([#17271](https://github.com/can1357/oh-my-pi/pull/17271) by [@H4vC](https://github.com/H4vC), based on [#17230](https://github.com/can1357/oh-my-pi/pull/17230) by [@Shadorain](https://github.com/Shadorain)).
- Fixed `/tan` clones ending without a final answer when they call `ask`; the clone now keeps running and the parent receives its final answer instead of an empty result ([#17223](https://github.com/can1357/oh-my-pi/pull/17223) by [@trukhinyuri](https://github.com/trukhinyuri))
- Pasting in a terminal with enhanced paste (Tern, kitty) now lands in the open dialog's field — the agents hub's New agent description, an /annotate note — instead of the hidden prompt
- Pasting or dropping an image file into the prompt in a terminal with enhanced paste (Tern, kitty) now attaches the image instead of typing its path
- The plan review's edit button in Tern names your editor ("Edit in Notepad", "Edit in nvim") instead of "Edit in $EDITOR"
- Fixed `/tan` clones ending without a final answer when they call `ask`; the clone now keeps running and the parent receives its final answer instead of an empty result ([#17223](https://github.com/can1357/oh-my-pi/pull/17223) by [@trukhinyuri](https://github.com/trukhinyuri))
- Fixed GitHub `/review` diff links keeping the snapshot that built the request after the cached diff refreshes in the background, instead of opening whatever file now sits at the same index ([#16310](https://github.com/can1357/oh-my-pi/pull/16310) by [@tkossak](https://github.com/tkossak))

## [18.13.2] - 2026-10-27

### Added

- Extensions in the interactive TUI can read and directly switch plan, vibe, goal, and loop modes with `ctx.sessionModes` and observe changes with the `mode_changed` event, without submitting slash commands; `extensionHandlers.modeControl: false` turns off extension-driven mode changes ([#15753](https://github.com/can1357/oh-my-pi/pull/15753) by [@Shadorain](https://github.com/Shadorain))
- RPC hosts can capture draft-only speech-to-text with live previews when speech input is enabled, without submitting an agent turn; slow flushes have adjustable deadlines, and failed transcription does not block a session change after capture closes ([#17158](https://github.com/can1357/oh-my-pi/pull/17158) by [@felipe-santos-aya](https://github.com/felipe-santos-aya)).
- Added `discovery.advertisedReasoning` to let a custom provider opt out of the reasoning ladder its `/v1/models` rows advertise (default `true`); `discovery: proxy` now reads that ladder, its `none` off-switch, and an explicit `reasoning: false` instead of building every model's thinking surface from the bundled catalog reference alone ([#15255](https://github.com/can1357/oh-my-pi/issues/15255), [#17077](https://github.com/can1357/oh-my-pi/pull/17077) by [@Youwenqwq](https://github.com/Youwenqwq))
- `WATCHDOG.yml` advisor entries now accept `scope` (`main`, `subagent`, or `all`, default `all`) to attach an advisor only to the top-level session or only to advised subagents, and `includeReasoning: false` to omit primary assistant `_thinking:_` blocks from advisor review deltas ([#17058](https://github.com/can1357/oh-my-pi/pull/17058) by [@trukhinyuri](https://github.com/trukhinyuri))
- Added `session.worktreeScope` to keep the resume picker scoped to one directory ([#17061](https://github.com/can1357/oh-my-pi/pull/17061) by [@Dante-dan](https://github.com/Dante-dan)).
- LM Studio decision models can now serve the `judge` role (`modelRoles.judge: lm-studio/<model>`); they answer over LM Studio's `/v1/decisions` endpoint instead of being offered as chat models ([#17169](https://github.com/can1357/oh-my-pi/pull/17169) by [@richiestanaway](https://github.com/richiestanaway))
- Extensions' `getAllTools()` now reports `mcpServerName`, `mcpToolName` and `mcpReadOnlyHint` for MCP-backed tools, so an extension can tell read-only connector tools from ones that change things ([#17120](https://github.com/can1357/oh-my-pi/pull/17120) by [@cfpperche](https://github.com/cfpperche))
- RPC: `navigate_tree` (move the leaf in the same session file, optionally summarizing the abandoned branch), `abort_branch_summary` and `set_label`, with matching `RpcClient` methods ([#17138](https://github.com/can1357/oh-my-pi/pull/17138) by [@andrebrait](https://github.com/andrebrait))
- RPC: delta `message_update` frames (`messageUpdates: "delta"`) now carry the block on start/end events and the message on a restart, so a client can rebuild the streaming message from deltas alone ([#17137](https://github.com/can1357/oh-my-pi/pull/17137) by [@andrebrait](https://github.com/andrebrait))
- `ctx.ui.input` now accepts `{ secret: true }` to mask typed characters as bullets in the TUI, forward an optional `secret` host hint on RPC `extension_ui_request` frames, and refuse plaintext form elicitation in ACP mode ([#17080](https://github.com/can1357/oh-my-pi/pull/17080) by [@GTanger](https://github.com/GTanger))
- Added opt-in `gc.autoCompress` (default off): interactive launches start a detached, low-priority `omp gc --compress --apply` at most once a day, so idle sessions are stored compressed without running the command; volumes where compression does not shrink a probe file (e.g. macOS 27) are skipped, and the latest run's output or skip reason is in `gc-auto-compress.log` in the agent dir ([#17189](https://github.com/can1357/oh-my-pi/pull/17189) by [@wolfiesch](https://github.com/wolfiesch))
- Added `withFatLto` to the Nix package: `omp.override { withFatLto = false; }` links `pi-natives` with thin LTO for faster builds ([#13752](https://github.com/can1357/oh-my-pi/pull/13752) by [@n3oney](https://github.com/n3oney))

### Changed

- Bundled `scout` subagents now include `ast_grep` in their default tool list, matching the agent prompt's AST-search directive; `scout` stays read-only, so `lsp` (which can rename and apply code actions) is not added ([#17151](https://github.com/can1357/oh-my-pi/pull/17151) by [@sinhduc01](https://github.com/sinhduc01))
- Clearing a draft now brings back the idle recap and idle compaction it held off, a subagent view you return to gets the recap it still owed, and prompts, turn-starting messages and IRC wakes that arrive during idle compaction wait for it to finish; SDK owners can opt a session in with `AgentSession.enableIdleMaintenance({ isBlocked, scheduledTurn, onRecap })` and `refreshIdleMaintenance()` ([#17136](https://github.com/can1357/oh-my-pi/pull/17136) by [@andrebrait](https://github.com/andrebrait))
- TTSR interrupts include a bounded excerpt of the text that matched the rule, quoted as untrusted data with harness tags escaped; excerpts are retained once per stream, preserved alongside AST matches, and omitted for zero-width matches ([#17099](https://github.com/can1357/oh-my-pi/pull/17099) by [@shgew](https://github.com/shgew))
- Sessions that load several provider-registering extensions into a shared model registry (subagents, `/tan`, SDK hosts) start faster: the model catalog is rebuilt once instead of once per extension ([#17088](https://github.com/can1357/oh-my-pi/pull/17088) by [@Delije4](https://github.com/Delije4))
- Qwen 3.8 models (for example `Qwen3.8-Flash-Next` served locally) now get the `replace` edit tool instead of hashline, like Kimi, DeepSeek and GLM 5.3 Flash; an explicit `edit.mode`, `edit.modelVariants`, `PI_EDIT_VARIANT` or `PI_STRICT_EDIT_MODE` still wins ([#17096](https://github.com/can1357/oh-my-pi/pull/17096) by [@ianderse](https://github.com/ianderse))
- ACP clients now receive each tool's name on `tool_call`, so tools without a specific ACP kind (`task`, `wait`, `ask`, …) show their own name instead of a generic "tool" label ([#17162](https://github.com/can1357/oh-my-pi/pull/17162) by [@epk](https://github.com/epk))
- `/context` now opens an interactive, read-only viewer of the active prompt, tools, messages, and thinking with estimated token usage and per-tool output, instead of the static usage report ([#16160](https://github.com/can1357/oh-my-pi/pull/16160) by [@C-W-Z](https://github.com/C-W-Z)).
- Nix builds cache Rust dependencies and the native addon in separate derivations, so Rust edits no longer recompile every dependency and TypeScript edits reuse the addon ([#13752](https://github.com/can1357/oh-my-pi/pull/13752) by [@n3oney](https://github.com/n3oney))

### Fixed

- Fixed `ask` questions being unanswerable while the prompt held a draft: Up/Down now hand the keyboard to the question (typing still goes to the draft until then), and the untouched draft is back in the prompt once the question is answered or cancelled ([#17215](https://github.com/can1357/oh-my-pi/pull/17215) by [@H4vC](https://github.com/H4vC))
- Fixed the Agent Hub becoming unreachable after the last subagent finished: the people icon now stays (muted) while the session has subagents to inspect, and `/subagents` opens the hub as an alias of `/hub` ([#17215](https://github.com/can1357/oh-my-pi/pull/17215) by [@H4vC](https://github.com/H4vC))
- Fixed `/goal pause` leaving the `goal` tool active; pausing now restores the toolset from before the goal started ([#15753](https://github.com/can1357/oh-my-pi/pull/15753) by [@Shadorain](https://github.com/Shadorain))
- Fixed `/live` flipping between `listening` and `speaking` at every pause in the assistant's speech; `speaking` now holds through short pauses ([#17114](https://github.com/can1357/oh-my-pi/issues/17114))
- Fixed the `workflowz` notice showing Python call forms in JS-only sessions and describing keep-alive workers when `eval.workpool.freshAgents` is on ([#17152](https://github.com/can1357/oh-my-pi/pull/17152) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed the first request after midnight or a working-directory change rewriting the conversation's first message, which broke OpenAI response chaining and the provider prompt cache, when an extension `context` handler or secret obfuscation was active, when an extension inserted its own message afresh on every request (superpowers' bootstrap), or when requests from one or more advisors ran in between; the new date or directory is now appended after the earlier turns, and is repeated when a side question (`/btw`) or a branch left out the turn that carried it ([#17117](https://github.com/can1357/oh-my-pi/pull/17117) by [@sjawhar](https://github.com/sjawhar))
- Fixed `:auto` on a retry fallback entry being ignored: a fixed-effort session now switches to auto thinking on that fallback instead of inheriting the failing turn's effort, and advisor fallbacks keep following the primary's effort without enabling unverified thinking ([#17100](https://github.com/can1357/oh-my-pi/pull/17100) by [@shgew](https://github.com/shgew))
- Fixed `ssh://` home-relative paths resolving against literal `/~` instead of the remote account's home ([#17182](https://github.com/can1357/oh-my-pi/pull/17182) by [@alphastorm](https://github.com/alphastorm))
- Fixed searches of `ssh://` directories failing with unsupported directory scans ([#17182](https://github.com/can1357/oh-my-pi/pull/17182) by [@alphastorm](https://github.com/alphastorm))
- Fixed clone-first worktrees carrying source-bound Python environments and CMake build trees, including self-ignored and nested directories ([#17181](https://github.com/can1357/oh-my-pi/pull/17181) by [@alphastorm](https://github.com/alphastorm))
- Fixed clean cloned worktrees carrying files ignored only by the source checkout, while retaining caches ignored by the target ([#17181](https://github.com/can1357/oh-my-pi/pull/17181) by [@alphastorm](https://github.com/alphastorm))
- Fixed glob patterns ending in `/` returning no directories or including matching files; directory-only constraints now work across local, URL, and multi-root searches ([#17180](https://github.com/can1357/oh-my-pi/pull/17180) by [@alphastorm](https://github.com/alphastorm))
- Fixed recursive `skill://` glob and find discovery skipping contained linked directories; linked resources keep their skill URLs and directory cycles terminate ([#17180](https://github.com/can1357/oh-my-pi/pull/17180) by [@alphastorm](https://github.com/alphastorm))
- Fixed find treating nonempty linked files as empty and dropping them before judgment ([#17180](https://github.com/can1357/oh-my-pi/pull/17180) by [@alphastorm](https://github.com/alphastorm))
- Fixed JSON selectors failing on BOM-prefixed input, backup and extensionless files, and modifier-only queries ([#17179](https://github.com/can1357/oh-my-pi/pull/17179) by [@alphastorm](https://github.com/alphastorm))
- Fixed JSON selectors on `ssh://` text files while preserving pagination and the remote read limit ([#17179](https://github.com/can1357/oh-my-pi/pull/17179) by [@alphastorm](https://github.com/alphastorm))
- Fixed `tool.apply_patch(...)` being rejected as an unknown tool in JavaScript eval when apply-patch editing is enabled ([#17178](https://github.com/can1357/oh-my-pi/pull/17178) by [@alphastorm](https://github.com/alphastorm))
- Fixed eval silently changing supplied cell deadlines without showing the requested and effective timeouts ([#17178](https://github.com/can1357/oh-my-pi/pull/17178) by [@alphastorm](https://github.com/alphastorm))
- Fixed unavailable Python remaining in eval's advertised languages and corrected its interpreter setup guidance ([#17178](https://github.com/can1357/oh-my-pi/pull/17178) by [@alphastorm](https://github.com/alphastorm))
- Fixed PDF archive members returning a binary-entry banner instead of converted text, with PDF selectors and page-image reads now supported ([#17175](https://github.com/can1357/oh-my-pi/pull/17175) by [@alphastorm](https://github.com/alphastorm))
- Fixed `github` `run_watch` labeling unavailable or partial failed-job logs as full logs, and included bounded fetch-failure reasons ([#17173](https://github.com/can1357/oh-my-pi/pull/17173) by [@alphastorm](https://github.com/alphastorm))
- Fixed `github` `pr_create` echoing large PR bodies in creation summaries and `xd://github` result details ([#17173](https://github.com/can1357/oh-my-pi/pull/17173) by [@alphastorm](https://github.com/alphastorm))
- Fixed raw URL reads prepending transport headers and normalizing response whitespace; raw URL bodies, ranges, and artifacts now share source-body coordinates ([#17171](https://github.com/can1357/oh-my-pi/pull/17171) by [@alphastorm](https://github.com/alphastorm))
- Fixed raw ranged reads adding elision rows, continuation notices for satisfied ranges, and conflict instructions to selected source text ([#17171](https://github.com/can1357/oh-my-pi/pull/17171) by [@alphastorm](https://github.com/alphastorm))
- Fixed `read` replacing a valid HTML page with a stale or missing guessed `.md` page; alternate representations now report their actual source URL ([#16834](https://github.com/can1357/oh-my-pi/issues/16834))
- Fixed implicit interactive `autoResume` failing every launch when a saved model cannot be restored and model fallback is disabled: startup now warns and opens a fresh session without carrying over the old history or cache identity, while preserving the original `--max-time` deadline. Saved-model diagnostics in the warning are sanitized and length-limited before display. Explicit resume and headless model-restoration restrictions remain unchanged ([#17163](https://github.com/can1357/oh-my-pi/pull/17163) by [@SAKANA-MOONLIGHT](https://github.com/SAKANA-MOONLIGHT)).
- Fixed `proc://<id>/mode` reporting a known in-process job or agent as a missing service, and clarified that stdin and lifetime modes are services-only ([#17170](https://github.com/can1357/oh-my-pi/pull/17170) by [@alphastorm](https://github.com/alphastorm))
- Fixed Rex and other OSC 7501 terminals losing the `working` or `blocked` indicator when omp redraws a user message during a run ([#17145](https://github.com/can1357/oh-my-pi/issues/17145))
- Fixed hintless Google HTTP 429 model-capacity responses using the 45–75s model-capacity backoff instead of the short generic retry delay ([#17127](https://github.com/can1357/oh-my-pi/pull/17127) by [@GTanger](https://github.com/GTanger))
- Fixed `skill://` reads, `/skill:` commands (terminal, ACP and RPC) and subagent autoload skills serving a plugin's old version, or failing with `File not found`, in a running session after `omp plugin upgrade` installed a new version; the session now rediscovers its skills and uses the upgraded files, whether or not the old version's directory was deleted ([#17027](https://github.com/can1357/oh-my-pi/pull/17027) by [@sjawhar](https://github.com/sjawhar))
- Fixed Esc on a busy session (and RPC `abort_and_restore_queue`) silently discarding queued messages from extensions and agents, such as `pi.sendMessage` steer/follow-up cards and agent-attributed prompts; they now appear in the transcript without restarting the run and reach the model with your next prompt ([#17161](https://github.com/can1357/oh-my-pi/pull/17161) by [@sjawhar](https://github.com/sjawhar))
- Fixed a failed delivery of messages typed during compaction discarding other queued messages, such as an extension's prompt; only the messages that delivery queued are taken back, and messages anything else queued before, during or after it stay queued ([#17161](https://github.com/can1357/oh-my-pi/pull/17161) by [@sjawhar](https://github.com/sjawhar))
- Fixed a failed delivery of messages typed during compaction sending the first of them twice: once now and again with the retried batch ([#17161](https://github.com/can1357/oh-my-pi/pull/17161) by [@sjawhar](https://github.com/sjawhar))
- Fixed `--resume <file|id>`, `--continue`, `SessionManager.continueRecent()`, the resume pickers and RPC `open_session` reviving an old copy of a conversation that had continued in a new file because omp could not keep writing the original (another omp process held it, or the file changed under it); resume now opens the copy with the newest turn, unless the original has turns of its own that copy lacks (for `--resume`, the pickers, and `--continue` or auto-resume of the terminal's last session), and says which file it picked; `--continue` and auto-resume without a record of the terminal's last session, and RPC `open_session`, take the copy with the newest turn among all linked copies, whichever one was written last. Copies saved before this fix are not linked and still resume as before ([#17159](https://github.com/can1357/oh-my-pi/pull/17159) by [@sjawhar](https://github.com/sjawhar))
- Fixed a `retry.fallbackChains` entry naming another Claude model being skipped while the latest Claude turn carries signed thinking: the chain now moves to that entry when the failure is on another model, is not retried (an account-policy denial, a non-retryable error, or a wait past `retry.maxDelayMs`), or has spent its retries ([#17115](https://github.com/can1357/oh-my-pi/pull/17115) by [@sjawhar](https://github.com/sjawhar))
- Anthropic composer predictions now cache the persisted conversation prefix; `/btw` follow-ups reuse stable topic history without caching regenerated image descriptions ([#17186](https://github.com/can1357/oh-my-pi/issues/17186))
- Fixed `wait` returning a skipped-tool error for background completions, peer messages, or parent steering queued before execution ([#17174](https://github.com/can1357/oh-my-pi/pull/17174) by [@alphastorm](https://github.com/alphastorm))
- Session-stop extensions now pass all continuation messages to the agent instead of silently discarding every message after the first; blocking decisions still take priority ([#17129](https://github.com/can1357/oh-my-pi/pull/17129) by [@aktanazat](https://github.com/aktanazat))
- Fixed the crash and SIGTERM recovery hint offering `omp --resume <id>` for a session that was never saved to disk, which `--resume` cannot load; such a session now prints no resume command ([#17119](https://github.com/can1357/oh-my-pi/pull/17119) by [@sjawhar](https://github.com/sjawhar))
- Fixed Ctrl+V over SSH pasting the server's clipboard when the client terminal forwards the key instead of pasting (e.g. Tern on Windows into a macOS host); omp now leaves the remote clipboard alone and points you to your terminal's paste shortcut ([#17149](https://github.com/can1357/oh-my-pi/pull/17149) by [@H4vC](https://github.com/H4vC))
- Fixed `apply_patch` committing unmatched old/context text or dropping numeric prefixes; matching now uses complete lines without changing other edit modes' fuzzy behavior ([#17184](https://github.com/can1357/oh-my-pi/pull/17184) by [@alphastorm](https://github.com/alphastorm))
- Fixed context-free `apply_patch` line deletions leaving blank rows, including first, last and only lines ([#17184](https://github.com/can1357/oh-my-pi/pull/17184) by [@alphastorm](https://github.com/alphastorm))
- Fixed `apply_patch` rejecting move-only updates and move-then-add envelopes; moves preserve source bytes and permissions and later sections see the ordered file state ([#17184](https://github.com/can1357/oh-my-pi/pull/17184) by [@alphastorm](https://github.com/alphastorm))
- Fixed `omp plugin` commands applying changes under `--dry-run`: `upgrade` and `omp update --plugins --check` now preview, and actions without a preview reject the flag ([#17104](https://github.com/can1357/oh-my-pi/pull/17104) by [@sjawhar](https://github.com/sjawhar))
- Turning off `async.widgets` mid-session now stops spec requests for already-shown job widgets and aborts any request in flight ([#17090](https://github.com/can1357/oh-my-pi/pull/17090) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed `learn` not hot-registering a newly minted or updated managed skill in the active session (`session.skills`, `skill://`, and the system prompt), and fixed `composeRecallQuery` dropping prior user turns when an earlier turn repeated the latest prompt ([#17113](https://github.com/can1357/oh-my-pi/pull/17113) by [@GTanger](https://github.com/GTanger))
- Fixed `@path` file mentions skipping `.pdf`, `.docx`, `.xlsx`, `.pptx`, and `.epub` files as binary instead of converting them to Markdown with `markit` like CLI `@file` arguments and `read` ([#17193](https://github.com/can1357/oh-my-pi/pull/17193) by [@GTanger](https://github.com/GTanger))
- Fixed an automatic retry fallback (a hop down `retry.fallbackChains` or the Fireworks Fast degrade) re-rendering the system prompt for the new model, which made Anthropic write the whole cached conversation again on each hop; a hop now keeps the Model line and Delegation wording, and rebuilds only when the new model needs a different edit mode, tool-description handling, or tool set ([#17014](https://github.com/can1357/oh-my-pi/pull/17014) by [@sjawhar](https://github.com/sjawhar))
- Fixed a live subagent's system prompt re-rendering its peer list, with each peer's current activity, on every rebuild, which made Anthropic write the whole cached conversation again; the list now updates only when a rebuild changes the rest of the prompt, and `history://` lists the current peers ([#17014](https://github.com/can1357/oh-my-pi/pull/17014) by [@sjawhar](https://github.com/sjawhar))
- SQLite row selectors now avoid shadowed ROWID aliases so reads, updates, and deletes target the intended single row. ([#16998](https://github.com/can1357/oh-my-pi/issues/16998), [#17001](https://github.com/can1357/oh-my-pi/pull/17001) by [@ai-yang](https://github.com/ai-yang))
- Fixed composer predictions offering notes relayed in from other agents or sessions (for example an orchestrator's pasted status note) as the user's next message; predictions now cover only what the person at the keyboard would type ([#17185](https://github.com/can1357/oh-my-pi/pull/17185) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed image descriptions using the first vision model in catalog order (such as `claude-fable-5`) when no vision model is configured; they now use the least expensive priced vision-capable model ([#17148](https://github.com/can1357/oh-my-pi/issues/17148), [#17196](https://github.com/can1357/oh-my-pi/pull/17196) by [@gcp](https://github.com/gcp))
- Fixed `wait` results and background job deliveries naming a finished subagent only by a job id that differs from its agent id (e.g. `Foo-2` for a messaged agent's new turn), where `agent://Foo-2` and `history://Foo-2` are not found; they now name `history://Foo`, plus `agent://Foo` when that turn published its output ([#17112](https://github.com/can1357/oh-my-pi/pull/17112) by [@sjawhar](https://github.com/sjawhar))
- Fixed `RpcClient.promptAndWait()` hanging until its timeout when the agent process exits or the client stops after the prompt was acknowledged; it now rejects right away ([#17135](https://github.com/can1357/oh-my-pi/pull/17135) by [@andrebrait](https://github.com/andrebrait))
- Fixed reading versioned Read the Docs pages serving the development branch's source file instead of the requested version's content when the page's Edit link targets another branch ([#17091](https://github.com/can1357/oh-my-pi/pull/17091) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed RPC startup hanging when an extension opens a dialog during `session_start`: the client can now answer it, and other commands still wait for startup to finish, in order ([#17139](https://github.com/can1357/oh-my-pi/pull/17139) by [@andrebrait](https://github.com/andrebrait))
- Fixed extension tools disappearing once the startup plan mode (`plan.defaultOnStartup`) was paused or its plan approved: tools of extensions that load after startup now stay, while built-ins that plan mode registered, such as its `write` transport, still go ([#17085](https://github.com/can1357/oh-my-pi/pull/17085) by [@appboypov](https://github.com/appboypov))
- Fixed a batch `task` call silently ignoring a `model` (or `sourceSession`) on a non-`seance` item while the `seance` agent is hidden, so the child ran on its own model; the call is now refused with the same error as a single-agent call ([#17107](https://github.com/can1357/oh-my-pi/pull/17107) by [@sjawhar](https://github.com/sjawhar))
- Fixed an edit under an older `[path#TAG]` header, after another edit had changed the file, applying to lines that read never displayed, including a line it had cut at the column cap; such an edit now shows the anchored lines first, as it does under the file's current tag ([#16208](https://github.com/can1357/oh-my-pi/issues/16208), [#17033](https://github.com/can1357/oh-my-pi/pull/17033) by [@sjawhar](https://github.com/sjawhar))
- Fixed `omp gc --compress` (and the `gc.autoCompress` background run) taking minutes on large session histories ([#17195](https://github.com/can1357/oh-my-pi/pull/17195) by [@H4vC](https://github.com/H4vC))
- Fixed `omp gc --compress --apply` spending time on every idle session where the filesystem does not actually compress files (e.g. macOS 27); it now reports `compress skipped: <reason>`, and `gc.autoCompress` no longer slows interactive startup with that check ([#17195](https://github.com/can1357/oh-my-pi/pull/17195) by [@H4vC](https://github.com/H4vC))

## [18.13.1] - 2026-10-27

### Added

- Added `tools.restrictedFolders`: every action on a listed folder (the folder and everything below it) asks for an explicit Approve/Deny in every approval mode, `yolo` included, and no remembered grant, session approval, or ACP "Always allow" covers it; recursive searches rooted above a restricted folder ask too, commands are matched by the directory they run in, and a `deny` policy still denies ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- `/pause` shows draining turns and running jobs across the main agent's subagent tree, without waiting on finished turns, safely parked agents, or suspended advisor reviews ([#17073](https://github.com/can1357/oh-my-pi/pull/17073) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).

### Changed

- Reduced redraws during background subagent progress while keeping elapsed previews and native checklists current ([#17131](https://github.com/can1357/oh-my-pi/pull/17131) by [@iliaal](https://github.com/iliaal), based on [#16647](https://github.com/can1357/oh-my-pi/pull/16647) by [@Komzpa](https://github.com/Komzpa)).
- Restoring a session with many subagents refreshes the running-subagent badge and lists once per burst instead of once per agent ([#16642](https://github.com/can1357/oh-my-pi/pull/16642) by [@Komzpa](https://github.com/Komzpa))
- `ask` answers now name the option a note is on (`m: [X, Y] (note on Y: …)`, `User added note on Y: …`) ([#17126](https://github.com/can1357/oh-my-pi/pull/17126) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed advisors dropping their review and showing a rate-limit error when the provider returns a timed 429 such as Codex's `turn_rate_limit_exceeded`; the advisor now waits out the Retry-After (within `retry.maxDelayMs`) and retries like the main agent ([#17087](https://github.com/can1357/oh-my-pi/pull/17087) by [@H4vC](https://github.com/H4vC))
- Fixed a hashline `PUT` being refused with "would hold one more copy of line N … than the range did" when its body restates the line next to the range, fills the range, and adds a new line equal to that neighbour (a second `@property` or `#[test]`, or a `break;` above a new `case`); it applies again, dropping only the restated line ([#17028](https://github.com/can1357/oh-my-pi/pull/17028))
- Fixed task subagents receiving `AGENTS.md` files, including the user-level `~/.omp/agent/AGENTS.md`, when the session has additional workspace roots (`--add-dir`, `/add-dir`, `workspace.additionalDirectories`)
- Fixed an `ask` note added right after picking an answer landing on the next question's answer, in Tern and the TUI; Note now goes to the answer just picked until the next question gets other input ([#17126](https://github.com/can1357/oh-my-pi/pull/17126) by [@H4vC](https://github.com/H4vC))

## [18.13.0] - 2026-10-26

### Breaking Changes

- `snapshotJobs` no longer accepts `includeResults`, and `buildJobResult` accepts only the `"wait"` and `"cancel"` ops; the `"jobs"` op has had no caller since `wait` and `proc://` replaced the `hub` tool ([#16763](https://github.com/can1357/oh-my-pi/pull/16763) by [@will-bogusz](https://github.com/will-bogusz))
- `snapshotJobs` no longer accepts `includeResults`, and `buildJobResult` accepts only the `"wait"` and `"cancel"` ops; the `"jobs"` op has had no caller since `wait` and `proc://` replaced the `hub` tool ([#16763](https://github.com/can1357/oh-my-pi/pull/16763) by [@will-bogusz](https://github.com/will-bogusz))

### Added

- Added `omp -p --wait-async` (setting `async.printWake`): print mode waits for the background jobs it started and wakes the same session with each result before exiting, instead of cancelling them ([#10363](https://github.com/can1357/oh-my-pi/issues/10363), [#16690](https://github.com/can1357/oh-my-pi/pull/16690) by [@trukhinyuri](https://github.com/trukhinyuri))
- File slash commands with `side: true` frontmatter (including Codex and OpenCode command directories) run as `/btw` side questions in the TUI, with or without arguments: they answer off the transcript and never steer a running turn. The panel and `/btw` history title them by the typed command (`/sitrep`); the title is kept in an `entry-<id>.title` sidecar so older builds can still read the history. Other modes expand them as ordinary prompts ([#16815](https://github.com/can1357/oh-my-pi/pull/16815) by [@wolfiesch](https://github.com/wolfiesch))
- Added `compat.requiresThinkingPresence` to `models.yml` overrides, so a gateway model group whose strict member validates thinking replay can pad a turn a lax member answered without reasoning ([#16739](https://github.com/can1357/oh-my-pi/pull/16739) by [@lz37](https://github.com/lz37))
- Anthropic web search and Files API uploads follow `PI_ANTHROPIC_API_VERSION=2026-10-21`; web search omits `temperature` under that version ([#16706](https://github.com/can1357/oh-my-pi/pull/16706) by [@H4vC](https://github.com/H4vC))
- llama.cpp auto-discovery now also finds local servers on llama-server's new default port 9931 when nothing answers on 8080 ([#16675](https://github.com/can1357/oh-my-pi/pull/16675) by [@bartbroere](https://github.com/bartbroere))
- `/local` (or `Alt+G`, remappable as `app.local.open`) opens a picker of the session's `local://` files and edits the chosen one in place in `$VISUAL`/`$EDITOR`; `/local <name>` opens a file directly with name completion ([#16873](https://github.com/can1357/oh-my-pi/pull/16873) by [@Shadorain](https://github.com/Shadorain))
- Added `--no-context-files` to start a session without `AGENTS.md`, `CLAUDE.md` or other context files, including those of `--add-dir` roots and in subagents ([#16768](https://github.com/can1357/oh-my-pi/pull/16768) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- Clarified how RPC and RPC-UI clients discover and invoke mounted MCP tools through `xd://` devices rather than relying on `dumpTools` ([#16864](https://github.com/can1357/oh-my-pi/pull/16864) by [@michaeltrefry](https://github.com/michaeltrefry))
- The note `read` adds to a PDF whose pages have no extractable text (a scan) now points at the `:page<N>.png` selector, which returns the page as an image, instead of the browser prelude ([#16585](https://github.com/can1357/oh-my-pi/pull/16585) by [@will-bogusz](https://github.com/will-bogusz))
- `read doc.pdf:page<N>.png` renders the page in a square 874x874 tab instead of the default landscape one, so a letter page comes back at 668x865 instead of 441x568 and a landscape page at 864x669 instead of 736x567 ([#16585](https://github.com/can1357/oh-my-pi/pull/16585) by [@will-bogusz](https://github.com/will-bogusz))
- Added `--warn-cost` and `--max-cost` (`session.warnCost` / `session.maxCost`): omp warns once at the first spend and stops sending model requests at the second, subagents included; capped print runs exit 3 ([#7802](https://github.com/can1357/oh-my-pi/issues/7802); first written by [@zhang17-24](https://github.com/zhang17-24)) ([#16803](https://github.com/can1357/oh-my-pi/pull/16803) by [@will-bogusz](https://github.com/will-bogusz))
- `/session` (and RPC `get_session_stats`, as `editRejections`) lists your failed edits by why they were refused (unseen lines, stale tag, parse error, …), and each failed edit records that reason as `details.errorKind` in the session file ([#16608](https://github.com/can1357/oh-my-pi/pull/16608) by [@will-bogusz](https://github.com/will-bogusz))
- Added exclusions to `grep`: a `path` entry starting with `!` leaves matching files and folders out of the search (`src;!*.test.ts`, `!vendor;!gen`), where before it was taken as a path and found nothing ([#16920](https://github.com/can1357/oh-my-pi/pull/16920) by [@will-bogusz](https://github.com/will-bogusz))
- `wait` and `read proc://` now show a running subagent's run time, request count, cost, context fill and stage, so a subagent that is looping is visible without opening its transcript ([#16863](https://github.com/can1357/oh-my-pi/pull/16863) by [@KimToehler](https://github.com/KimToehler))
- Google Antigravity web search sends the same transport headers as the official client (`Accept-Encoding: gzip`, no explicit `Accept`) ([#17012](https://github.com/can1357/oh-my-pi/pull/17012) by [@apoc](https://github.com/apoc))
- A subagent's result up to 11,500 characters now reaches its parent whole, instead of as a 5,000-character preview the parent had to re-read through `agent://<id>` or act on without its ending ([#16599](https://github.com/can1357/oh-my-pi/pull/16599) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a subagent's final report or `yield` reaching its parent and `agent://` as its short reply to a peer message or `agent://all` broadcast (the parent's included) that arrived as it finished; such messages now get a turn of their own after the result, and a peer that wrote directly still receives the reply ([#16583](https://github.com/can1357/oh-my-pi/pull/16583) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `ts-set-map` rule stalling tool-call streaming on a long single-line `Set` value (5 s at 20,000 characters) and firing when the literal array only feeds a computed argument such as `new Set(["a", "b"].map(normalize))`; `ts-import-type` no longer fires on `import("x").then` written with a non-breaking space or line separator before the call ([#16556](https://github.com/can1357/oh-my-pi/pull/16556) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a subagent woken after it was parked losing the tools an extension registers at its first prompt (such as HexRays `ida-mcp`'s `ida_*` tools), which also made its first request after waking miss the prompt cache; extensions see the revive as a `before_agent_start` with the new `reason: "revive"` ([#16597](https://github.com/can1357/oh-my-pi/pull/16597) by [@will-bogusz](https://github.com/will-bogusz))
- `read` shows HEIC, HEIF and AVIF photos (such as iPhone pictures) as images instead of refusing them as binary, decoding them with ffmpeg 8.1 or newer; text-only models get their metadata, and without such an ffmpeg the error says how to convert the file ([#16612](https://github.com/can1357/oh-my-pi/pull/16612) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` of web pages with tables, code or pricing lists (API references, specs, pricing pages) returning a shorter trafilatura or Jina rendering that leaves out much of the page, and noting the page "appears to require JavaScript or is mostly navigation" ([#16596](https://github.com/can1357/oh-my-pi/pull/16596) by [@will-bogusz](https://github.com/will-bogusz))
- `omp usage --json` now includes each policy-routed account's priority, reserve and routing state (`eligible`, `inside-reserve`, `exhausted` or `unknown`) as a `policy` object, matching the policy line in the text view ([#16581](https://github.com/can1357/oh-my-pi/pull/16581) by [@will-bogusz](https://github.com/will-bogusz))
- Added prompt-cache warming for Factory Droid's Claude models: replays follow the 5m entry, or the 1h entry once a response reports writing one ([#16296](https://github.com/can1357/oh-my-pi/pull/16296) by [@will-bogusz](https://github.com/will-bogusz))
- `generate_image` can now run Factory Droid's image models (GPT Image 2.5, GPT Image 2.5 Flare, Gemini 3 Pro Image) when one is chosen for the `image` role ([#16316](https://github.com/can1357/oh-my-pi/pull/16316) by [@will-bogusz](https://github.com/will-bogusz))
- On macOS, asking the agent to open a file, folder or URL, or to show a file in Finder, now takes one `computer.apps.open(path, { app?, reveal? })` call instead of a dozen steps driving Finder by hand ([#16403](https://github.com/can1357/oh-my-pi/pull/16403) by [@will-bogusz](https://github.com/will-bogusz))
- Added in-place updates of the browser relay's Chrome extension after an omp upgrade: an older extension loaded from `~/.omp/browser-relay/extension` is rewritten and reloads itself once no omp session is using the relay ([#15105](https://github.com/can1357/oh-my-pi/pull/15105) by [@will-bogusz](https://github.com/will-bogusz))
- Added a note to relay `browser.open` results when the Chrome extension was installed by an older omp, naming `omp browser-relay install` and a reload ([#15105](https://github.com/can1357/oh-my-pi/pull/15105) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed images attached with an `@path` file mention reaching a text-only model as `[image omitted: …]` with `images.describeForTextModels` enabled; they now get the `vision` role description like pasted images ([#16853](https://github.com/can1357/oh-my-pi/issues/16853))
- Fixed `browser.open({ ignore_https_errors: true })` still failing with certificate errors such as `net::ERR_CERT_AUTHORITY_INVALID` on the shared Chromium and on `app.cdp_url` browsers; the override now lasts until the tab is closed ([#16930](https://github.com/can1357/oh-my-pi/issues/16930))
- `ignore_https_errors` through the Chrome relay now fails up front, explaining that Chrome's extension debugger API cannot ignore certificate errors and pointing to `app.relay: false`, instead of failing with `Security.setIgnoreCertificateErrors wasn't found` ([#16930](https://github.com/can1357/oh-my-pi/issues/16930))
- Fixed a parent follow-up consumed while a kept-alive subagent resumes from queued steering or an async completion leaving `agent://` on the previous result instead of delivering the fresh answer ([#16746](https://github.com/can1357/oh-my-pi/issues/16746))
- Fixed a long streamed answer ending the collab room for every guest with "collab send backlog exceeded its limit"; the host now sends guests only the latest state of a streaming message, and guests still speak the full answer when speech is on ([#16956](https://github.com/can1357/oh-my-pi/issues/16956))
- Fixed `read proc://<agent>` and `write proc://<agent>/kill` answering "not found" for a subagent that a message woke while its new turn runs as job `<agent>-2`; they now reach that job, and reading the agent's finished first job names the job it is running as ([#17020](https://github.com/can1357/oh-my-pi/pull/17020) by [@sjawhar](https://github.com/sjawhar))
- Fixed the agent reading a fallback engine's `web_search` results as the preferred provider's: the tool result now notes which provider answered and why the earlier ones failed ([#16948](https://github.com/can1357/oh-my-pi/pull/16948) by [@BAKocska](https://github.com/BAKocska))
- Fixed a turn that ended with background jobs still running looking stuck: the working row now says it is waiting for those jobs and names them instead of repeating the last tool call, and Esc ends the wait, so the jobs keep running and their results land in context for your next prompt instead of starting a new turn ([#17032](https://github.com/can1357/oh-my-pi/pull/17032) by [@sjawhar](https://github.com/sjawhar))
- The `power.sleepPrevention` setting now says it keeps the machine awake only while the agent is running a turn, not for as long as a session is open ([#16762](https://github.com/can1357/oh-my-pi/pull/16762) by [@will-bogusz](https://github.com/will-bogusz))
- The advisor docs now say a quota-paused advisor resumes only when its runtime is reset or rebuilt (compaction, a session switch, `/advisor`, a config reload or a restart), not after a cooldown ([#16766](https://github.com/can1357/oh-my-pi/pull/16766) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read proc://<agent>` and `write proc://<agent>/kill` answering "not found" for a subagent that a message woke while its new turn runs as job `<agent>-2`; they now reach that job, and reading the agent's finished first job names the job it is running as ([#17020](https://github.com/can1357/oh-my-pi/pull/17020) by [@sjawhar](https://github.com/sjawhar))
- Fixed the agent reading a fallback engine's `web_search` results as the preferred provider's: the tool result now notes which provider answered and why the earlier ones failed ([#16948](https://github.com/can1357/oh-my-pi/pull/16948) by [@BAKocska](https://github.com/BAKocska))
- Fixed the `computer` tool's `computer.window({ app })` failing for an app with no open window without saying what to do; the error now names the `computer.apps.open(…)` call that launches it (on macOS it also shows a window of a running app that has none), and `computer.window()` with no argument asks for a window id or filter instead of listing windows that "match undefined" ([#16912](https://github.com/can1357/oh-my-pi/pull/16912) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the `computer` tool prompt leaving `el.selectText` out of the element helpers; it now says a following `el.type` on that element replaces the selection ([#16769](https://github.com/can1357/oh-my-pi/pull/16769) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a turn that ended with background jobs still running looking stuck: the working row now says it is waiting for those jobs and names them instead of repeating the last tool call, and Esc ends the wait, so the jobs keep running and their results land in context for your next prompt instead of starting a new turn ([#17032](https://github.com/can1357/oh-my-pi/pull/17032) by [@sjawhar](https://github.com/sjawhar))

### Fixed

- Honored `display_name`, `context_window`, and `input_modalities` when a model list nests them under `metadata`, so codex-lb-style gateways surface the advertised name, window, and image input instead of the raw id and defaults. ([#17010](https://github.com/can1357/oh-my-pi/pull/17010) by [@adi-IL](https://github.com/adi-IL))
- Recovered spilled tool output in sessions without an artifacts directory: the `artifact://` link the truncation footer advertises now reads the in-memory copy instead of failing with "No session - artifacts unavailable". ([#17009](https://github.com/can1357/oh-my-pi/pull/17009) by [@adi-IL](https://github.com/adi-IL))
- Fixed the compiled `omp` binaries trusting certificates from the compromised eMudhra intermediate CAs (CVE-2026-91403) and carrying the Brotli decoder out-of-bounds write (CVE-2026-111497); release binaries now build on Bun 1.4.4 ([#16822](https://github.com/can1357/oh-my-pi/issues/16822), [#16865](https://github.com/can1357/oh-my-pi/pull/16865) by [@bse-ai](https://github.com/bse-ai))
- Fixed `computer` runs in subagents and `omp -p` stopping at their first `control.acquire`: they now keep working through background window input and report only a step that needs foreground control ([#16909](https://github.com/can1357/oh-my-pi/pull/16909) by [@will-bogusz](https://github.com/will-bogusz))
- With `bash.gitGuard` on, a repository that once finished a conflicted rebase no longer counts as mid-conflict forever, which had let `git checkout`, `switch` and `restore` through; branch switches such as `git checkout -B <branch> <commit>` stay refused during a real merge or rebase too, abbreviated options such as `git reset --ha` are refused like the full ones, and `git stash create` is allowed ([#16919](https://github.com/can1357/oh-my-pi/pull/16919) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls right after a click that navigates (headless, connected and relay Chrome) reaching the page being left: reads and screenshots returned the old page or failed with `Execution context was destroyed` or `Cannot find context with specified id`, and a `fill` could land on the old form; they now wait for the new page ([#16907](https://github.com/can1357/oh-my-pi/pull/16907) by [@will-bogusz](https://github.com/will-bogusz))
- LSP diagnostics now reflect external edits to already-open dependencies when checking an importer, including after Write/Edit ([#16836](https://github.com/can1357/oh-my-pi/issues/16836)).
- Fixed URL `read` line selectors using different coordinates from URL `grep` when the response includes transport headers ([#16877](https://github.com/can1357/oh-my-pi/issues/16877)).
- Fixed `write` to a SQLite row ignoring the database's declared foreign keys: orphan inserts and updates now fail, `ON DELETE RESTRICT` blocks the delete, and `ON DELETE CASCADE` removes dependent rows ([#16999](https://github.com/can1357/oh-my-pi/issues/16999))
- Fixed pasting a server URL into the `/mcp add` wizard putting it in the hidden chat draft instead of the URL field ([#16975](https://github.com/can1357/oh-my-pi/issues/16975)).
- `omp --from-claude` keeps the last real model when Claude records a synthetic API error, and does not try to restore a synthetic-only placeholder ([#16785](https://github.com/can1357/oh-my-pi/issues/16785)).
- Fixed skill-list previews of long CJK descriptions collapsing to the few characters before an early ASCII space (e.g. `用户点名…`); they now keep the full preview budget ([#17070](https://github.com/can1357/oh-my-pi/issues/17070))
- Browser clicks on a shadow-root button no longer fail with `blocked: covered by` naming the button's own slotted content; real overlays are still refused ([#16958](https://github.com/can1357/oh-my-pi/issues/16958))
- Fixed reading `.xlsx` files rewriting numeric-looking text cells: long IDs like `12345678901234567890` no longer round (and collide), and text such as `00123` keeps its leading zeros ([#16831](https://github.com/can1357/oh-my-pi/issues/16831))
- Fixed rc-file aliases for core tools (e.g. `alias ls='eza --icons'`) leaking into the bash tool; `ls`, `cat`, `grep` and the other core tools now run the real binaries ([#17067](https://github.com/can1357/oh-my-pi/issues/17067))
- Fixed a collab room staying half alive after its session moved to a new file because it was open in another omp process (or replaced/contested on disk): guests now get room-closed, the registry entry is withdrawn, and `collab.autoStart` shares the moved session ([#16935](https://github.com/can1357/oh-my-pi/issues/16935))
- Fixed skill-description compression ignoring the configured `default` model when `modelRoles.smol` is unset and sending background requests to the built-in smol chain (e.g. `claude-haiku-5-5`) instead of the model `/models` shows for SMOL ([#16970](https://github.com/can1357/oh-my-pi/issues/16970))
- Fixed `models.yml` discovery providers with an `apiKey` (and no `authHeader: true`) showing 0 models in `/models` and ctrl+p right after startup despite a cached catalog; cached models now load immediately ([#16965](https://github.com/can1357/oh-my-pi/issues/16965))
- Anthropic web search no longer sends unsupported `temperature` to Claude Haiku 5.5, avoiding HTTP 400 failures ([#16986](https://github.com/can1357/oh-my-pi/issues/16986))
- Fixed pages in the managed headless browser hitting "Maximum call stack size exceeded" in canvas `fillText` after calling `canvas.getContext("2d")` repeatedly ([#16879](https://github.com/can1357/oh-my-pi/issues/16879))
- Fixed LSP references and rename previews still listing a file that was open and then deleted (via `edit`, or outside OMP before a rename) until the language server restarted ([#16880](https://github.com/can1357/oh-my-pi/issues/16880))
- Fixed `omp plugin upgrade` failing on Windows with `EPERM: operation not permitted, symlink` when the installed plugin was replaced by `omp plugin link`; a failed upgrade now restores the link as a junction ([#16844](https://github.com/can1357/oh-my-pi/issues/16844))
- `omp plugin upgrade a@m b@m c@m` now upgrades every specified plugin instead of silently skipping targets after the first ([#16826](https://github.com/can1357/oh-my-pi/issues/16826))
- Browser `tab.fill()`/`tab.type()` (and `frame.fill()`/`frame.type()`) that time out on long text now stop typing instead of finishing it behind the rejected call, and the timeout reports how many characters were typed instead of claiming the element was hidden or covered ([#16833](https://github.com/can1357/oh-my-pi/issues/16833))
- Concurrent archive member writes now preserve both updates across sessions and directory symlinks; canceled writes waiting for the archive no longer publish later ([#17000](https://github.com/can1357/oh-my-pi/issues/17000)).
- Fixed a `tools.approval.<tool>: prompt` policy on a tool mounted as an `xd://` device asking the same approval question twice for one `write xd://<tool>` call ([#17039](https://github.com/can1357/oh-my-pi/issues/17039))
- ACP cancellation now waits through Python kernel interrupt escalation before closing a session; prompts sent after a closed session return `ResourceNotFound` so clients can offer `session/load` recovery ([#16889](https://github.com/can1357/oh-my-pi/issues/16889)).
- Google Antigravity, Google, and Google Vertex now keep append-only context by default, preserving cached prompts across long-running agent turns ([#16979](https://github.com/can1357/oh-my-pi/issues/16979)).
- Fixed LiteLLM `mode: decisions` model groups being offered as chat models instead of judge models, including for custom `discovery.type: litellm` providers ([#16939](https://github.com/can1357/oh-my-pi/issues/16939))
- ACP: `instructions` returned by MCP servers declared in `session/new` now reach the model under "## MCP Server Instructions", as they do for `.mcp.json` servers ([#16882](https://github.com/can1357/oh-my-pi/issues/16882))
- Fixed the Windows tab title (e.g. in Tern) sticking at `omp` instead of the session title after a JS eval worker or `omp browser-relay` ran in the same console; omp no longer retitles the console from child processes and reclaims the title when another process replaces it ([#16842](https://github.com/can1357/oh-my-pi/issues/16842))
- Fixed Python `eval` reporting the backend unavailable when the first `python` on PATH is broken (e.g. a mise shim with no version set) even though a working `python`/`python3` sits further down PATH; every PATH match is now probed, and the error reports bounded probe failures with home paths shortened ([#16824](https://github.com/can1357/oh-my-pi/issues/16824))
- Fixed a turn whose stream was cut after text had already rendered — a gateway substituting an in-band `error` frame for the missing terminal event — ending instead of continuing from the partial answer ([#16990](https://github.com/can1357/oh-my-pi/pull/16990) by [@Maziar123](https://github.com/Maziar123))
- Model tags in `/skill:` arguments now register `m<N>` agents and appear with the skill prompt instead of reaching the model as literal `^` selectors ([#16818](https://github.com/can1357/oh-my-pi/issues/16818))
- Fixed a user-scope `omp plugin upgrade`, `install --force`, or `uninstall` run outside a project deleting the cached plugin a project-scope install in that project still links to ([#16827](https://github.com/can1357/oh-my-pi/issues/16827))
- Fixed resuming anonymized sessions with text tool results crashing before the next model request ([#16859](https://github.com/can1357/oh-my-pi/issues/16859), [#16896](https://github.com/can1357/oh-my-pi/pull/16896) by [@tneemo](https://github.com/tneemo))
- Fixed the mid-run todo nudge going silent for the rest of a long turn after two nudges: a `todo` call now re-arms the per-turn budget instead of waiting for the next user prompt ([#16962](https://github.com/can1357/oh-my-pi/pull/16962) by [@omertahaoztop](https://github.com/omertahaoztop))
- xAI web and X searches now run Grok's hosted search instead of failing with `returned no sources` or falling back to engines that cannot read X posts ([#16947](https://github.com/can1357/oh-my-pi/pull/16947) by [@BAKocska](https://github.com/BAKocska))
- Fixed `/delete` leaving an empty zero-turn session on disk when you quit before sending a message ([#11303](https://github.com/can1357/oh-my-pi/issues/11303), [#16798](https://github.com/can1357/oh-my-pi/pull/16798) by [@NewtonChutney](https://github.com/NewtonChutney))
- Idle recap no longer runs when the prior message was not generated (a user message, or an assistant turn that produced no output). A generated assistant reply still recaps after the idle delay ([#16978](https://github.com/can1357/oh-my-pi/pull/16978) by [@atacolak](https://github.com/atacolak))
- Fixed an extension loading twice, so every handler ran twice, when the same file was reachable both through a symlink and its target, such as a link in the agent `extensions/` directory plus `--extension` with the real path; discovery now dedupes extension paths by real file ([#16788](https://github.com/can1357/oh-my-pi/pull/16788) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed the `write` refusal in read-only subagents saying filesystem writes are unavailable; it now gives the on-disk path of `local://` files, so the agent can tell its caller where its report is ([#17023](https://github.com/can1357/oh-my-pi/pull/17023) by [@sjawhar](https://github.com/sjawhar))
- Fixed `wait` saying a subagent "finished its turn without replying" (and to ask again) after that subagent's result had already arrived as a background-job result, for a follow-up that woke it or that it got while running ([#16929](https://github.com/can1357/oh-my-pi/pull/16929) by [@sjawhar](https://github.com/sjawhar))
- Fixed a Markdown link to a local path that cannot be encoded pointing at a broken target instead of staying plain text ([#16806](https://github.com/can1357/oh-my-pi/pull/16806) by [@laviRZ](https://github.com/laviRZ))
- Fixed the Agent Hub reordering its rows on every heartbeat while it loaded the session's saved subagents, so no row could be selected until the load ended: a row's place is now fixed when the hub first shows it, agents found on disk take their place in the status/recency ranking, and a scan reads a transcript again only after it changed, so reopening the hub on a session with many saved agents no longer rereads them all ([#10524](https://github.com/can1357/oh-my-pi/issues/10524), [#16952](https://github.com/can1357/oh-my-pi/pull/16952) by [@lemonleks](https://github.com/lemonleks))
- `omp usage` now shows the Codex credit spend cap for credit-billed ChatGPT Business/Enterprise seats (previously `no limits reported`), and rounds fractional credit amounts to two decimals ([#16973](https://github.com/can1357/oh-my-pi/pull/16973) by [@DusKing1](https://github.com/DusKing1))
- Fixed TTSR rule matching slowing down quadratically on long tool calls such as `bash`, `eval` or `task` arguments: their streamed JSON escapes newlines, so every delta rescanned the whole argument (a 64 KB call with 10 rules took 120 ms of matching, now 4.5 ms). A long unterminated line is now rescanned as it grows by a quarter, and the final check still scans all of it ([#14248](https://github.com/can1357/oh-my-pi/issues/14248), [#16974](https://github.com/can1357/oh-my-pi/pull/16974) by [@lavinhoque33](https://github.com/lavinhoque33))
- Fixed the `eval` tool description so JS sessions see which helpers need `await` ([#16808](https://github.com/can1357/oh-my-pi/pull/16808) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed the `eval` agent and judge docs so JS sessions see which handle, pool and batch calls need `await`, and Python sessions with JS enabled see `agent()`'s `schema_mode` keyword instead of JS's `schemaMode` ([#16810](https://github.com/can1357/oh-my-pi/pull/16810) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed a classifier refusal on an Anthropic model ending the turn with the rest of an Anthropic `retry.fallbackChains` entry untried once the conversation carried signed thinking; the refusal now moves to the next model in the chain ([#17024](https://github.com/can1357/oh-my-pi/pull/17024) by [@sjawhar](https://github.com/sjawhar))
- Fixed the bash tool blocking commands such as `echo hi; make 2>build.err`, and sending `cat > file <<'EOF'` to `read` ([#17022](https://github.com/can1357/oh-my-pi/pull/17022) by [@sjawhar](https://github.com/sjawhar))
- Empty-stop retry exhaustion now reports provider usage without claiming that output was filtered or dropped, and same-model retries of content-less `MALFORMED_RESPONSE`/`UNEXPECTED_TOOL_CALL` errors inject a corrective tool-call reminder instead of replaying the identical cached prefix ([#17063](https://github.com/can1357/oh-my-pi/pull/17063) by [@martijnberger](https://github.com/martijnberger))
- Fixed automatic compaction committing summaries that increase context and repeatedly retrying the same retained-history cut point; token counts now include trailing tool results and post-compaction rescue ([#16904](https://github.com/can1357/oh-my-pi/pull/16904) by [@eggpeat](https://github.com/eggpeat))
- Fixed `/tan` dropping the images attached to its draft: the background agent now gets them with its request and keeps them, as admitted, when compaction restores the request; they leave the composer once `/tan` starts, so the next message cannot send them again, and come back with the draft when it cannot start ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed `/btw` dropping the images attached to its question: the side request now sends them, and like `/tan` they leave the composer once it starts and come back with the draft when it cannot; BTW history keeps each question's images (`images` on the RPC BTW records), so every follow-up sends them again, and a follow-up in the BTW history also takes pasted images ([#13890](https://github.com/can1357/oh-my-pi/issues/13890), [#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- `/omfg`, `/handoff` and `/cleanse` no longer run without the images attached to their draft: they keep the draft and say they take text only ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed an image pasted while an extension input hook held a submission being dropped from the next message: once the submitted images leave the composer, the images that stay are renumbered from `#1` ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed a collab guest losing the draft of a host-only command that takes its draft out of the composer on Enter (`/plan`, `/goal`, `/tan`, `/btw` and others): the draft now comes back with its images ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed a hashline `PUT` whose body repeats the line just above or below its range (or both), and is shorter than the range, silently deleting the range's other lines or writing a neighbouring line twice in Python, TypeScript and other parsed files; it is now refused, and the "too short" refusal names the lines the body leaves out ([#17028](https://github.com/can1357/oh-my-pi/pull/17028) by [@sjawhar](https://github.com/sjawhar))
- Fixed `computer` runs in subagents and `omp -p` stopping at their first `control.acquire`: they now keep working through background window input and report only a step that needs foreground control ([#16909](https://github.com/can1357/oh-my-pi/pull/16909) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed resuming anonymized sessions with text tool results crashing before the next model request ([#16859](https://github.com/can1357/oh-my-pi/issues/16859), [#16896](https://github.com/can1357/oh-my-pi/pull/16896) by [@tneemo](https://github.com/tneemo))
- Fixed the mid-run todo nudge going silent for the rest of a long turn after two nudges: a `todo` call now re-arms the per-turn budget instead of waiting for the next user prompt ([#16962](https://github.com/can1357/oh-my-pi/pull/16962) by [@omertahaoztop](https://github.com/omertahaoztop))
- xAI web and X searches now run Grok's hosted search instead of failing with `returned no sources` or falling back to engines that cannot read X posts ([#16947](https://github.com/can1357/oh-my-pi/pull/16947) by [@BAKocska](https://github.com/BAKocska))
- Fixed `/delete` leaving an empty zero-turn session on disk when you quit before sending a message ([#11303](https://github.com/can1357/oh-my-pi/issues/11303), [#16798](https://github.com/can1357/oh-my-pi/pull/16798) by [@NewtonChutney](https://github.com/NewtonChutney))
- Idle recap no longer runs when the prior message was not generated (a user message, or an assistant turn that produced no output). A generated assistant reply still recaps after the idle delay ([#16978](https://github.com/can1357/oh-my-pi/pull/16978) by [@atacolak](https://github.com/atacolak))
- Fixed an extension loading twice, so every handler ran twice, when the same file was reachable both through a symlink and its target, such as a link in the agent `extensions/` directory plus `--extension` with the real path; discovery now dedupes extension paths by real file ([#16788](https://github.com/can1357/oh-my-pi/pull/16788) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed the `write` refusal in read-only subagents saying filesystem writes are unavailable; it now gives the on-disk path of `local://` files, so the agent can tell its caller where its report is ([#17023](https://github.com/can1357/oh-my-pi/pull/17023) by [@sjawhar](https://github.com/sjawhar))
- Fixed `wait` saying a subagent "finished its turn without replying" (and to ask again) after that subagent's result had already arrived as a background-job result, for a follow-up that woke it or that it got while running ([#16929](https://github.com/can1357/oh-my-pi/pull/16929) by [@sjawhar](https://github.com/sjawhar))
- Fixed a Markdown link to a local path that cannot be encoded pointing at a broken target instead of staying plain text ([#16806](https://github.com/can1357/oh-my-pi/pull/16806) by [@laviRZ](https://github.com/laviRZ))
- Fixed the Agent Hub reordering its rows on every heartbeat while it loaded the session's saved subagents, so no row could be selected until the load ended: a row's place is now fixed when the hub first shows it, agents found on disk take their place in the status/recency ranking, and a scan reads a transcript again only after it changed, so reopening the hub on a session with many saved agents no longer rereads them all ([#10524](https://github.com/can1357/oh-my-pi/issues/10524), [#16952](https://github.com/can1357/oh-my-pi/pull/16952) by [@lemonleks](https://github.com/lemonleks))
- `omp usage` now shows the Codex credit spend cap for credit-billed ChatGPT Business/Enterprise seats (previously `no limits reported`), and rounds fractional credit amounts to two decimals ([#16973](https://github.com/can1357/oh-my-pi/pull/16973) by [@DusKing1](https://github.com/DusKing1))
- Fixed browser calls right after a click that navigates (headless, connected and relay Chrome) reaching the page being left: reads and screenshots returned the old page or failed with `Execution context was destroyed` or `Cannot find context with specified id`, and a `fill` could land on the old form; they now wait for the new page ([#16907](https://github.com/can1357/oh-my-pi/pull/16907) by [@will-bogusz](https://github.com/will-bogusz))
- With `bash.gitGuard` on, a repository that once finished a conflicted rebase no longer counts as mid-conflict forever, which had let `git checkout`, `switch` and `restore` through; branch switches such as `git checkout -B <branch> <commit>` stay refused during a real merge or rebase too, abbreviated options such as `git reset --ha` are refused like the full ones, and `git stash create` is allowed ([#16919](https://github.com/can1357/oh-my-pi/pull/16919) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the compiled `omp` binaries trusting certificates from the compromised eMudhra intermediate CAs (CVE-2026-91403) and carrying the Brotli decoder out-of-bounds write (CVE-2026-111497); release binaries now build on Bun 1.4.4 ([#16822](https://github.com/can1357/oh-my-pi/issues/16822), [#16865](https://github.com/can1357/oh-my-pi/pull/16865) by [@bse-ai](https://github.com/bse-ai))
- Fixed TTSR rule matching slowing down quadratically on long tool calls such as `bash`, `eval` or `task` arguments: their streamed JSON escapes newlines, so every delta rescanned the whole argument (a 64 KB call with 10 rules took 120 ms of matching, now 4.5 ms). A long unterminated line is now rescanned as it grows by a quarter, and the final check still scans all of it ([#14248](https://github.com/can1357/oh-my-pi/issues/14248), [#16974](https://github.com/can1357/oh-my-pi/pull/16974) by [@lavinhoque33](https://github.com/lavinhoque33))
- Fixed the `eval` tool description so JS sessions see which helpers need `await` ([#16808](https://github.com/can1357/oh-my-pi/pull/16808) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed the `eval` agent and judge docs so JS sessions see which handle, pool and batch calls need `await`, and Python sessions with JS enabled see `agent()`'s `schema_mode` keyword instead of JS's `schemaMode` ([#16810](https://github.com/can1357/oh-my-pi/pull/16810) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed a classifier refusal on an Anthropic model ending the turn with the rest of an Anthropic `retry.fallbackChains` entry untried once the conversation carried signed thinking; the refusal now moves to the next model in the chain ([#17024](https://github.com/can1357/oh-my-pi/pull/17024) by [@sjawhar](https://github.com/sjawhar))
- Fixed the bash tool blocking commands such as `echo hi; make 2>build.err`, and sending `cat > file <<'EOF'` to `read` ([#17022](https://github.com/can1357/oh-my-pi/pull/17022) by [@sjawhar](https://github.com/sjawhar))
- Empty-stop retry exhaustion now reports provider usage without claiming that output was filtered or dropped, and same-model retries of content-less `MALFORMED_RESPONSE`/`UNEXPECTED_TOOL_CALL` errors inject a corrective tool-call reminder instead of replaying the identical cached prefix ([#17063](https://github.com/can1357/oh-my-pi/pull/17063) by [@martijnberger](https://github.com/martijnberger))
- Fixed automatic compaction committing summaries that increase context and repeatedly retrying the same retained-history cut point; token counts now include trailing tool results and post-compaction rescue ([#16904](https://github.com/can1357/oh-my-pi/pull/16904) by [@eggpeat](https://github.com/eggpeat))
- Fixed `/tan` dropping the images attached to its draft: the background agent now gets them with its request and keeps them, as admitted, when compaction restores the request; they leave the composer once `/tan` starts, so the next message cannot send them again, and come back with the draft when it cannot start ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed `/btw` dropping the images attached to its question: the side request now sends them, and like `/tan` they leave the composer once it starts and come back with the draft when it cannot; BTW history keeps each question's images (`images` on the RPC BTW records), so every follow-up sends them again, and a follow-up in the BTW history also takes pasted images ([#13890](https://github.com/can1357/oh-my-pi/issues/13890), [#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- `/omfg`, `/handoff` and `/cleanse` no longer run without the images attached to their draft: they keep the draft and say they take text only ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed an image pasted while an extension input hook held a submission being dropped from the next message: once the submitted images leave the composer, the images that stay are renumbered from `#1` ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed a collab guest losing the draft of a host-only command that takes its draft out of the composer on Enter (`/plan`, `/goal`, `/tan`, `/btw` and others): the draft now comes back with its images ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed a hashline `PUT` whose body repeats the line just above or below its range (or both), and is shorter than the range, silently deleting the range's other lines or writing a neighbouring line twice in Python, TypeScript and other parsed files; it is now refused, and the "too short" refusal names the lines the body leaves out ([#17028](https://github.com/can1357/oh-my-pi/pull/17028) by [@sjawhar](https://github.com/sjawhar))
- Fixed `omp gc --compress` exiting with "the event loop drained while it was still pending" on Bun 1.3.14 when a session artifact is pretty-printed JSON larger than 1 MiB, and session header probes (gc, session move and transfer) reading whole artifacts on Windows ([#15745](https://github.com/can1357/oh-my-pi/issues/15745), [#16754](https://github.com/can1357/oh-my-pi/pull/16754) by [@wolfiesch](https://github.com/wolfiesch))
- `/resume` into another session now cancels the previous session's background jobs, as `/new` does, instead of delivering their results into the resumed session and starting a turn there ([#16760](https://github.com/can1357/oh-my-pi/pull/16760) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the models config migration writing `models.yml` readable by other users on the machine, and dropping every custom provider when the write was interrupted; the migrated file is now published atomically with owner-only permissions ([#16654](https://github.com/can1357/oh-my-pi/pull/16654) by [@adi-IL](https://github.com/adi-IL))
- Fixed `/memory clear` in one project deleting the memory state of every other project that shares the same agent directory ([#16657](https://github.com/can1357/oh-my-pi/pull/16657) by [@adi-IL](https://github.com/adi-IL))
- Fixed the classic `/usage` report averaging distinct quota buckets that share a label and window (Google Antigravity's Gemini and Gemini 4 Argon weeklies) into one "50% free" row that hid the drained bucket; groups now split by quota identity while shared buckets still merge ([#16790](https://github.com/can1357/oh-my-pi/issues/16790))
- Fixed `read` of a web page failing with HTTP 403 or 429 when the site serves the page to another user agent, as SEC EDGAR filings, Ars Technica, AP News and Yahoo Finance do: a refused request now retries with the next user agent whatever its error page says ([#16593](https://github.com/can1357/oh-my-pi/pull/16593) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `grep` trimming a file to its first 20 matches in a multi-file search (200 in a single file) without telling the agent; the result now names the trimmed files and how to see the rest, and no longer reports the file total as `N+` when every file was searched ([#16594](https://github.com/can1357/oh-my-pi/pull/16594) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed isolated task capture failing with `patch does not apply: <path> does not exist` when the worker's commits leave untracked baseline files of the parent checkout untouched: the baseline work-in-progress is replayed before the worker's delta and rewound afterwards ([#16648](https://github.com/can1357/oh-my-pi/pull/16648) by [@Komzpa](https://github.com/Komzpa))
- Fixed a project-wide LSP rename corrupting files that were edited outside OMP while open: the rename now syncs every open document (not just the requested file) before the workspace edit is computed, so the server's ranges match the current disk text instead of writing the identifier into blank lines ([#15772](https://github.com/can1357/oh-my-pi/issues/15772), [#16649](https://github.com/can1357/oh-my-pi/pull/16649) by [@holny](https://github.com/holny))
- Fixed local memory stage-1 extraction sending prior assistant reasoning to Claude, causing `reasoning_extraction` refusals and lost memories ([#16679](https://github.com/can1357/oh-my-pi/issues/16679)).
- Fixed each `rewind` report being sent to the model twice (as a `Branch-return summary` and as the `Checkpoint called and rewound` report); it now appears once per checkpoint/rewind cycle, while the transcript still shows the branch summary ([#16702](https://github.com/can1357/oh-my-pi/issues/16702))
- Browser relay opens fail immediately with Chrome's reason (e.g. `Host access is restricted by policy.` on Chromium 155+ with an extension debugger policy) instead of timing out, and close the tab Chrome refused ([#16748](https://github.com/can1357/oh-my-pi/issues/16748))
- Collab guests can answer a pending question after the host reconnects to the relay without duplicated answer controls ([#16682](https://github.com/can1357/oh-my-pi/pull/16682) by [@DAnaeto](https://github.com/DAnaeto))
- Fixed `dd … of=/dev/null` (and other write-only sinks such as `/dev/stdout` and `/dev/fd/1`) triggering the unoverridable critical-command approval prompt; `dd` to real devices like `/dev/sda` still prompts ([#16714](https://github.com/can1357/oh-my-pi/issues/16714))
- Fixed Word and EPUB `read`s, site-specific web scrapers (Stack Overflow, MDN, GitLab, …) and the browser's readable page extraction writing identifiers as `snake\_case` or `DOCX\_NEEDLE\_1` (filtered plain text dropped the underscores): underscores inside words now stay literal ([#16607](https://github.com/can1357/oh-my-pi/pull/16607) by [@will-bogusz](https://github.com/will-bogusz))
- Tagging a model with `^` in a message sent while the agent is working no longer splits it in two: the model learns the new `m<N>` agent and reads your message in the same turn, instead of replying to the announcement alone first ([#16614](https://github.com/can1357/oh-my-pi/pull/16614) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed subagent model resolution skipping an authenticated later entry of the configured model list: when the first resolved model has no credentials, the remaining entries are tried in order before the parent session's model. ([#16640](https://github.com/can1357/oh-my-pi/pull/16640) by [@Komzpa](https://github.com/Komzpa))
- Fixed background job widgets rejecting percentage progress with `meter.total: 100 appears nowhere in the job or its output`; a meter may now use a total of 100 when every value feeding it was printed as a percentage ([#16885](https://github.com/can1357/oh-my-pi/pull/16885) by [@alphastorm](https://github.com/alphastorm))
- Fixed `openai-models-list` discovery leaving models that advertise their own reasoning levels (`supported_reasoning_levels` and `default_reasoning_level`, top-level or under `metadata` as codex-lb sends them) non-reasoning when the id is absent from the bundled catalog, so requests never carried `reasoning_effort` ([#16650](https://github.com/can1357/oh-my-pi/pull/16650) by [@Komzpa](https://github.com/Komzpa))
- Fixed marketplace auto-update leaving cloned checkouts behind after startup errors; abandoned clones are removed on a later refresh ([#16693](https://github.com/can1357/oh-my-pi/issues/16693))
- Fixed an extension's idle `pi.sendMessage({ display: true }, { deliverAs: "nextTurn", triggerTurn: false })` clearing and replaying the whole transcript, which froze input for longer as the session grew; the message is now appended to the existing transcript ([#16744](https://github.com/can1357/oh-my-pi/pull/16744) by [@OriginalByteMe](https://github.com/OriginalByteMe))
- Fixed `app.target` rejecting CDP page ids, including fresh `about:blank` pages, and added ids to unmatched-target listings ([#16619](https://github.com/can1357/oh-my-pi/issues/16619))
- Fixed reading `proc://<id>/kill` or `proc://<id>/mode` answering only "writable only", so agents often moved on with the job still running; the error now names the `write` call that cancels the job or sets the mode, with the real id ([#16580](https://github.com/can1357/oh-my-pi/pull/16580) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `history://<id>` failing with "has no transcript: session is gone" for a worker that is still running but has not created its session or transcript file yet; it now answers "No transcript has been written yet". ([#16645](https://github.com/can1357/oh-my-pi/pull/16645) by [@Komzpa](https://github.com/Komzpa))
- Fixed the `eval` tool telling sessions with only the Python runtime to call `tool.<name>(args)` without `await`, which returns a coroutine and never runs the tool ([#16578](https://github.com/can1357/oh-my-pi/pull/16578) by [@will-bogusz](https://github.com/will-bogusz))
- Task subagents on models that opt into shared prompt caching now share one cache key with their same-type siblings, even when the parent runs another model or the child switches models later; `/compact` and auto-compaction use that key against the model the compaction request actually sends, and keep the session's own id when no key applies ([#16988](https://github.com/can1357/oh-my-pi/pull/16988) by [@rafalopilowski1](https://github.com/rafalopilowski1))
- Fixed `omp auth-broker serve` token refreshes that hang continuing past the refresh deadline and keeping other refreshes of that credential waiting: the deadline now cancels the token request ([#16291](https://github.com/can1357/oh-my-pi/pull/16291) by [@will-bogusz](https://github.com/will-bogusz))
- The advisor docs now say a quota-paused advisor resumes only when its runtime is reset or rebuilt (compaction, a session switch, `/advisor`, a config reload or a restart), not after a cooldown ([#16766](https://github.com/can1357/oh-my-pi/pull/16766) by [@will-bogusz](https://github.com/will-bogusz))
- The `power.sleepPrevention` setting now says it keeps the machine awake only while the agent is running a turn, not for as long as a session is open ([#16762](https://github.com/can1357/oh-my-pi/pull/16762) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the `computer` tool's `computer.window({ app })` failing for an app with no open window without saying what to do; the error now names the `computer.apps.open(…)` call that launches it (on macOS it also shows a window of a running app that has none), and `computer.window()` with no argument asks for a window id or filter instead of listing windows that "match undefined" ([#16912](https://github.com/can1357/oh-my-pi/pull/16912) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read doc.pdf:page<N>.png` returning the PDF viewer's empty grey frame instead of the page on about half of reads ([#16585](https://github.com/can1357/oh-my-pi/pull/16585) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the `computer` tool prompt leaving `el.selectText` out of the element helpers; it now says a following `el.type` on that element replaces the selection ([#16769](https://github.com/can1357/oh-my-pi/pull/16769) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed language servers keeping every file omp ever opened loaded for the whole session; files unused for 5 minutes are now closed when omp opens another, so the server can free that memory ([#15418](https://github.com/can1357/oh-my-pi/pull/15418) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `write` turning a CRLF file into LF and dropping its UTF-8 BOM when it replaces the file; it now keeps both, as `edit` does ([#16575](https://github.com/can1357/oh-my-pi/pull/16575) by [@will-bogusz](https://github.com/will-bogusz))

## [18.12.6] - 2026-10-21

### Added

- Added the `_session/steering` ACP extension (advertised as `_meta.steering.supported`), so clients such as agent-shell can steer a running turn; a steer sent while a permission dialog is open cancels that dialog, and `_meta.steering.queue: "followUp"` queues a follow-up instead ([#15885](https://github.com/can1357/oh-my-pi/pull/15885) by [@marcintustin](https://github.com/marcintustin))
- `/mcp reauth <name>` now works over ACP, RPC, and print mode (`omp -p '/mcp reauth <name>'`): it opens the browser, prints the authorization URL, reconnects the server in the running session, and print mode exits 1 when reauthorization fails ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))

### Changed

- ACP `session/cancel` now also cancels prompts that are queued or still dispatching, and stops autonomous runs, instead of being ignored when no client turn is streaming ([#15885](https://github.com/can1357/oh-my-pi/pull/15885) by [@marcintustin](https://github.com/marcintustin))
- Idle compaction no longer runs on logged-in OpenAI Codex accounts, whose prompt cache never expires; compacting while idle only threw away a warm cache
- ACP sessions no longer fail to start when a client-declared MCP server cannot connect; the failure is reported in the session, and an HTTP/SSE server can be repaired with `/mcp reauth` ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))
- `/mcp reauth`, `/mcp test`, and `/mcp unauth` now pick the project entry when a server is defined in both project and user config, and skip project config when `mcp.enableProjectConfig` is off ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))
- `/mcp reauth` removes the server's stale `Authorization` header from its config when it writes the new OAuth binding ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))
- `omp -p '/compact'`, `/handoff`, and `/retry` given as CLI arguments now run the command instead of sending the text to the model, and exit 1 when the command fails; slash text arriving on stdin or from `@file` is still sent to the model ([#16387](https://github.com/can1357/oh-my-pi/pull/16387) by [@marcintustin](https://github.com/marcintustin))
- Interactive startup no longer waits for extensions that register only tools, commands, flags, renderers, or event hooks (for example MCP bridge plugins): they load once the composer accepts input, and your first message waits for them instead. An extension is deferred only after one launch has confirmed it registers no providers, shortcuts, composer shapes, or file fallbacks. Launches that resume a session, pass `--tools`, or pass flags omp does not recognize still load every extension first ([#16684](https://github.com/can1357/oh-my-pi/pull/16684) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed subagents whose role has an explicitly empty fallback chain falling back through the `default` chain when the default role uses the same model, including after a retry fallback, prewalk or context promotion briefly switched models or the subagent was revived ([#16548](https://github.com/can1357/oh-my-pi/pull/16548) by [@eggpeat](https://github.com/eggpeat))
- Fixed `/usage` and `omp usage --json` listing identity-less OAuth accounts such as Devin as missing usage beside their working reports ([#16549](https://github.com/can1357/oh-my-pi/pull/16549) by [@eggpeat](https://github.com/eggpeat))
- Fixed releasing or reaping a browser tab returning while Chromium still listed the page; the close now waits until Chromium reports the tab destroyed ([#16680](https://github.com/can1357/oh-my-pi/pull/16680) by [@H4vC](https://github.com/H4vC))
- Fixed the advisor prompt forbidding all repeated advice, including real escalations: advisors may now re-raise a prior nit or concern as a blocker once new evidence makes it one ([#13887](https://github.com/can1357/oh-my-pi/issues/13887), [#16484](https://github.com/can1357/oh-my-pi/pull/16484) by [@pjh890321](https://github.com/pjh890321))
- Fixed Esc no longer interrupting in the TUI after a second MCP OAuth login replaced an unfinished first one ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))

## [18.12.5] - 2026-10-21

### Added

- `providers.cacheRetention: long` now keeps OpenAI GPT-5.6+ prompt caches for 12 hours (Responses API; cache writes cost 2.5× input instead of 1.25×)

### Fixed

- Fixed subagents spawning at a caller-supplied `effort` (e.g. `hi` → `max`) while `task.enableEffort` is off; the field is now ignored and the agent's configured thinking level (including `:auto`) applies ([#16402](https://github.com/can1357/oh-my-pi/issues/16402))
- Fixed `omp update --check` failing against JFrog Artifactory registries that add empty `dist-tags` to a tagged manifest; the update check now uses the registry's curated latest version ([#16375](https://github.com/can1357/oh-my-pi/issues/16375))
- Fixed `<path>:conflicts` on a file past the 10 MiB scan cap reporting no conflicts with no hint: it now names the line the scan stopped at and the ranged `read` that registers the blocks after it ([#16269](https://github.com/can1357/oh-my-pi/pull/16269))
- Fixed the `ts-set-map` rule stalling tool-call streaming for seconds on a long single-line `Map` literal, and missing `Map` entries written `["key", value] as const` ([#16242](https://github.com/can1357/oh-my-pi/pull/16242))
- Fixed the `ts-import-type` rule missing inline type imports whose member name is non-ASCII, such as `import("./units").温度` ([#16242](https://github.com/can1357/oh-my-pi/pull/16242))

## [18.12.4] - 2026-10-20

### Added

- `bash` tool commands now see `PI_SESSION_ID` and `PI_SESSION_FILE`, so a script can find the running session's ID and transcript path ([#16442](https://github.com/can1357/oh-my-pi/pull/16442) by [@johnrichardrinehart](https://github.com/johnrichardrinehart) and [@will-bogusz](https://github.com/will-bogusz))
- Added GitLab merge request support to `/review` and `/annotate code-review`: pass an MR URL, pick one mentioned in the conversation, or choose "Review a specific PR/MR" in a GitLab checkout to list open MRs (requires `glab`); large MRs link per-file diffs through the new `mr://<host>/<group>/<project>/<iid>/diff` URLs ([#16361](https://github.com/can1357/oh-my-pi/pull/16361) by [@Shadorain](https://github.com/Shadorain))
- Added MCP tool progress: `tools/call` requests ask the server for `notifications/progress` when the progress can be shown, and updates appear in the running tool card and as an in-place `mcp_progress` status line in Eval cells, including after auto-backgrounding; request deadlines and Eval timeouts are unchanged ([#16431](https://github.com/can1357/oh-my-pi/pull/16431) by [@alphastorm](https://github.com/alphastorm))
- Added image attachments to single and batch eval `judge()`/`judge_batch()` calls (local paths or embedded images); image judgments skip candidates without image support and fail explicitly instead of dropping images ([#15471](https://github.com/can1357/oh-my-pi/pull/15471) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Added a job tree to `/jobs`, `/jobs full` and the jobs pill's sheet, in the terminal UI and over ACP: subagents' background jobs now appear nested under the task that runs them, with the busiest branches listed first; only your own jobs offer Cancel ([#15854](https://github.com/can1357/oh-my-pi/pull/15854) by [@H4vC](https://github.com/H4vC))
- Added `ctx.ui.getEditorComponent()` so extensions can wrap the active custom editor factory instead of replacing it ([#8655](https://github.com/can1357/oh-my-pi/pull/8655) by [@jovi-tsx](https://github.com/jovi-tsx))
- `omp auth-gateway serve` and `check` can be limited to the providers and API keys the account-pool file allows, using `"*": false` and `"apiKeys": false` ([#14235](https://github.com/can1357/oh-my-pi/pull/14235) by [@will-bogusz](https://github.com/will-bogusz))
- `omp usage` shows an account's `reclaimAbovePct` next to its priority and reserve ([#14237](https://github.com/can1357/oh-my-pi/pull/14237) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- An agent that messages another agent can now `wait` for the reply instead of erroring; the wait ends early, without an error, once the agent asked finishes its turn without replying or is itself waiting on the caller's result ([#16445](https://github.com/can1357/oh-my-pi/pull/16445) by [@will-bogusz](https://github.com/will-bogusz))
- Built-in style rule reminders no longer tell the model a user-defined rule matched and it MUST comply; they ask it to check its code against the rule and its exceptions, so models rewrite code a built-in rule allows less often ([#16420](https://github.com/can1357/oh-my-pi/pull/16420) by [@will-bogusz](https://github.com/will-bogusz))
- `read` of a SQLite `?q=SELECT …` query now accepts `&limit=` and `&offset=` and pages the query's rows, as table reads and JSON `?q=` reads already do, instead of rejecting the read ([#16444](https://github.com/can1357/oh-my-pi/pull/16444) by [@will-bogusz](https://github.com/will-bogusz))
- Agents using the `browser` tool are steered to wait for the text, URL or element they need after a click or navigation instead of sleeping a fixed time, which can finish steps sooner on pages that load content after a variable delay ([#16404](https://github.com/can1357/oh-my-pi/pull/16404) by [@will-bogusz](https://github.com/will-bogusz))
- The pinned Subagents list shows how many agents are running and the agent hub key, and previews an agent's assignment at full width instead of the first 40 characters of its prompt template ([#16486](https://github.com/can1357/oh-my-pi/pull/16486) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed auto-QA reports whose tool is a URI (`xd://tui: …`) being filed under the wrong tool name; a one-line report without `: ` after its tool name is now refused with the format hint ([#16278](https://github.com/can1357/oh-my-pi/pull/16278) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed agents guessing `conflict://<N>` ids for merge conflicts a ranged `read` didn't show: the warning and the not-found error now point to `<path>:conflicts` to register them ([#16269](https://github.com/can1357/oh-my-pi/pull/16269) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed agents opening your own Chrome through the relay (with `browser.relay` on) when they asked the `browser` tool for Chromium with `app.tern: false`; the tool now points them to `app.relay: false` ([#16294](https://github.com/can1357/oh-my-pi/pull/16294) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `%pip install` in Python eval failing with "No module named pip" when the kernel's interpreter is a venv without pip, such as one made by `uv venv`: it now installs pip into that venv first, with `ensurepip` or, where that is unavailable, `uv` ([#16300](https://github.com/can1357/oh-my-pi/pull/16300) by [@will-bogusz](https://github.com/will-bogusz))
- Reduced HTTP 413 failures on Factory Droid once a session's screenshots and pasted images pass Factory's 4.5 MB request limit: older inline images are now dropped to keep them under 3.5 MB, while the newest message's and newest tool result's images stay when they alone fit the limit; a custom gateway `baseUrl` is left alone ([#16288](https://github.com/can1357/oh-my-pi/pull/16288) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed hashline edits under an older tag overwriting the wrong line when their line numbers came from `grep -n`, `sed -n` or a `:raw` read: a shifted edit whose body matches the current line at those numbers, or that breaks the file's syntax, is now rejected with the current tag and lines ([#16383](https://github.com/can1357/oh-my-pi/pull/16383) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `PI_SESSION_FILE` in `eval` cells being a relative path when omp was started with a relative `--session-dir` (or `PI_CODING_AGENT_SESSION_DIR`), so it no longer worked once code changed directory ([#16442](https://github.com/can1357/oh-my-pi/pull/16442) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed waking a parked subagent re-sending its whole conversation without the prompt cache whenever other agents had started, finished or parked meanwhile ([#15523](https://github.com/can1357/oh-my-pi/issues/15523)) ([#16369](https://github.com/can1357/oh-my-pi/pull/16369) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `edit` accepting changes to lines nothing showed after a stale or unknown tag: a resend under the current tag from the rejection now passes the seen-line check only on the rows that rejection printed (or a retained `read` showed), so a line seen only through `bash` is no longer overwritten blind ([#16422](https://github.com/can1357/oh-my-pi/pull/16422) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed plugin settings marked `secret` being readable by other local users in `omp-plugins.lock.json`; the lockfile is now written owner-only (0600) ([#12999](https://github.com/can1357/oh-my-pi/issues/12999), [#16368](https://github.com/can1357/oh-my-pi/pull/16368) by [@jonasboos](https://github.com/jonasboos))
- Fixed agents misreading `computer.windows()` results on their first call ([#16299](https://github.com/can1357/oh-my-pi/pull/16299) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed GitLab merge request reads rendering `[object Promise]` instead of the description ([#16477](https://github.com/can1357/oh-my-pi/pull/16477) by [@adi-IL](https://github.com/adi-IL))
- Fixed `/restart` losing the active named profile and failing to resume its session ([#15742](https://github.com/can1357/oh-my-pi/pull/15742) by [@sapran](https://github.com/sapran))
- Fixed aborted and timed-out stdio MCP requests continuing to run on the server: OMP now sends `notifications/cancelled` with the original request id, once and never for `initialize`, after settling the call and without waiting on the pipe ([#16430](https://github.com/can1357/oh-my-pi/pull/16430) by [@alphastorm](https://github.com/alphastorm))
- Fixed the agent restarting on its own after you stopped it with Esc whenever a background subagent or job finished; the result is recorded in the transcript and the agent waits for your next message
- Fixed Mnemopi memory completions ignoring the memory role's thinking suffix, including one inherited from `tiny` or `smol` when `modelRoles.memory` is unset; each `retry.fallbackChains.memory` entry sends its own level, and `:off` disables reasoning ([#16378](https://github.com/can1357/oh-my-pi/pull/16378) by [@alphastorm](https://github.com/alphastorm))
- Fixed MCP tools running a call twice when the server connection dropped mid-request: a stdio request already written to the server, or an HTTP or legacy SSE request whose connection reset or closed after it was sent, now fails as non-retryable with a diagnostic saying it may have run, instead of being replayed after a reconnect; requests that never left OMP, including refused connections, still reconnect and retry once ([#16429](https://github.com/can1357/oh-my-pi/pull/16429) by [@alphastorm](https://github.com/alphastorm))
- Fixed `/move` path completion jumping into a subfolder on Tab: `..`, `.`, and `~` now complete to `../`, `./`, and `~/` before listing their children, a trailing `\` lists a folder on Windows, absolute Windows paths (`C:/…`) are no longer rewritten as relative paths, and the project directory is offered as `./` instead of `/`
- Fixed `edit` blaming boundary indentation when a one-row replacement only fails because its body ends with a trailing comma (e.g. the last element of a JSON array); the error now names the comma ([#16423](https://github.com/can1357/oh-my-pi/pull/16423) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a timed-out browser selector action dropping its match count without a word when omp could not count the matches; the error now says why ([#16389](https://github.com/can1357/oh-my-pi/pull/16389) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed every session in a project without `.vscode/mcp.json` logging a "[VS Code] Failed to read …/.vscode/mcp.json" warning; a missing file is now skipped silently, while an unreadable or unparsable one still warns ([#16434](https://github.com/can1357/oh-my-pi/pull/16434) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed agents opening pages in your own signed-in Chrome when `browser.relay` is on and you asked for a throwaway browser ([#16390](https://github.com/can1357/oh-my-pi/pull/16390) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `ts-no-tiny-functions` and `ts-promise-with-resolvers` rules reminding you about code they allow: exported functions, public class and object members, type guards, `if`/`try`/`catch` blocks, and never-settling `new Promise(() => {})` ([#16419](https://github.com/can1357/oh-my-pi/pull/16419) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` losing the last lines of a comma list that pairs ranges with a tail (`file:1-30,-30`, `file:1-30,:-30`), and erroring on the same list for `artifact://` and other internal URLs; both parts are now read ([#16435](https://github.com/can1357/oh-my-pi/pull/16435) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `edit` rejecting a placeholder tag (`#AUTO`, `#????`), a missing tag, or a header with no ops without naming the file's current tag; these now get the same reply as an unknown tag, so the retry can use that tag instead of a `read` ([#16425](https://github.com/can1357/oh-my-pi/pull/16425) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` line ranges and tails (`:9-11`, `:-50`) of macOS `.sample.txt` reports and `.cpuprofile` files returning lines of the generated profile summary instead of the file, so edits from them were rejected as stale; the summary now appears only on a whole-file read, without line numbers ([#16397](https://github.com/can1357/oh-my-pi/pull/16397) by [@will-bogusz](https://github.com/will-bogusz))
- Models whose provider strips images from requests, such as DeepSeek V4 Flash on Venice or NanoGPT, now get text compaction and text-only image handling like text-only models; snapcompact archived onto frames that reached them as `[image omitted]` placeholders, and history images were still processed and uploaded before being dropped ([#16436](https://github.com/can1357/oh-my-pi/pull/16436) by [@will-bogusz](https://github.com/will-bogusz))
- Line range reads of `ssh://`, URLs and other in-memory resources no longer return only the line above the range when that line fills the 50KB budget; the page now starts at the requested line, and byte-limit notices state the 50KB limit instead of the bytes shown ([#16391](https://github.com/can1357/oh-my-pi/pull/16391) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Auto-QA grievances sharing your home directory and login name with the qa.omp.sh collector; paths under your home are sent as `~/…`, and the login name inside labels and paths as `<user>`, including reports recorded before this fix ([#16409](https://github.com/can1357/oh-my-pi/pull/16409) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the `computer` tool's `control.acquire` prompt, left unanswered, failing the whole call with "Computer code execution timed out"; the prompt now expires shortly before the timeout and the call returns `reason: "unanswered"` ([#16388](https://github.com/can1357/oh-my-pi/pull/16388) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed reads whose optional leading context line exceeded the byte budget returning only the oversized-line notice or a preview of that context line and hiding the requested lines; the read now retries from the requested start without leading context ([#16485](https://github.com/can1357/oh-my-pi/pull/16485) by [@adi-IL](https://github.com/adi-IL)).
- Fixed `read path:N:raw` (and `:raw:N`, URLs included) returning a page from line `N` instead of the one line `N`; `grep` on internal and web URLs now filters `:N:raw` to that line too, and `:N-:raw` still runs on from `N` ([#16438](https://github.com/can1357/oh-my-pi/pull/16438) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Anthropic web search answers breaking into separate paragraphs at every citation, with sentences split mid-way and lines starting with `.` ([#16396](https://github.com/can1357/oh-my-pi/pull/16396) by [@a-glapinski](https://github.com/a-glapinski))
- Fixed custom tools that import an `@oh-my-pi/*` package (such as `@oh-my-pi/pi-natives` or `@oh-my-pi/pi-utils`) failing to load with "Cannot find package" in the installed `omp` binary; they now get the host's copy, as extensions already did ([#16421](https://github.com/can1357/oh-my-pi/pull/16421) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed resuming a session selecting an abandoned branch after a late off-branch entry such as a background bash result; off-branch entries now record the active leaf they interrupted and replay restores it ([#16483](https://github.com/can1357/oh-my-pi/pull/16483) by [@adi-IL](https://github.com/adi-IL)).
- Fixed hashline `REM` deleting and `MV` moving a file under an invented or stale tag; a bare file op now needs the file's current tag, like a line edit ([#16381](https://github.com/can1357/oh-my-pi/pull/16381) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `write` deleting the leading numbers of every line in content such as hex dumps, disassembly and timestamped logs; it now removes copied `read` line numbers only when they count up by one, as `read` and `grep` print them ([#16441](https://github.com/can1357/oh-my-pi/pull/16441) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `auto` thinking chosen for the DEFAULT role in the `/model` hub reverting to the model's default effort (e.g. `max` on Z.AI `glm-5.3`) on the next launch ([#16370](https://github.com/can1357/oh-my-pi/issues/16370), [#16398](https://github.com/can1357/oh-my-pi/pull/16398) by [@alvadorn](https://github.com/alvadorn))
- Fixed Google Antigravity web search failing with false 429 quota-exhausted errors ([#11849](https://github.com/can1357/oh-my-pi/pull/11849) by [@jotafurtado](https://github.com/jotafurtado))
- Fixed omp exiting to the shell when the model picker (Alt+P) or model hub opened after compatibility extensions loaded ([#12293](https://github.com/can1357/oh-my-pi/issues/12293), [#12653](https://github.com/can1357/oh-my-pi/pull/12653) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed todo lists set over RPC `set_todos` disappearing when the session is reloaded, resumed, or compacted; `RpcClient.setTodos()` sends the command ([#12590](https://github.com/can1357/oh-my-pi/pull/12590) by [@anthonyrisinger](https://github.com/anthonyrisinger))
- Fixed batch `task` calls silently running the default agent when a specialist such as `reviewer`, `scout`, or a custom agent was set at the top level instead of in `tasks[].agent`; the call is now rejected with that guidance ([#12610](https://github.com/can1357/oh-my-pi/pull/12610) by [@dbc-hbin](https://github.com/dbc-hbin))
- Fixed sessions started before an omp upgrade losing word completion and restarting the shared word-completion daemon every 30 seconds, which reloaded its model for every session on the new version; they now use the newer daemon ([#15610](https://github.com/can1357/oh-my-pi/issues/15610)) ([#16380](https://github.com/can1357/oh-my-pi/pull/16380) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed supported Bedrock Claude models falling back to soft instead of remote compaction ([#16343](https://github.com/can1357/oh-my-pi/pull/16343) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed browser `tab.run(fn, [url])` and `browser.open("https://…")` failing with a bare "expects an options object"; the errors now say to pass `{ args: [...] }` and `browser.open({ url, name })` ([#16236](https://github.com/can1357/oh-my-pi/pull/16236) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `ts-set-map`, `ts-import-type` and `ts-no-any` rules reminding you about code they allow: an empty or computed `Set`/`Map`, a runtime `await import()`, or the word "any" in a comment ([#16242](https://github.com/can1357/oh-my-pi/pull/16242) by [@will-bogusz](https://github.com/will-bogusz))

## [18.12.3] - 2026-10-19

### Added

- Added the **Ask and remember** approval mode (`tools.approvalMode: always-ask-cached`, `--approval-mode always-ask-cached`): it also asks before file reads, and file prompts can remember the folder or the file, for this session or across sessions, through `approval-cache.db` ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- Added `/forget-approvals` to forget every file and folder approval Ask and remember has recorded ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- Extension `ui.approve()` hosts can render the new `prompt.grants` choices and answer `{ grant, always }`; hosts that ignore them keep answering `once`/`session`/`deny` ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- Extension and custom tools can declare `approvalCacheTargets` to take part in Ask and remember grants ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- Added `proc://<id>/streams` for bash jobs: it lists the command's pipes, and `proc://<id>/streams/<n>` shows what has crossed pipe `n` so far, so `cmd | tail -5` can be followed live without rerunning `cmd`
- Background job widgets are designed per job by the new `widget` model role (resolves like `smol` until you assign it): one request writes rules that read the job's output and its pipes (`cmd | tail` included), and every later update is computed locally with no further model calls or messages to the agent; a subagent gets a widget only once it says which output shows its progress, and a job with nothing worth charting gets none; turn them off with `async.widgets: false`
- Running subagents now show their current step, in their own words, on the task card; the periodic completion check also asks the subagent which output shows its progress, so the job widget knows what to chart
- The `wait` card shows the watched jobs as a row of tiles, each with its status, name (a subagent's in full), what it is doing, and its headline figure and live widget when it has one (a throughput chart with its target line, per-model bars, CI job status, trial progress), and a subagent's own completion estimate as a ring that turns from blue to green as it fills (hover the tile for the percentage); the HUD jobs pill shows the freshest job's headline and a mini chart, and hovering it opens a card with the running jobs as tiles; the jobs sheet shows the selected job's widget above its output, and the terminal status line appends the headline to the jobs count

### Changed

- While a subagent is focused, `/model`, `/switch`, `/effort`, `Alt+P`, `Ctrl+P`, and `Shift+Tab` change that subagent's model and thinking level (session-only) instead of telling you to return to the main session; `/model` and `Alt+M` open the session-only picker there, since role assignments configure the main session

### Fixed

- Fixed `omp skill list` omitting skills from a `skills.customDirectories` entry that starts with `~`; such an entry now resolves against your home directory, matching the skill loader ([#16347](https://github.com/can1357/oh-my-pi/pull/16347) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed `grep` treating a `;`-separated list of internal URLs (e.g. `artifact://44;artifact://43`) as one URI and refusing to search it; every listed resource is now searched ([#14091](https://github.com/can1357/oh-my-pi/issues/14091))
- Fixed `grep` refusing a web URL that carries a `:raw` (or `:conflicts`) selector before the page was fetched; the selector now reaches the fetch, so `:raw` searches the verbatim response body ([#14092](https://github.com/can1357/oh-my-pi/issues/14092))
- Fixed browser `role/<role>[name="…" exact]` selectors in Chromium and Tern tabs matching nothing for many names copied from `observe()`; a button or link with visible text is no longer matched by its `title` ([#16252](https://github.com/can1357/oh-my-pi/pull/16252) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/tan` clones with Mnemopi auto-recall re-sending the parent's recalled memories as an extra system-prompt block, which duplicated them and missed the parent's prompt cache ([#16337](https://github.com/can1357/oh-my-pi/issues/16337))
- Fixed legacy pi extensions that import `contentText` from pi-ai or `formatSkillsForPrompt` from pi-coding-agent, such as `pi-claude-bridge`, failing to load ([#16313](https://github.com/can1357/oh-my-pi/pull/16313) by [@Jerryx333](https://github.com/Jerryx333))
- Fixed legacy Pi plugins such as `pi-ssh-remote` crashing at session start when reading shell settings through `SettingsManager` ([#16256](https://github.com/can1357/oh-my-pi/issues/16256))
- Fixed newly authenticated models missing from the current session's scoped `/model` picker and model cycle after login, including setup-wizard sign-in, without changing the active model or widening the configured scope ([#16234](https://github.com/can1357/oh-my-pi/pull/16234) by [@lazy1523](https://github.com/lazy1523))
- Fixed the `computer` tool's `control.acquire` returning the same `{ active: false }` when nobody could be asked (a subagent or headless run) as when you declined; it now reports `reason: "no-ui"` or `reason: "denied"` ([#16295](https://github.com/can1357/oh-my-pi/pull/16295) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a browser screenshot waiting past its deadline when Chrome was slow to open a DevTools session; it now stops at the deadline ([#16230](https://github.com/can1357/oh-my-pi/pull/16230) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a parked subagent waking up with the `todo` tool and its instructions when messaged, though subagents are spawned without them ([#16281](https://github.com/can1357/oh-my-pi/pull/16281) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `wait` failing with "Skipped due to a queued background completion" when the job it was waiting for had just finished; it now returns that job's result, and a steer, peer message or aside arriving at the same moment no longer turns a settled job or waiting peer message into that skip ([#16301](https://github.com/can1357/oh-my-pi/pull/16301) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the second of two extension asides (`pi.sendMessage(…, { deliverAs: "aside" })`) sent together to an idle session being lost; it now reaches the agent after the first ([#16292](https://github.com/can1357/oh-my-pi/pull/16292) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed every idle agent woken by an `agent://all` broadcast answering the sender automatically, mostly to say the message was not for it; a direct message still gets the woken agent's turn back ([#16312](https://github.com/can1357/oh-my-pi/pull/16312) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a subagent woken by an IRC message sending its waker and parent every line of text it wrote that turn run together (`Checking.Answer.`) instead of just its final answer ([#16302](https://github.com/can1357/oh-my-pi/pull/16302) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a parent follow-up sent while a peer-woken subagent was running leaving the accepted `agent://` result unchanged and skipping the parent's completion ([#16305](https://github.com/can1357/oh-my-pi/issues/16305))
- Fixed `yield` reporting success while silently omitting unsupported root fields; such calls are now rejected with an error naming the fields ([#16317](https://github.com/can1357/oh-my-pi/issues/16317))
- Fixed `brew install` and `brew upgrade` of omp failing with a 403 behind corporate proxies ([#16264](https://github.com/can1357/oh-my-pi/pull/16264) by [@debanjanbasu](https://github.com/debanjanbasu))
- Fixed browser timeouts in the release binary surfacing as raw errors such as `Og: Navigation timeout of 7000 ms exceeded`; a timed-out `tab.goto` or `browser.open` now stops the pending load and keeps the tab, as running from source did ([#16266](https://github.com/can1357/oh-my-pi/pull/16266) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `find`, `glob` and `ast_grep` always refusing `ssh://` paths with "ssh:// access needs exec approval; this command was approved at read": they now ask for `exec` approval like `read` and `grep` do ([#16285](https://github.com/can1357/oh-my-pi/pull/16285) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a `conflict://*` write of per-id lines with literal values (`1: foo`, `2: bar`) writing all of them into every conflict block and reporting success; it now fails without touching the file and points to per-block `conflict://<N>` writes ([#16267](https://github.com/can1357/oh-my-pi/pull/16267) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed hashline block edits (`PUT N*:`, `CUT N*`) applying over block lines a `read` never fully showed, such as a line cut at the column cap, which silently dropped that line's tail; they are now rejected like the equivalent explicit range ([#16209](https://github.com/can1357/oh-my-pi/issues/16209))
- Fixed a resumed session's next snapcompact compaction losing the newest archived history once the archive passed 500k characters, and drawing `[Session persistence truncated large content]` into its frames; the archive's source text is now saved whole ([#16282](https://github.com/can1357/oh-my-pi/pull/16282) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/compact`, `/new` or a session switch during a running tool dropping that tool's result from the session file, so the model and a resumed session saw "No result provided" instead of what the tool returned ([#16241](https://github.com/can1357/oh-my-pi/pull/16241) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` middle-eliding large file pages into an artifact; a page past the output spill threshold now stops at a line boundary with an exact `:N` continuation ([#16277](https://github.com/can1357/oh-my-pi/issues/16277))
- Fixed an edit after a restart replacing a line that `read` or `grep` had shown cut at the column cap and silently dropping the rest of that line; such edits now ask for a full `:raw` read of the line first, while edits to lines within the cap still apply ([#16171](https://github.com/can1357/oh-my-pi/issues/16171))
- Fixed Enter on an unknown slash command such as `/not-a-command` running a command whose description happened to match it (e.g. `/loop`, which then resent every later prompt after each turn); Enter now sends what you typed, including as the deny-and-steer message for a pending tool approval, unless you select a suggestion first ([#16265](https://github.com/can1357/oh-my-pi/issues/16265))
- Fixed `read` of web pages dropping collapsed sections such as accordion and expander panels (e.g. a product page's "Item details" table); content in `<template>`, `<noscript>` and scripts stays out ([#16246](https://github.com/can1357/oh-my-pi/issues/16246))
- Fixed `/mcp reauth` and `/mcp add` opening an unrelated origin-root authorization server's login page when the authorization server an MCP server advertises in its protected-resource metadata has invalid metadata; discovery now uses only the advertised servers and reports the issuer mismatch naming the server ([#16339](https://github.com/can1357/oh-my-pi/issues/16339))
- Fixed auto thinking offering the judge effort levels the current model does not support, which could leave a sparse-ladder model on the wrong level; with at most one usable level under the ceiling it now skips the judge call ([#16327](https://github.com/can1357/oh-my-pi/pull/16327) by [@savanne-kham](https://github.com/savanne-kham))
- Fixed subagents that were cancelled, interrupted, timed out, or killed refusing messages as "hard-aborted and cannot be messaged or revived": a message (or Agent Hub revive/focus) now resumes them from their transcript with full context
- Fixed interrupting a focused subagent to send it a queued message (empty Enter) sometimes ending its run as cancelled before it read the message; the subagent now answers the message and keeps working
- Fixed sessions whose first reply starts with a todo plan getting a title without its icon and code: the plan's title refresh no longer replaces the card title that is still being generated
- Fixed generated titles that come out without an icon and code (a subagent's title, a title-model fallback, a malformed card reply) staying plain: they now get a card like `/rename` titles do
- Fixed running the test suite adding fixture titles (`PLAN`, `renamed session`, …) to your real `~/.omp/agent/history.db`

## [18.12.2] - 2026-10-18

### Added

- Added `computer.backgroundFallback` (`takeover` by default, or `refuse`): when a `computer` window input call has no background route, the tool reruns that one call in takeover, hands focus back to your app and says so in its result; `refuse` fails the call instead and also refuses the agent's own foreground requests (`takeover: true`, `raise()`, an activating `apps.open`, desktop input, and on macOS menus and `AXOpen`) ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Added DeepSeek as a web search engine (`web/deepseek`), using DeepSeek's new Search API with your existing `DEEPSEEK_API_KEY` or stored `deepseek` credential
- Added `el.selectText(text, { prefix?, suffix?, select? })` to the macOS `computer` tool: it selects text (or places a caret) in a background app's text field without taking focus, moving the pointer or sending keys, so typing into that field replaces it ([#15175](https://github.com/can1357/oh-my-pi/pull/15175) by [@will-bogusz](https://github.com/will-bogusz))
- Added `{ takeover: true }` to computer-use `win.move`, so a hover that a window refuses in the background can be retried in the foreground ([#15173](https://github.com/can1357/oh-my-pi/pull/15173) by [@will-bogusz](https://github.com/will-bogusz))
- Added a `menu` option to the `computer` tool's `win.click`, `el.click`, `el.press` and `el.perform`, so on macOS the call that opens a menu also chooses its item, e.g. `menu: ["Add to", "Fonts"]` ([#15185](https://github.com/can1357/oh-my-pi/pull/15185) by [@will-bogusz](https://github.com/will-bogusz))
- Added `el.type(text)` and `el.press(chord)` to the `computer` tool, which send text and keys to that element instead of wherever its window's focus is; on macOS and Windows nothing is sent when the element cannot be addressed without taking your focus ([#15563](https://github.com/can1357/oh-my-pi/pull/15563) by [@will-bogusz](https://github.com/will-bogusz))
- Added: pressing Escape during takeover input now stops computer use for the rest of the turn, and that session's later `computer` calls are refused, unsent, until your next message ([#15564](https://github.com/can1357/oh-my-pi/pull/15564) by [@will-bogusz](https://github.com/will-bogusz))
- Added the `computer` tool's `UserIntervened` error on macOS: input into an app you have used since the agent last read its window fails without sending, and the agent is told to read the window again and keep your edits ([#15562](https://github.com/can1357/oh-my-pi/pull/15562) by [@will-bogusz](https://github.com/will-bogusz))
- Added `tui.completeScrollback`: rows a growing HUD or dialog pushes off screen go straight to scrollback instead of missing from it until it shrinks ([#15692](https://github.com/can1357/oh-my-pi/pull/15692) by [@Ilm-Alan](https://github.com/Ilm-Alan))

### Changed

- The `computer` tool and its errors no longer tell the model to retry with `takeover: true`, and its instructions tell it never to call `raise()` or `apps.open(…, { activate: true })` to make input work ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Computer-use window input with `takeover` omitted now stays in the background after `computer.control.acquire`, so an acquired grant no longer activates the target app or moves the user's pointer; pass `takeover: true` for foreground input ([#15173](https://github.com/can1357/oh-my-pi/pull/15173) by [@will-bogusz](https://github.com/will-bogusz))
- Pressing Escape in your own app no longer stops the `computer` tool's background window input unless task control is held; Escape in omp still interrupts it, and physical Escape still stops takeover input ([#15176](https://github.com/can1357/oh-my-pi/pull/15176) by [@will-bogusz](https://github.com/will-bogusz))
- Added Box questions to `ChainJudge`: they go only to Jev judges that answer them, and the box edges measure the image you passed even when it was padded to fit Jev's size bounds
- A relay `browser.open` without `app.target` now opens its own background tab instead of adopting the visible one (after reinstalling the relay extension; older ones select it), and `browser.close` closes it; `app.target` still borrows an existing tab ([#16119](https://github.com/can1357/oh-my-pi/pull/16119) by [@nnnnoel](https://github.com/nnnnoel) and [@will-bogusz](https://github.com/will-bogusz))
- Computer-use `win.menu.items` now needs `exec` approval and is rejected in `read_only` runs, since on macOS it makes the window key in its own application before reading its menus ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- The `computer` tool no longer takes over your screen for macOS drags and holds on sliders, scroll bars, splitters and steppers, modified clicks, right-clicks and scrolls; they run in the background ([#15185](https://github.com/can1357/oh-my-pi/pull/15185) by [@will-bogusz](https://github.com/will-bogusz))
- The default `judge` role now uses TypeSafe Jev 1.14 (`typesafe/jev-1.14.0`, then `openrouter/typesafe/jev-1.14`): `jev-latest` is TypeSafe's stable alias and answered as `jev-1.13.0`
- Idle compaction on a 1-hour prompt cache (Anthropic long retention) now runs just before the cache entry expires, about 54 minutes after the last request, so the summary still reads the cached context; `compaction.idleTimeoutSeconds` still applies with a 5-minute cache or an unknown lifetime ([#16198](https://github.com/can1357/oh-my-pi/pull/16198), [#16204](https://github.com/can1357/oh-my-pi/pull/16204) by [@H4vC](https://github.com/H4vC))
- Tool-call intents now say what the agent wants from the call's output and what it already knows (e.g. "Find where the retry delay is computed and whether it honours Retry-After; the client is in http.py") instead of a short label like "Reading config file"

### Fixed

- Fixed repeated status commands such as `/goal show` showing nothing after the first few times in a native terminal when the text had not changed
- Fixed browser relay tabs that a browser already had open when its extension connected staying invisible to omp until they changed; opening such a tab by `app.target` could fail with "Selected tab did not become available before omp could attach"
- Fixed Ollama Cloud sessions compacting too early on stripped thinking or too late after switching from another model ([#16164](https://github.com/can1357/oh-my-pi/issues/16164))
- Fixed Google sign-in rejecting the `/login perplexity` SSO browser window with "This browser or app may not be secure"; the sign-in browser no longer runs in automation mode ([#16141](https://github.com/can1357/oh-my-pi/issues/16141))
- Fixed `task.softRequestBudget` never stopping Cursor subagents ([#16182](https://github.com/can1357/oh-my-pi/pull/16182) by [@joseotaviorf](https://github.com/joseotaviorf))
- Fixed image judgments (`judge()`/`judge_batch()` with images) leaving TypeSafe Jev for the local `tiny` model whenever an image fell outside Jev's 280–1568 px bounds, which most screenshots do: images are now resized into the bounds, and strips padded, before Jev sees them
- Fixed a Codex turn stopping on "Request failed … unsupported_native_inflight_message" when you sent a message while the response was writing text; the session now keeps the partial reply and continues with your message
- Fixed the `bash` tool dropping variables, functions, and shell options between calls whenever auto-background was on (the default): a call that starts in the foreground now runs in the session's persistent shell, a failing command under `set -e` or an `exit` no longer resets that shell, and a call that overlaps a still-running one says it ran in a temporary shell ([#16153](https://github.com/can1357/oh-my-pi/pull/16153) by [@alphastorm](https://github.com/alphastorm))
- Fixed the macOS `computer` tool's `StaleRef` for an element the app rebuilt in place, such as an Automator rule popup after its neighbour changed, leaving the agent to re-read the window: it now names the one element of the window with the fields the ref was read with, for the agent to check before acting on it ([#15574](https://github.com/can1357/oh-my-pi/pull/15574) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed an eval cell's `timeout` aborting an awaited `tool.task(...)` or `tool.wait(...)` and losing its subagents' results: time spent waiting on them no longer counts against the cell, as with `agent()` handles, while a turn cancel still stops them ([#16154](https://github.com/can1357/oh-my-pi/pull/16154) by [@alphastorm](https://github.com/alphastorm))
- Fixed the Up arrow crashing omp with `text.replace is not a function` when `history.db` was damaged; recall skips unreadable rows, and a damaged store is moved aside to `history.db.corrupt-*` with every readable prompt, session title, and recap copied into its replacement ([#15751](https://github.com/can1357/oh-my-pi/pull/15751) by [@Shadorain](https://github.com/Shadorain))
- Fixed browser `tab.screenshot()` raising Chrome over the app you were typing in and switching its visible tab; background tabs and windows behind other apps are now captured in place, including ones idle long enough that Chrome stopped drawing them, as is a relay or `app.cdp_url` tab the user switched away from ([#15174](https://github.com/can1357/oh-my-pi/pull/15174) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed tabs omp opens through a relay shared by two browsers landing in whichever browser reconnected last; they open in the browser of the tab omp used last, else the one showing the first selected tab ([#16119](https://github.com/can1357/oh-my-pi/pull/16119) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a relay `browser.close` after a browser restart closing a tab the user had opened since, when Chrome reused the old tab's id; a tab omp opens while its browser's relay extension reconnects now waits for it instead of opening in another browser, and one Chrome finishes creating after the extension's connection dropped is closed ([#16119](https://github.com/can1357/oh-my-pi/pull/16119))
- Fixed `computer.run` and browser `tab.run` silently dropping `args` that were not an array (such as `{ args: { path } }`) or were given with a code string, so the function ran without them after its first steps had already acted; both now throw before the run starts, while omitted or `null` `args` still pass none ([#16149](https://github.com/can1357/oh-my-pi/pull/16149) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `computer` helpers or browser tab calls started together (such as `Promise.all` over `computer.window`) failing with a bare "Computer worker is busy" or "Tab … is busy"; the error now says to await each call before starting the next, or group the steps in one `computer.run` or `tab.run` ([#16149](https://github.com/can1357/oh-my-pi/pull/16149) by [@will-bogusz](https://github.com/will-bogusz))
- Commands in `bash` can hand `skill://`, `local://`, and other file-backed URLs to external programs again (`python skill://example-skill/tool.py "query"`), and can run them from a `cd`'d writable URL directory such as `local://`; a URL the provider rejects, such as an unknown skill, now fails the command with the provider's error ([#14838](https://github.com/can1357/oh-my-pi/pull/14838) by [@koyzdev](https://github.com/koyzdev))
- Fixed `computer.apps.open` returning before the app had a window, or never giving a hidden running app one; it now returns the app's frontmost window as `window`, waiting up to 3 s on macOS ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a key you were typing on macOS arriving twice or more when omp exited after computer use ([#15562](https://github.com/can1357/oh-my-pi/pull/15562) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp --restore` and `/retry` reporting nothing to retry for a turn cut off by a process exit in a session that had used `eval`; the interrupted turn now continues ([#16195](https://github.com/can1357/oh-my-pi/issues/16195))
- Fixed session loading on Windows treating a session path with a regular-file component as a missing session (an empty session) instead of rejecting it with `ENOTDIR` like POSIX does ([#16145](https://github.com/can1357/oh-my-pi/pull/16145) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed models from extension providers listed in `enabledModels` or `--models` missing from `/model`, the Ctrl+P cycle and the startup model scope notice until the background catalog refresh finished ([#16096](https://github.com/can1357/oh-my-pi/pull/16096) by [@skipper019](https://github.com/skipper019))

## [18.12.1] - 2026-10-17

### Breaking Changes

- Removed `display()` from eval in both Python and JavaScript; `print` (and `console.log` in JavaScript) covers it

### Added

- Added `advisor.continueSeverity` (`nit`, `concern`, `blocker`) to choose the minimum advisor note severity that wakes the agent after it finished with a final answer; lower-severity notes stay as a card at the end of the transcript
- Printed DataFrames/Series render as tables, large dicts/lists and objects as JSON trees, and Markdown objects as Markdown for the user, while the model sees the printed text
- Printing a figure or image in eval attaches the image to the result

### Changed

- An advisor `concern` raised after the agent's final answer now continues the run by default instead of waiting at the end of the transcript; set `advisor.continueSeverity` to `blocker` for the previous behavior

### Fixed

- Fixed context-file `@` imports failing to load paths containing backslash-escaped spaces ([#16090](https://github.com/can1357/oh-my-pi/issues/16090))

## [18.12.0] - 2026-10-17

### Added

- Added `statusLine.segmentOptions.pi.showProfile`: set it to `false` to hide the profile name next to the `π` brand, for example when each profile already has its own theme ([#16063](https://github.com/can1357/oh-my-pi/pull/16063) by [@shgew](https://github.com/shgew))
- Added `sharpshooter.minPromptLength` (default 16, minimum 2) to control the shortest prompt Sharpshooter extracts decisions from ([#16043](https://github.com/can1357/oh-my-pi/pull/16043) by [@bigHippoZz](https://github.com/bigHippoZz))

### Changed

- With a first-party Anthropic model on the official API selected, the interactive UI opens the API connection at startup, on model switch, and when you start typing, so the next turn skips connection setup; third-party gateways and custom endpoints are never probed ([#16044](https://github.com/can1357/oh-my-pi/pull/16044) by [@H4vC](https://github.com/H4vC))
- The API connection warm-up now covers every built-in provider (Copilot, OpenAI, Gemini, OpenRouter, …), not only Anthropic: between turns it keeps the connection your last request used open, through the configured proxy and CA settings, so the next turn skips connection setup; custom `models.yml` providers, built-in providers pointed at a gateway, and local servers are never probed ([#16086](https://github.com/can1357/oh-my-pi/pull/16086) by [@H4vC](https://github.com/H4vC))
- Snapcompact now shows an imaged `read` result's indentation as count brackets (`[»2]` two tabs, `[·4]` four spaces) and keeps its `[path#TAG]` header as text, so edits from imaged reads keep the right indentation and tag ([#15899](https://github.com/can1357/oh-my-pi/pull/15899) by [@apoc](https://github.com/apoc))
- A custom model's explicit `contextWindow` or `maxTokens` in `models.yml` now wins over the catalog's limit rules for that model id, which previously overwrote it ([#16094](https://github.com/can1357/oh-my-pi/pull/16094) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed Claude Opus 5.5 replies sent between tool calls (for example an answer to a question asked mid-task) being folded into the "Thought" block; they now show as normal reply text in the transcript, print mode, ACP clients, and HTML exports
- Fixed the shell's `du --time=ctime` (also `status`) printing `???` on Windows; it now shows the last write time, as `stat` already does for the status-change time
- Fixed the shell's `rmdir dir/.` on Windows removing `dir` (and `rmdir x/..` the parent); like POSIX it now fails with `Invalid argument` / `Directory not empty`
- Fixed the shell's `dd if=DIR` on Windows failing with `failed to open ...: Permission denied`; like POSIX it now opens the directory and reports `error reading ...: Is a directory` with the transfer statistics
- Fixed the LSP mux returning from shutdown before its language-server children exited, and spawning a duplicate language server when a session reconnected while the previous one was still closing its documents
- Fixed the startup connection warm-up silently doing nothing on Windows, where Bun's `fetch.preconnect` throws ([#16086](https://github.com/can1357/oh-my-pi/pull/16086) by [@H4vC](https://github.com/H4vC))
- Fixed the RPC frame codec (`modes/rpc/rpc-frame`) failing to bundle for Node because it pulled in Bun-only modules and the native addon ([#16072](https://github.com/can1357/oh-my-pi/pull/16072) by [@oyty](https://github.com/oyty))
- Fixed `auth-gateway` strict probes sending a raw token instead of the structured credential blob for Alibaba Coding Plan and Snowflake logins ([#16092](https://github.com/can1357/oh-my-pi/pull/16092) by [@H4vC](https://github.com/H4vC))
- Fixed a prompt sent while Esc was still interrupting the previous turn never settling, so a message steered in as it ended stayed queued instead of running ([#16038](https://github.com/can1357/oh-my-pi/pull/16038) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed isolated tasks freezing the host when the checkout holds linked worktrees of the same repository (e.g. gitignored `.claude/worktrees/`); those worktrees are no longer snapshotted as nested repos ([#16068](https://github.com/can1357/oh-my-pi/issues/16068))
- Fixed `edit` moves dropping executable permissions in hashline, patch, and apply_patch modes ([#16042](https://github.com/can1357/oh-my-pi/pull/16042) by [@mottopanikeiku](https://github.com/mottopanikeiku))
- Fixed leaving a subagent view before its transcript finished replaying leaving rows of both sessions on screen, dropping the start of one, and clearing native scrollback twice; transcript rebuilds now run one at a time and a superseded rebuild is discarded without painting ([#16066](https://github.com/can1357/oh-my-pi/pull/16066) by [@cagedbird043](https://github.com/cagedbird043))
- Fixed Cursor task subagents losing their final report when it follows tool calls in the same turn ([#16059](https://github.com/can1357/oh-my-pi/issues/16059)).
- Fixed SQLite read continuation hints dropping filters and sort order or truncating the next-page selector ([#16040](https://github.com/can1357/oh-my-pi/pull/16040) by [@mottopanikeiku](https://github.com/mottopanikeiku))
- Fixed SQLite table reads omitting generated columns from sample rows and query results, and rejecting sort orders on those columns ([#16041](https://github.com/can1357/oh-my-pi/pull/16041) by [@mottopanikeiku](https://github.com/mottopanikeiku))
- Fixed video timestamp selectors (`clip.mp4:2s`, `clip.mp4:0:05`) failing for files outside the session cwd, which also reported a colon-mangled path when the video was missing. ([#16056](https://github.com/can1357/oh-my-pi/pull/16056) by [@adi-IL](https://github.com/adi-IL))
- Fixed recovery of hashed session directories for projects under a temporary directory inside home, including the default Windows temp directory ([#15929](https://github.com/can1357/oh-my-pi/pull/15929) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed approval prompts for `xd://` device dispatches and direct MCP tools to show readable, indented arguments with multiline content expanded into blocks ([#15589](https://github.com/can1357/oh-my-pi/issues/15589), [#16048](https://github.com/can1357/oh-my-pi/pull/16048) by [@KunoLu](https://github.com/KunoLu)).
- Fixed `retry.fallbackChains` warning "references unknown model" at startup for models a discovery provider loads once its background refresh finishes (e.g. Copilot and Cursor `-1m` variants); a model still missing after discovery is warned about once ([#16061](https://github.com/can1357/oh-my-pi/pull/16061) by [@gchai](https://github.com/gchai))
- Fixed GitHub Copilot models that only discovery lists (e.g. `-1m` variants) going missing at startup when two Copilot accounts are signed in ([#16061](https://github.com/can1357/oh-my-pi/pull/16061) by [@gchai](https://github.com/gchai))
- Fixed Cursor models that only discovery lists (e.g. `-1m` variants) staying unavailable at startup until a background refresh whenever the stored Cursor access token had expired; the startup cache read now uses the same account key as the discovery write ([#16061](https://github.com/can1357/oh-my-pi/pull/16061) by [@gchai](https://github.com/gchai))
- Fixed `var` declared inside a top-level control block disappearing after an awaited JavaScript Eval cell ([#15859](https://github.com/can1357/oh-my-pi/issues/15859)).
- Fixed the eval runtime-state reminder omitting live Python kernels, so retained Python state no longer reads as dead or absent; Python kernels are listed with their generation, alive/dead status, and `%load` scripts like JavaScript kernels ([#16032](https://github.com/can1357/oh-my-pi/issues/16032)).
- Fixed a browser call hanging for about 21 s, and its tab staying listed but dead, when the tab's worker crashed (such as on an error inside Puppeteer): the call fails at once with the cause and the next call continues on the same page ([#16037](https://github.com/can1357/oh-my-pi/pull/16037) by [@alnaggar-dev](https://github.com/alnaggar-dev) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/restart` losing explicitly opened session files outside the default session directories by resuming the persisted file directly ([#16030](https://github.com/can1357/oh-my-pi/pull/16030) by [@appboypov](https://github.com/appboypov))
- Fixed a failed `todo` call's hidden reminder resurfacing on the next prompt with an outdated list after the agent had already retried successfully ([#16001](https://github.com/can1357/oh-my-pi/issues/16001))
- Fixed TypeSafe image-cache reuse when only ignored image detail changes ([#16002](https://github.com/can1357/oh-my-pi/pull/16002) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed `ssh://` ignoring a `ControlPath` from `~/.ssh/config`, so it now reuses an already-authenticated master (e.g. on MFA/keyboard-interactive hosts) instead of failing with `Permission denied` ([#15974](https://github.com/can1357/oh-my-pi/issues/15974))
- Fixed `--session-dir <dir> --resume <id>` not finding a transcript that is a symlink in that directory, the session lists and id-prefix lookups skipping symlinked transcripts the same way, and a resume that must rewrite such a transcript replacing the link instead of updating the file it points at; a project bucket that is itself a symlink is no longer traversed, so a scan cannot leave the sessions root and no session is listed twice ([#15878](https://github.com/can1357/oh-my-pi/issues/15878), [#15882](https://github.com/can1357/oh-my-pi/pull/15882) by [@AnxForever](https://github.com/AnxForever))
- Fixed restarting an interactive session with SIGTERM disabling a rotating Anthropic OAuth login and requiring `/login` again ([#15845](https://github.com/can1357/oh-my-pi/issues/15845)).
- Fixed URL `read` dropping everything past 500,000 characters: tail selectors, URL `grep`, and the linked full-output artifact now reach the whole response body ([#15768](https://github.com/can1357/oh-my-pi/issues/15768)).
- Fixed `find` (tool and `omp find`) reporting "no hits" when every judge request failed; it now reports `find unavailable` with a hint to use grep, flags partial runs with how many judge requests failed, and exposes the status as `coverage` in its details and `--json` output ([#15744](https://github.com/can1357/oh-my-pi/issues/15744))
- Fixed resumed sessions with `eval` history (`--continue`, `--resume`) missing the prompt cache after the previous process's first request ([#15736](https://github.com/can1357/oh-my-pi/issues/15736))
- Fixed a failed streamed edit preview ending the whole run without retry: the harness now re-drives the turn with the preview diagnostic so the model can read the file again and correct the patch, and gives up with a notice only after two recoveries
- Fixed MCP OAuth login requesting every scope in an authorization server's catalogue when the protected resource advertises no scopes; `/mcp reauth` now falls back to configured scopes or authorization-server defaults ([#15996](https://github.com/can1357/oh-my-pi/pull/15996) by [@unclesamwk](https://github.com/unclesamwk)).
- Fixed the incomplete-todo stop reminder firing (and resuming work) when the agent's final message asks for permission or a decision before a closing status line, through "If you confirm, I'll…"/"Separately, tell me…"-style requests, or with a non-English question followed by another sentence ([#15986](https://github.com/can1357/oh-my-pi/issues/15986))

## [18.11.3] - 2026-10-16

### Breaking Changes

- Extension `ui.approve()` hosts receive an optional `session` choice label and answer `"once"`, `"session"`, or `"deny"` instead of a boolean

### Added

- Added `imageCountBudget` to custom models and `modelOverrides` in models.yml, so a custom gateway can state its host's image limit instead of the default of 5; past that limit the oldest images were dropped on every new image, which rewrote the provider's prompt cache ([#15002](https://github.com/can1357/oh-my-pi/issues/15002), [#15969](https://github.com/can1357/oh-my-pi/pull/15969) by [@aramalipoor](https://github.com/aramalipoor))
- The status line names the active profile next to the `π` brand (`π-work`), so sessions from different profiles are distinguishable at a glance; the default profile is unchanged ([#15622](https://github.com/can1357/oh-my-pi/pull/15622) by [@matthewrball](https://github.com/matthewrball))
- Added opt-in `prewalk.auto` (`off`, `suggest`, or `on`): the native judge decides per task whether to arm a prewalk handoff to `prewalk.autoTarget`, and the next task starts back on the planning model ([#16026](https://github.com/can1357/oh-my-pi/pull/16026) by [@taibenvenuti](https://github.com/taibenvenuti))
- Added `/seance` and the task `seance` agent: consult a saved session read-only, in place, without resuming it or copying its artifacts; pick the source and an optional model from pickers, and send follow-ups to the consultant ([#15036](https://github.com/can1357/oh-my-pi/pull/15036) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))

### Changed

- Tool approval prompts list Approve, Approve `<tool>` for this session, and Deny again: with an empty composer, pick with the arrow keys and Enter; typing in the composer denies and steers instead, and the Deny row reads "Deny and send message" while you do

### Fixed

- Fixed the Isolate Subagents setting description implying that all tasks run isolated; each task must opt in with `isolated: true` ([#15987](https://github.com/can1357/oh-my-pi/issues/15987)).
- Fixed `read` labeling re-encoded images with the display format instead of the source file's format; it now identifies both when they differ ([#15890](https://github.com/can1357/oh-my-pi/issues/15890)).
- Fixed `omp -p` and `task` subagents reporting a clean finish with an earlier answer when a context overflow could not be compacted enough to retry; the overflow error is now the run's outcome ([#15897](https://github.com/can1357/oh-my-pi/pull/15897) by [@nhthung](https://github.com/nhthung))
- Fixed Cursor's Shell tool killing commands once its `block_until_ms` wait elapsed; the wait no longer sets the kill deadline, which comes from Cursor's `hard_timeout` or the bash default ([#15898](https://github.com/can1357/oh-my-pi/pull/15898) by [@nhthung](https://github.com/nhthung))
- Fixed an interrupted prompt's late setup cleanup marking the next prompt idle early, allowing overlapping submissions and releasing sleep prevention mid-turn ([#15946](https://github.com/can1357/oh-my-pi/issues/15946))
- Fixed hashline `REM` hiding the path-recovery warning when a nonexistent path matched an earlier-read file ([#15957](https://github.com/can1357/oh-my-pi/issues/15957)).
- Fixed tool downloads (`sd`, `sg`, `yt-dlp`, `trafilatura`) failing with `GitHub API error: 403` on a machine whose egress IP has spent GitHub's anonymous 60/hour budget; the release lookup now sends `GITHUB_TOKEN`/`GH_TOKEN` like omp's other GitHub API call sites ([#15981](https://github.com/can1357/oh-my-pi/pull/15981) by [@iacore](https://github.com/iacore))
- Background local memory extraction now stops after one bounded retry budget on repeated OpenAI-compatible 429 responses instead of multiplying transport, provider, and completion retries ([#15826](https://github.com/can1357/oh-my-pi/issues/15826)).
- Fixed a message-result subagent resumed by typing into its focused session leaving `agent://<id>` empty and never reporting its final reply to the parent ([#15948](https://github.com/can1357/oh-my-pi/issues/15948))
- Fixed `read` of an RSS or Atom feed showing `Untitled` for every item and dropping feed titles, descriptions, dates, and RSS item links ([#15954](https://github.com/can1357/oh-my-pi/issues/15954))
- Fixed `read` showing a binary notice instead of an HTML page when a server sends unlabeled gzip to the first request but decodable HTML to the second ([#15956](https://github.com/can1357/oh-my-pi/issues/15956))
- Fixed `read` returning a homepage's site-wide feed or a page's site-wide `llms.txt` alternate instead of the requested page ([#15955](https://github.com/can1357/oh-my-pi/issues/15955)).
- Fixed `ast_grep` reporting a clean "No matches found" for a pattern that does not parse in the target language (e.g. a bare C# identifier); it now lists the pattern's ERROR node as a parse issue ([#15950](https://github.com/can1357/oh-my-pi/issues/15950))
- Fixed `--resume <id>` and session listings skipping transcripts placed in the session directory as symlinks ([#15878](https://github.com/can1357/oh-my-pi/issues/15878), [#15884](https://github.com/can1357/oh-my-pi/pull/15884) by [@peda-cos](https://github.com/peda-cos))
- Fixed sessions with a deferred-connecting MCP server listing every routed MCP tool twice, once as a mount notice and once in route guidance ([#15982](https://github.com/can1357/oh-my-pi/pull/15982) by [@zcyoung2000](https://github.com/zcyoung2000))

### Removed

- Removed the built-in `rs-parking-lot` rule; Rust edits using `std::sync::{Mutex, RwLock}` with `.lock().unwrap()` are no longer steered to `parking_lot`

## [18.11.2] - 2026-10-16

### Added

- Added `lsp.requestTimeout` setting to configure wait durations for language server diagnostics and requests
- Added `omp auth-gateway serve --clients=<file>`: per-client bearer tokens, each limited to listed models and broker OAuth accounts with no fallback to other accounts or API keys, re-read while serving ([#5098](https://github.com/can1357/oh-my-pi/issues/5098), [#15900](https://github.com/can1357/oh-my-pi/pull/15900) by [@alphastorm](https://github.com/alphastorm))

### Changed

- The `lsp` tool now uses `lsp.requestTimeout` to dynamically adjust both call deadlines and project-aware diagnostic wait times, with support for per-call overrides
- Reduced CPU overhead during syntax checks and automatic edit repairs ([#15904](https://github.com/can1357/oh-my-pi/pull/15904) by [@iliaal](https://github.com/iliaal)).
- Reduced status-line refresh overhead while subagents have long conversations ([#15874](https://github.com/can1357/oh-my-pi/pull/15874) by [@iliaal](https://github.com/iliaal)).
- Agents now send `todo` updates alongside their next tool call instead of spending a separate model turn on them ([#15402](https://github.com/can1357/oh-my-pi/pull/15402) by [@will-bogusz](https://github.com/will-bogusz))
- The Shared Language Servers setting now says what it does: each connection gets its own server, and a released one is reused while another omp instance keeps the project's mux running ([#14633](https://github.com/can1357/oh-my-pi/pull/14633) by [@jorgoose](https://github.com/jorgoose))
- Memories saved explicitly through the extension `memory.save` API are now stored as `stated` rather than `unknown`, so they rank as deliberate memories in Mnemopi recall ([#13824](https://github.com/can1357/oh-my-pi/pull/13824) by [@sjawhar](https://github.com/sjawhar))

### Fixed

- Fixed prewalk switching models during read-only MCP lookups through `write xd://` when the server marks the tool read-only ([#15994](https://github.com/can1357/oh-my-pi/issues/15994))
- Fixed Ctrl+C printing `9;5u` in the shell after force-quitting omp with a third Ctrl+C while it was still closing the session
- Fixed Smart unexpected-stop recovery continuing finished answers, which added extra "nothing more to add" turns
- Fixed `grep` searching only the first 4 MB of a file named directly, so later matches were reported as absent; the whole file is now searched, and a multiline pattern, which still reads only the first 4 MB, says so in its no-match headline ([#15942](https://github.com/can1357/oh-my-pi/issues/15942))
- Fixed browser `uploadFile` failing with "Not allowed" through the relay or into a Chrome on another machine, stalling behind macOS folder-privacy prompts, and breaking the tab on large drop-zone files ([#15489](https://github.com/can1357/oh-my-pi/pull/15489) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `uploadFile` sending a stale copy of a file rewritten without changing its size or timestamp, failing on folders that contain a symlink loop, and deleting copies a still-open attached page could read after a repeat upload
- Fixed plan mode (including plan-yolo) looping on `write xd://propose` forever when an extension provides a tool named `write`; the extension tool is left out of plan mode with a warning, since only the built-in `write` can submit plans ([#14030](https://github.com/can1357/oh-my-pi/issues/14030), [#14438](https://github.com/can1357/oh-my-pi/pull/14438) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed legacy Mnemopi bank databases staying open after the recall bank probe, which could block deleting them on Windows ([#14584](https://github.com/can1357/oh-my-pi/pull/14584) by [@yshihao636](https://github.com/yshihao636))
- Fixed startup skipping a configured default fallback whose provider authenticates only through another provider's key (e.g. `xai-oauth` via `XAI_API_KEY`) and picking an unrelated model instead ([#15781](https://github.com/can1357/oh-my-pi/pull/15781))
- Fixed slower startup when the configured default model is unavailable and no fallback chain is configured ([#15781](https://github.com/can1357/oh-my-pi/pull/15781))
- Fixed `read` directory listings printing a directory's raw listing error, whose tabs, newlines, or control characters could break the transcript; `[unreadable: …]` is now a single bounded line ([#15789](https://github.com/can1357/oh-my-pi/pull/15789))
- Fixed a `^` model mention sent while the agent is working (steer, follow-up, or queued skill prompt) never announcing its new `m<N>` alias to the model ([#14093](https://github.com/can1357/oh-my-pi/issues/14093), [#14322](https://github.com/can1357/oh-my-pi/pull/14322) by [@holny](https://github.com/holny))
- Fixed large session files ending in a truncated record not being repaired on load, unlike small ones ([#14582](https://github.com/can1357/oh-my-pi/pull/14582) by [@yshihao636](https://github.com/yshihao636))
- Fixed a read-only subagent's rejected `write` reading as a dead end: when `yield` is available, the rejection now names it as the way to return the content ([#14308](https://github.com/can1357/oh-my-pi/issues/14308), [#14470](https://github.com/can1357/oh-my-pi/pull/14470) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `/retry` after an interrupt leaving later advisor notes and extension asides unable to wake the agent until the next typed prompt ([#14831](https://github.com/can1357/oh-my-pi/pull/14831) by [@daandden](https://github.com/daandden))
- Fixed session titles and idle recaps disappearing after a corrupt `history.db` was quarantined and recreated, and a briefly busy store disabling the session index for the rest of the session ([#13929](https://github.com/can1357/oh-my-pi/issues/13929), [#14361](https://github.com/can1357/oh-my-pi/pull/14361) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed pasting a screenshot with ⌘V into omp running over SSH from Tern or kitty failing with `Clipboard is empty` or `Image not found` ([#15369](https://github.com/can1357/oh-my-pi/pull/15369) by [@LoneExile](https://github.com/LoneExile))
- Fixed native hook discovery silently ignoring hooks symlinked into `hooks/pre` or `hooks/post` ([#14189](https://github.com/can1357/oh-my-pi/issues/14189), [#14536](https://github.com/can1357/oh-my-pi/pull/14536) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed headless Linux containers without a system D-Bus logging a `Failed to acquire power assertion` warning on every turn; the missing backend is now noted once at debug level ([#14591](https://github.com/can1357/oh-my-pi/pull/14591) by [@tahakotil](https://github.com/tahakotil))
- Fixed a project's daemon broker staying unreachable after its runtime directory was deleted while it ran (`proc://`, `wait`, shared LSP and the shared browser failed with `connect ENOENT …/broker.sock`); the broker now releases the project within seconds of losing its socket and the next request starts a fresh one ([#14466](https://github.com/can1357/oh-my-pi/pull/14466) by [@nick-maderight](https://github.com/nick-maderight))
- Fixed SQL and Redis sessions stalling after a rewrite raced an append; later turns now republish after the backend recovers ([#15612](https://github.com/can1357/oh-my-pi/pull/15612) by [@sjawhar](https://github.com/sjawhar))
- Fixed OpenAI Codex web search failing with "No Codex OAuth credentials found" when only `OPENAI_CODEX_OAUTH_TOKEN` is set ([#12537](https://github.com/can1357/oh-my-pi/issues/12537), [#14337](https://github.com/can1357/oh-my-pi/pull/14337) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `yield` rejecting a valid `data` result when a non-strict provider also filled `error` with a placeholder such as `unused` or `n/a`; a real error alongside `data` is still rejected, now with exact resend instructions ([#15633](https://github.com/can1357/oh-my-pi/pull/15633) by [@Komzpa](https://github.com/Komzpa))
- Fixed secret redaction replaying Gemini tool calls with their original `thoughtSignature` after rewriting the call arguments; a rewritten call now drops the signature, as rewritten thinking already did ([#14392](https://github.com/can1357/oh-my-pi/pull/14392) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed Claude marketplace plugin MCP servers declaring a sub-second `timeout` (e.g. SAP's `"timeout": 600`) never loading; values below Claude Code's 1000 ms minimum are now ignored with a warning so the default timeout applies ([#12485](https://github.com/can1357/oh-my-pi/issues/12485), [#14574](https://github.com/can1357/oh-my-pi/pull/14574) by [@oleg494](https://github.com/oleg494))
- Fixed automatic retries looping without end when the primary model's cooldown expired mid-retry: the session no longer switches back to the primary while a retry is still in flight, and returns to it on the next prompt ([#14611](https://github.com/can1357/oh-my-pi/pull/14611) by [@MiloMMIN](https://github.com/MiloMMIN))
- Fixed web search providers garbling non-UTF-8 responses; they now decode with the charset declared in `Content-Type` (or a `<meta charset>` tag), the same way fetched pages are ([#15304](https://github.com/can1357/oh-my-pi/pull/15304) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed `openai-models-list` discovery ignoring a flat `max_tokens` output limit on `/v1/models` rows, which pinned such models to the 32K default ([#13062](https://github.com/can1357/oh-my-pi/issues/13062), [#14403](https://github.com/can1357/oh-my-pi/pull/14403) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed long replies dropping lines from scrollback or replaying them duplicated and out of order when status widgets stay taller after a turn or transient HUDs close ([#15820](https://github.com/can1357/oh-my-pi/pull/15820) by [@emmahyde](https://github.com/emmahyde))
- Fixed a stale "Working…" row staying under a focused subagent after it finished while the main session kept running ([#15820](https://github.com/can1357/oh-my-pi/pull/15820))
- Fixed `omp update` failing when a bunfig `minimumReleaseAge` or npmrc `min-release-age` supply-chain cooldown rejects the just-published release; self-update now overrides the cooldown for the pinned version it installs ([#14581](https://github.com/can1357/oh-my-pi/pull/14581) by [@morri-son](https://github.com/morri-son))
- Fixed `agent://<id>` returning a message-result subagent's first result after it completed a parent-requested follow-up; reads now return its latest completed result ([#15707](https://github.com/can1357/oh-my-pi/pull/15707) by [@mg-mg-mg](https://github.com/mg-mg-mg))
- Fixed sloppy edits silently dropping an operator when one `*** Find` was followed by two (e.g. `*** Insert Before` and `*** Replace`); the payload is now rejected with an error naming both and nothing is applied ([#14357](https://github.com/can1357/oh-my-pi/pull/14357) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed a cancelled Python tool install (e.g. `uv tool install`) falling through to `pip` with the aborted signal and leaving the install progress running ([#15750](https://github.com/can1357/oh-my-pi/pull/15750) by [@harshaygadekar](https://github.com/harshaygadekar))
- Fixed auto-learn captures rewriting earlier OpenAI Responses history after a learning tool call, which broke prompt-cache reuse ([#14099](https://github.com/can1357/oh-my-pi/pull/14099) by [@nanbloom001](https://github.com/nanbloom001))
- Fixed `/shake images` leaving the context percentage unchanged; the tokens freed by the removed images are now reported and subtracted from the context meter right away ([#5029](https://github.com/can1357/oh-my-pi/issues/5029), [#14367](https://github.com/can1357/oh-my-pi/pull/14367) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `/fork pane|tab` and Herdr `ctx.ui.openTerminal()` launches failing in panes whose shell is not POSIX (such as Nushell); Herdr launches now type only the path of a self-deleting `/bin/sh` script and no longer ask for POSIX-shell confirmation ([#15262](https://github.com/can1357/oh-my-pi/pull/15262) by [@shgew](https://github.com/shgew))
- Fixed Eval `read("artifact://N")` returning an "Unbounded raw read blocked" notice instead of the text for artifacts over 50 KB that belong to another session, or when the session has no artifacts directory, in JavaScript and Python cells ([#15410](https://github.com/can1357/oh-my-pi/pull/15410) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cancelling a bash job hard-killing it before its TERM cleanup handlers could run; it now gets up to one second to clean up before termination is forced ([#15709](https://github.com/can1357/oh-my-pi/pull/15709) by [@mg-mg-mg](https://github.com/mg-mg-mg))
- Fixed the transcript collapsing to one line per entry after switching between a subagent and the main session mid-turn when an earlier turn left a tool call without a result ([#12247](https://github.com/can1357/oh-my-pi/issues/12247), [#15466](https://github.com/can1357/oh-my-pi/pull/15466) by [@shgew](https://github.com/shgew))
- Fixed a retried tool losing its transcript card when the view was rebuilt (subagent focus switch, overlay close) while the tool was still running
- Fixed Chrome element handles' `uploadFile()` failing "Node is not a file input element" on labels, chooser triggers and drop zones; it now uploads like `tab.uploadFile()` ([#15918](https://github.com/can1357/oh-my-pi/pull/15918) by [@will-bogusz](https://github.com/will-bogusz))
- Browser `tab.fill` in Chrome sets colour, date, time and range inputs to the given value (it typed `2026-10-12` as `61012-02-02` and left a colour at `#000000`), and refuses a value the input rejects ([#15914](https://github.com/can1357/oh-my-pi/pull/15914) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `uploadFile` on a control that opens `showOpenFilePicker()` hanging the cell until the tab was killed; it now fails at once with a named error ([#15915](https://github.com/can1357/oh-my-pi/pull/15915) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed every later file chooser on a page doing nothing, the user's own clicks in a relay tab included, after browser `uploadFile` clicked a chooser trigger or drop zone ([#15915](https://github.com/can1357/oh-my-pi/pull/15915) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `uploadFile` in Chrome reporting success with no file attached when the element opens no file chooser and nothing on the page reads the dropped files; it now fails and says what to target ([#15919](https://github.com/can1357/oh-my-pi/pull/15919) by [@will-bogusz](https://github.com/will-bogusz))
- Relay mode: when Chrome detaches omp from a tab it drives (a password manager's inline menu loading in the page), the call fails at once saying why and omp reattaches to the same tab, instead of every later call timing out and reopening failing with `No page targets available` ([#15920](https://github.com/can1357/oh-my-pi/pull/15920) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the macOS `computer` tool letting the display sleep and lock in a turn that went 5 minutes without a desktop action; it now keeps the display awake until the turn ends or asks for your answer, then lets it sleep ([#15762](https://github.com/can1357/oh-my-pi/pull/15762) by [@will-bogusz](https://github.com/will-bogusz))

## [18.11.1] - 2026-10-15

### Added

- Added image attachments to single and batch eval `judge()`/`judge_batch()` calls (local paths or embedded images); image judgments skip candidates without image support and fail explicitly instead of dropping images ([#15471](https://github.com/can1357/oh-my-pi/pull/15471) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Added a job tree to `/jobs`, `/jobs full` and the jobs pill's sheet, in the terminal UI and over ACP: subagents' background jobs now appear nested under the task that runs them, with the busiest branches listed first; only your own jobs offer Cancel ([#15854](https://github.com/can1357/oh-my-pi/pull/15854) by [@H4vC](https://github.com/H4vC))
- Added `ctx.ui.getEditorComponent()` so extensions can wrap the active custom editor factory instead of replacing it ([#8655](https://github.com/can1357/oh-my-pi/pull/8655) by [@jovi-tsx](https://github.com/jovi-tsx))

### Changed

- Reduced memory used by bundled model catalog data in standalone and npm installs ([#15876](https://github.com/can1357/oh-my-pi/pull/15876) by [@iliaal](https://github.com/iliaal)).

### Fixed

- Fixed `/shake` and automatic shake leaving old transcript rows in native scrollback or obscuring the start of a response beside the Todo HUD ([#15877](https://github.com/can1357/oh-my-pi/issues/15877)).
- Fixed `write` making Rust source files beginning with `#![...]` executable instead of preserving their permissions ([#15858](https://github.com/can1357/oh-my-pi/issues/15858)).
- Fixed the startup status bar preview showing a previous session's model instead of the default model ([#15865](https://github.com/can1357/oh-my-pi/issues/15865)).
- Fixed `length`-stop recovery with a lowered `compaction.thresholdTokens` counting the discarded output against the threshold, so a reasoning-only cut compacted without the retry hint and a truncated answer was discarded instead of kept ([#15870](https://github.com/can1357/oh-my-pi/issues/15870))
- Fixed `read` on a directory showing `(empty directory)` when the directory itself is unreadable, and silently omitting subdirectories it cannot list; it now errors for an unreadable root and marks unreadable subdirectories `[unreadable: …]` ([#15769](https://github.com/can1357/oh-my-pi/issues/15769)).
- Fixed isolated tasks losing the commits of a submodule added inside the isolation, leaving the merged checkout pinned to an unreachable commit ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed isolated task startup hanging or detaching an unrelated checkout when `.gitmodules` lists a submodule path that is absolute or contains `.`/`..` ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed `/live` and Ctrl+L starting live mode while the composer microphone was still loading its recognizer, which opened a second recorder and dictated into the hidden editor ([#15759](https://github.com/can1357/oh-my-pi/pull/15759))
- Fixed images in the transcript not opening their file; their placeholders and image chips now link to it ([#15872](https://github.com/can1357/oh-my-pi/pull/15872) by [@H4vC](https://github.com/H4vC))
- Fixed print mode returning success after length-stop recovery gave up; it now waits for the session to settle before choosing its exit code ([#15732](https://github.com/can1357/oh-my-pi/pull/15732) by [@nick-maderight](https://github.com/nick-maderight))
- Fixed browser `tab.click("text/…")` passing over a match a scroll container shows only a narrow strip of and clicking a later duplicate instead ([#15792](https://github.com/can1357/oh-my-pi/pull/15792) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/advisor` status waiting on usage checks; it now renders immediately with cached quota data and refreshes usage in the background ([#15780](https://github.com/can1357/oh-my-pi/pull/15780) by [@mvid](https://github.com/mvid))
- Fixed task agents silently skipping `autoload-skills` entries for skills added after the session started ([#15723](https://github.com/can1357/oh-my-pi/pull/15723) by [@shyamsivakumar](https://github.com/shyamsivakumar))
- Fixed changed `initOptions` in `lsp.json` not applying when a new session reused an idle shared language server ([#15645](https://github.com/can1357/oh-my-pi/pull/15645) by [@mottopanikeiku](https://github.com/mottopanikeiku); [#15535](https://github.com/can1357/oh-my-pi/issues/15535))
- Fixed wake completions falsely reporting no output when the agent already messaged its owner over IRC ([#15834](https://github.com/can1357/oh-my-pi/pull/15834) by [@mg-mg-mg](https://github.com/mg-mg-mg)).
- Fixed a steered service readiness wait leaving the daemon broker polling until `ready.timeout`; the abandoned wait is now cancelled ([#15656](https://github.com/can1357/oh-my-pi/pull/15656))
- Fixed Cursor `;`-separated reads returning an image part's bytes as text ([#15635](https://github.com/can1357/oh-my-pi/pull/15635))
- Fixed auto-compaction ignoring `retry.waitForUsageReset` and abandoning the last compaction method on a provider-stated usage-limit reset past `retry.maxDelayMs` ([#15313](https://github.com/can1357/oh-my-pi/pull/15313))
- Fixed advisor compaction dropping the kept latest turn when the native compaction had to stop before it ([#15712](https://github.com/can1357/oh-my-pi/pull/15712))
- Fixed tool-approval steering: a message typed while viewing a subagent now steers the main session awaiting the approval, the message that denied a call is delivered ahead of older queued steers, and an equal-looking later steer no longer answers a new approval ([#15642](https://github.com/can1357/oh-my-pi/pull/15642))
- Fixed workpool item errors cancelling the entire batch; workers now continue with remaining items and report each result separately ([#15860](https://github.com/can1357/oh-my-pi/issues/15860)).
- Fixed image attachments with uppercase MIME types being dropped; supported image MIME types are now matched case-insensitively ([#15765](https://github.com/can1357/oh-my-pi/pull/15765) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed ordinary Bash commands emitting an ignored-readiness warning for placeholder-only `ready` fields, while preserving warnings for log/port conditions and service validation ([#15629](https://github.com/can1357/oh-my-pi/pull/15629) by [@nqrwhal](https://github.com/nqrwhal)).
- `openai-models-list` discovery reads the output limit from `top_provider.max_completion_tokens` (OpenRouter-shaped catalogs such as ModelRelay), so a bundled reference with a larger limit no longer makes requests the provider rejects ([#15652](https://github.com/can1357/oh-my-pi/pull/15652) by [@shanev](https://github.com/shanev))
- Fixed saved session history being replaced by incomplete rewrites after asynchronous disk write failures ([#15588](https://github.com/can1357/oh-my-pi/pull/15588) by [@jiwangyihao](https://github.com/jiwangyihao)).
- Fixed the `read` tool description inviting `:img` on PNG paths: it now says `:img` only rasterizes SVG/SVGZ files and raster images need no selector, and the `:img` error on a raster file says to read it without the selector ([#15671](https://github.com/can1357/oh-my-pi/pull/15671) by [@nick-maderight](https://github.com/nick-maderight))
- Corrected the `ast_grep` truncated-result advice to suggest `skip` pagination or narrowing instead of `increase limit`, which the tool schema does not accept ([#15532](https://github.com/can1357/oh-my-pi/issues/15532), [#15543](https://github.com/can1357/oh-my-pi/pull/15543) by [@peda-cos](https://github.com/peda-cos)).
- Fixed Cursor sessions with many MCP tools compacting unnecessarily or pausing automatic maintenance despite ample free context ([#15815](https://github.com/can1357/oh-my-pi/issues/15815)).
- Fixed switching a session or advisor to Cursor still counting the previous model's tool schemas toward context usage and compaction ([#15815](https://github.com/can1357/oh-my-pi/issues/15815)).
- Fixed todo reminders continuing the agent when the `todo` tool is disabled ([#12589](https://github.com/can1357/oh-my-pi/pull/12589) by [@anthonyrisinger](https://github.com/anthonyrisinger)).
- Fixed JS eval `completion()` handles created in one cell never resolving in a later cell, which left `wait(handles, { timeout })` hanging past its timeout ([#15756](https://github.com/can1357/oh-my-pi/issues/15756)).
- Closed `read :raw` line ranges now return only the requested content, and newline-terminated files report their actual line count ([#15810](https://github.com/can1357/oh-my-pi/issues/15810)).
- Fixed `/review` PR file assignments by including exact per-file diff URLs and preserving 1-based indexes across excluded files ([#15463](https://github.com/can1357/oh-my-pi/pull/15463) by [@tkossak](https://github.com/tkossak))
- Fixed image attachments with uppercase MIME types being dropped; supported image MIME types are now matched case-insensitively ([#15765](https://github.com/can1357/oh-my-pi/pull/15765) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed `grep` and `ast_grep` returning no matches for a `path` glob that names directories, such as `src/{api,web}` or `src/we?`; matched directories are now searched recursively like a plain directory path, so `src/*` also searches files in `src`'s subdirectories ([#15760](https://github.com/can1357/oh-my-pi/issues/15760))
- Fixed a structured `display()` value in an Eval cell appearing twice in the TUI and collab view, as text in the cell box and again as the JSON tree; it now shows once, as the tree, while the model still sees the text ([#10778](https://github.com/can1357/oh-my-pi/issues/10778), [#12730](https://github.com/can1357/oh-my-pi/pull/12730) by [@F0Rextasy](https://github.com/F0Rextasy))
- `omp auth-gateway serve` now bounds its broker-backed session cache instead of growing with every distinct client session ([#15841](https://github.com/can1357/oh-my-pi/issues/15841)).
- Fixed the run ending when a reasoning model stops with only a signed thinking block and no reasoning text (seen with Gemini 4 via OpenRouter); the agent now continues it like any other thinking-only stop ([#15837](https://github.com/can1357/oh-my-pi/issues/15837))
- Fixed `openai-models-list` discovery ignoring a model's top-level `max_output_tokens` / `max_completion_tokens`, which let gateway models inherit an output cap as large as the whole context window and send oversized `max_completion_tokens` ([#15811](https://github.com/can1357/oh-my-pi/issues/15811))
- Fixed the standalone binary crashing with `Settings not initialized` when resuming or starting a TUI session with an extension whose dependencies clear `require.cache` (e.g. `request-promise` via `pi-messenger-bridge`) ([#15799](https://github.com/can1357/oh-my-pi/issues/15799))
- Python Eval displays preserve integers outside JavaScript's safe range as decimal strings in structured JSON instead of silently rounding them ([#15847](https://github.com/can1357/oh-my-pi/issues/15847)).
- Loop-watchdog stalls while Mnemopi truncates the recall query for compaction or background first-turn recall are now logged under `mnemopi.recall` instead of `unknown` ([#15413](https://github.com/can1357/oh-my-pi/pull/15413) by [@jaredlyon](https://github.com/jaredlyon)).
- Clarified the `/session pin` description: it pins a stored OAuth account to the current provider for this session only ([#15479](https://github.com/can1357/oh-my-pi/pull/15479) by [@iacore](https://github.com/iacore))
- Fixed `/jobs` doing nothing in a focused subagent view: it now lists that subagent's own background jobs, as does the jobs pill's sheet, without a way to cancel them; `/jobs kill` still requires returning to the main session ([#15161](https://github.com/can1357/oh-my-pi/pull/15161) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed a suspended JavaScript Eval cell resolving `artifact://` and `local://` paths against the session directories of another cell that started while it was awaiting ([#15409](https://github.com/can1357/oh-my-pi/pull/15409) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` ignoring JSON and JSONL `?q=` filters and pagination for `local://` and `artifact://` files ([#15767](https://github.com/can1357/oh-my-pi/issues/15767)).
- Agents can now read saved context notes without accidentally clearing them ([#15748](https://github.com/can1357/oh-my-pi/pull/15748) by [@Komzpa](https://github.com/Komzpa))
- Fixed startup without an explicit model picking an unrelated authenticated provider instead of the first available model in the configured default fallback chain ([#15781](https://github.com/can1357/oh-my-pi/pull/15781) by [@mvid](https://github.com/mvid))

## [18.11.0] - 2026-10-14

### Added

- Added a microphone button beside Send in Tern: click to record, click Stop to finish, then review and submit the transcription yourself. Clicking while it says **Starting…** cancels a slow first model load ([#15759](https://github.com/can1357/oh-my-pi/pull/15759) by [@daaximus](https://github.com/daaximus)).
- Added local Nemotron streaming dictation: words appear while you speak, and the microphone waits for the recognizer to be ready before recording ([#15759](https://github.com/can1357/oh-my-pi/pull/15759) by [@daaximus](https://github.com/daaximus)).
- Added agent frontmatter `structured: true`: that agent's task spawns keep the `yield` tool and its `output` schema validation while `task.structured` is off ([#15717](https://github.com/can1357/oh-my-pi/pull/15717) by [@alphastorm](https://github.com/alphastorm))
- The composer stays usable while a tool approval is pending: sending a message denies the call and steers the turn with it, so the agent knows why it was denied ([#15642](https://github.com/can1357/oh-my-pi/pull/15642) by [@H4vC](https://github.com/H4vC))
- Session entries record which omp build wrote them, so a transcript shows whether a fix was live even in a session left open across an upgrade: the version, plus commit, branch, and uncommitted-diff hash when run from a source checkout, and `OMP_BUILD_LABEL` when set. `/session` lists the builds that wrote the session ([#15680](https://github.com/can1357/oh-my-pi/pull/15680) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- The in-composer tool approval prompt summarizes the command, path, or content to one row so the composer keeps its room; `Ctrl+O` shows them in full ([#15642](https://github.com/can1357/oh-my-pi/pull/15642) by [@H4vC](https://github.com/H4vC))
- Background task guidance now lives in the Task tool description (and in same-name extension replacements that delegate to Task) instead of being repeated in every spawn acknowledgment ([#15477](https://github.com/can1357/oh-my-pi/pull/15477) by [@iliaal](https://github.com/iliaal))
- The Auto-Promote Context and Retry Model Fallback settings now state that they are independent; turn off Retry Model Fallback (`retry.modelFallback`) to stop `retry.fallbackChains` model switches ([#15636](https://github.com/can1357/oh-my-pi/issues/15636))

### Fixed

- Fixed browser `tab.click("text/…")` timing out when the match was below the fold or the tab was in the background ([#14864](https://github.com/can1357/oh-my-pi/pull/14864) by [@alnaggar-dev](https://github.com/alnaggar-dev), [#15496](https://github.com/can1357/oh-my-pi/pull/15496) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser clicks the page never received, such as on a disabled control or inside an `inert` subtree, reporting success; the call now fails saying the browser did not deliver the click ([#15496](https://github.com/can1357/oh-my-pi/pull/15496) by [@will-bogusz](https://github.com/will-bogusz))
- `tab.ariaSnapshot()` no longer prints the value of a password field; it shows one bullet per character, as `tab.observe()` and the screen do, so a typed or browser-autofilled password stays out of the model's context ([#15502](https://github.com/can1357/oh-my-pi/pull/15502) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed project discovery loading plugins, `SYSTEM.md`, rules, context files, and skills from a `.omp` at a shared temporary root (`/tmp`, `/var/tmp`, the temp dir) above an unanchored working directory, or, when `HOME` is overridden, from another account's `~/.omp` outside the working directory's git repository ([#15719](https://github.com/can1357/oh-my-pi/pull/15719) by [@alphastorm](https://github.com/alphastorm))
- Fixed browser `tab.text()` and `tab.html()` (and the same calls on a frame) throwing when called without a selector; they now read the page body on Chrome, Tern and cmux ([#15599](https://github.com/can1357/oh-my-pi/pull/15599) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed skill-description compression re-sending the same smol-model requests every session for a skill whose compressed answer was rejected (over 12 words or 160 characters) or cut off at the token limit; that model is no longer asked again for that skill (a newly selected smol model is), and compressions still running at exit get up to 4 seconds to save ([#13291](https://github.com/can1357/oh-my-pi/issues/13291), [#15720](https://github.com/can1357/oh-my-pi/pull/15720) by [@alphastorm](https://github.com/alphastorm))
- Fixed the macOS `computer` tool keeping the display awake for the rest of the session after a native call hung; the call's timeout or closing the session now lets it sleep ([#15414](https://github.com/can1357/oh-my-pi/pull/15414) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed an agent definition whose `tools` value names no tool (`tools: ""`, a number, a list without strings) getting every default built-in tool; it now gets none, like `tools: []` ([#15718](https://github.com/can1357/oh-my-pi/pull/15718) by [@alphastorm](https://github.com/alphastorm))
- Fixed `page.waitForNetworkIdle` in a browser `run` timing out on a request an earlier `run` started ([#15495](https://github.com/can1357/oh-my-pi/pull/15495) by [@alnaggar-dev](https://github.com/alnaggar-dev) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed a tab that a relay page opens over its own CDP session (`Target.createTarget`) landing in a separate Chrome window with `newWindow`, under an id omp could not attach to, activate or close; it now opens as a relay tab in that page's browser ([#15494](https://github.com/can1357/oh-my-pi/pull/15494) by [@alnaggar-dev](https://github.com/alnaggar-dev) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed an Anthropic refusal fallback redeeming its fallback credit with an outdated system prompt and tools after switching models; it now sends a fresh request ([#15702](https://github.com/can1357/oh-my-pi/pull/15702) by [@H4vC](https://github.com/H4vC))
- Fixed OpenAI/Codex auto-compaction failing with "Remote compaction input exceeds the context window" after a turn's final response pushed history past the window; native compaction now compacts the history before the kept recent turns, which stay in context as-is ([#15712](https://github.com/can1357/oh-my-pi/pull/15712) by [@H4vC](https://github.com/H4vC))
- Fixed `omp commit`, `/git`, and other agent commits skipping the signature when Git's `commit.gpgsign` is enabled; they now sign with the configured key, and a signing failure leaves HEAD unchanged ([#14810](https://github.com/can1357/oh-my-pi/issues/14810))
- Fixed rejected `task` calls appearing successful to SDK hosts instead of reporting a tool error ([#15573](https://github.com/can1357/oh-my-pi/issues/15573))
- Fixed `read` claiming regenerated images were identical when their pixels changed at the same path ([#15668](https://github.com/can1357/oh-my-pi/issues/15668))
- Fixed SDK embedders leaking every disposed `AgentSession` that owned its MCP manager, so long-lived processes that create and dispose many sessions grew memory without bound ([#15386](https://github.com/can1357/oh-my-pi/issues/15386))
- Fixed retry model fallback stopping at a fallback model whose provider is outside a subagent's `task.agentAccountPools` pool; that model is now skipped and the next fallback model is tried ([#15423](https://github.com/can1357/oh-my-pi/issues/15423))
- Fixed the system prompt's `## MCP Server Instructions` section following MCP connection order, so a server connecting late or reconnecting no longer reorders it and rewrites the prompt cache; servers are now listed by name ([#15705](https://github.com/can1357/oh-my-pi/issues/15705))
- Fixed `read` reporting an HTTP 204 No Content response as a failed fetch; it now returns an empty successful read ([#15667](https://github.com/can1357/oh-my-pi/issues/15667))
- Fixed `/mcp reauth` failing with `Could not discover OAuth endpoints` when a server's 401 challenge is a bare `Bearer resource_metadata="…"`; the advertised protected-resource metadata URL is now used ([#15690](https://github.com/can1357/oh-my-pi/issues/15690))
- Fixed extension `agent_end` events reporting a background-job wait as a scheduled continuation; they now carry `awaitingAsyncWork: true` alongside `willContinue` ([#15348](https://github.com/can1357/oh-my-pi/issues/15348))
- Fixed auto-compaction waiting out provider retry delays longer than `retry.maxDelayMs` (e.g. a 16-hour `retry-after`); it now tries the next configured method or reports the failure ([#15311](https://github.com/can1357/oh-my-pi/issues/15311))
- Fixed `read skill://<name>` for a name no loaded skill owns hanging for the rest of the turn while an MCP server was still connecting or reconnecting; it now reports `Unknown skill` after at most 5 seconds ([#15648](https://github.com/can1357/oh-my-pi/issues/15648))
- Fixed `/new` ignoring "Start in Plan Mode" (`plan.defaultOnStartup`): the new session now starts in plan mode like the first one ([#15627](https://github.com/can1357/oh-my-pi/issues/15627))
- Fixed Cursor models' Read on an image file returning the file's raw bytes as text; Read now loads the image, and Cursor's text-only Read frame gets a short image note instead of the bytes ([#15630](https://github.com/can1357/oh-my-pi/issues/15630))
- Fixed Mermaid diagrams showing `&lt;`, `&gt;`, `&amp;`, and `#quot;` literally inside labels instead of `<`, `>`, `&`, and `"` ([#15619](https://github.com/can1357/oh-my-pi/issues/15619))
- Fixed background job results already consumed by an eval `agent()` handle's `wait()` being re-injected as one `async-result` follow-up when the cell ran past the 5-minute job retention window ([#15625](https://github.com/can1357/oh-my-pi/issues/15625))
- Fixed `/tan` missing the parent's prompt cache: it advertised the parent's `xd://` tools as top-level tools and dropped `ask`, so its tool list no longer matched ([#15578](https://github.com/can1357/oh-my-pi/issues/15578))
- Fixed forks and reloaded sessions missing the prompt cache after a compaction in a session with `eval` history ([#15695](https://github.com/can1357/oh-my-pi/issues/15695))
- Fixed compiled-binary extensions importing `@oh-my-pi/pi-tui` subpaths such as `terminal-capabilities`, `chat/svg-figure` or `theme/index` loading a second copy from their own `node_modules` instead of sharing the host's terminal, theme and figure state ([#15659](https://github.com/can1357/oh-my-pi/issues/15659))
- Fixed marketplace plugins that keep their version in `.claude-plugin/plugin.json` never being reported by `omp plugin upgrade` or auto-updated; for plugins shipped inside the marketplace, `plugin.json`'s version now also takes precedence over the catalog entry's, as in Claude Code ([#15585](https://github.com/can1357/oh-my-pi/issues/15585))
- Fixed a steer (queued user or peer message) waiting behind a `bash` service's readiness wait (`name` + `ready`) for up to `ready.timeout`; the call now returns early with the service still starting, inspectable via `proc://<name>` ([#15653](https://github.com/can1357/oh-my-pi/issues/15653))
- Fixed `omp install`/`omp plugin install`, `upgrade`, `uninstall` and `doctor --fix` failing with `Executable not found in $PATH: "bun"` for npm and Git plugins on machines without Bun installed, such as standalone-binary installs ([#15480](https://github.com/can1357/oh-my-pi/issues/15480))
- Fixed `/plugins enable` and `/plugins disable` in the TUI not refreshing skills, commands, task agents and MCP servers until a reload, and rejecting npm plugins ([#15383](https://github.com/can1357/oh-my-pi/issues/15383))
- Fixed local memory injection and `learn` using the `Settings` directory instead of the session's project directory, so SDK hosts sharing one `Settings` across projects injected another project's lessons and never the project's consolidated summary; sharpshooter memory follows the session directory too ([#15375](https://github.com/can1357/oh-my-pi/issues/15375))
- Fixed ACP bash approvals ignoring `bash.patterns`, and an earlier "Always allow" letting critical commands such as `rm -rf /` run without a prompt ([#15473](https://github.com/can1357/oh-my-pi/issues/15473))
- Fixed hashline edits silently dropping the tail of a line that `read` or `grep` had cut at the column limit; such an edit is now refused until a `:raw` read shows the full line ([#15649](https://github.com/can1357/oh-my-pi/issues/15649))
- Fixed isolated tasks failing on linked worktrees with initialized recursive submodules and leaving updated submodule pins unreachable after cleanup ([#15457](https://github.com/can1357/oh-my-pi/issues/15457))
- Fixed `/tan` missing the parent's prompt cache by advertising `xd://` tools top-level and omitting `ask` ([#15578](https://github.com/can1357/oh-my-pi/issues/15578)).

## [18.10.4] - 2026-10-13

### Added

- Extensions can observe and answer the interactive plan review, including refinement feedback and save-and-quit ([#14250](https://github.com/can1357/oh-my-pi/pull/14250) by [@rlfleming93](https://github.com/rlfleming93))
- Added opt-in `omp gc --compress` (or `gc.compress`), which stores sessions idle for `gc.compressAfterDays` (default 7) with filesystem transparent compression (APFS, NTFS); they stay resumable and searchable ([#15600](https://github.com/can1357/oh-my-pi/pull/15600) by [@wolfiesch](https://github.com/wolfiesch))
- Extensions can reopen a dismissed plan review while the session is idle (`ctx.openPlanReview()`) and pick the execution tier on `ctx.resolvePlanReview` (`input.role`); `plan_review_requested` now reports the slider's tiers ([#15552](https://github.com/can1357/oh-my-pi/pull/15552) by [@Shadorain](https://github.com/Shadorain))

### Changed

- Tool approval prompts now replace the composer like `ask`, show one row per detail, and approve with `Ctrl+Enter` (or `Ctrl+Q`) instead of `Enter` ([#15548](https://github.com/can1357/oh-my-pi/pull/15548) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed late completion probes rewinding resumed conversations and stale history scans lowering parked subagent costs ([#15594](https://github.com/can1357/oh-my-pi/pull/15594) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Fixed `read.renderMarkdown` having no effect on plain-file reads: inline read previews now render Markdown files as formatted Markdown instead of numbered source ([#15007](https://github.com/can1357/oh-my-pi/issues/15007)).
- Fixed Claude refusing every turn (`reasoning_extraction`) in a session snapcompacted under Codex, Grok or another reasoning model, after a switch or resume; Claude turns, `/btw`, `/handoff` and compaction now read a reasoning-free copy of the archive ([#15436](https://github.com/can1357/oh-my-pi/pull/15436) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the project-shared browser (headless or headed) reopening every page its previous run left open whenever it relaunched (after a crash, an out-of-memory kill, a normal stop, or a restart from `omp ps`); no session owned those pages, so they were never closed and piled up across restarts. Detaching it through `proc://<name>/mode`, which relaunched it the same way, is now refused ([#15561](https://github.com/can1357/oh-my-pi/pull/15561) by [@eggpeat](https://github.com/eggpeat))
- Fixed `omp models --json` reporting a scheduled model's superseded price in `cost`; it reports the price in force, such as DeepSeek V4 Pro's $0.30 / $1.20 card since 2026-09-14 ([#15620](https://github.com/can1357/oh-my-pi/pull/15620) by [@eggpeat](https://github.com/eggpeat))

### Removed

- Removed Codex Code Mode and its `providers.openai-codex.codeMode` / `providers.openai-codex.codeModeDirectTools` settings; Codex models always use the full direct tool surface.

## [18.10.3] - 2026-10-12

### Added

- Added `task.agentSoftRequestBudget` to give named subagents their own soft request budget, so a long-running agent can get more requests (or `0` for no guard) while scout, sonic and other agents keep theirs ([#15419](https://github.com/can1357/oh-my-pi/pull/15419) by [@will-bogusz](https://github.com/will-bogusz))
- Added `o200k` as a `tokenizer` value for custom models and overrides in `models.yml` ([#15447](https://github.com/can1357/oh-my-pi/pull/15447) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- Sized snapcompact archives for Claude 4.7+ and GPT-5.5 to 6.1 (gpt-6-astra included) at each frame's measured price instead of at least 5,024 tokens, so Codex archives can hold up to 1.7× as many frames when the room under the compaction trigger is the limit ([#15442](https://github.com/can1357/oh-my-pi/pull/15442) by [@will-bogusz](https://github.com/will-bogusz))
- Enabled sibling subagent prompt-cache sharing for Muse Code's Spark 1.3, Wonder 1.0, and Wonder Full 1.0 variants while keeping their conversations separate ([#15467](https://github.com/can1357/oh-my-pi/pull/15467) by [@iliaal](https://github.com/iliaal), based on [#15285](https://github.com/can1357/oh-my-pi/pull/15285) by [@YueyuHoshizora](https://github.com/YueyuHoshizora))
- Reduced tool-result tokens by omitting subsecond bash timing and redundant task size metadata ([#15468](https://github.com/can1357/oh-my-pi/pull/15468) by [@iliaal](https://github.com/iliaal); [#15265](https://github.com/can1357/oh-my-pi/issues/15265); based on [#15284](https://github.com/can1357/oh-my-pi/pull/15284) by [@YueyuHoshizora](https://github.com/YueyuHoshizora))
- On the official Anthropic and Codex endpoints, snapcompact archives may carry up to 12 MB of frames instead of 3 MB, Anthropic requests keep up to 600 images (100 on 200k-window models) instead of 90, and Codex requests up to 2,000 instead of 200; custom base URLs, including Anthropic requests rerouted by `ANTHROPIC_BASE_URL` or Foundry's `FOUNDRY_BASE_URL`, keep the previous limits and no longer get Anthropic's 24 MB inline image byte limit ([#15434](https://github.com/can1357/oh-my-pi/pull/15434) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed `snapcompact.toolResults` re-sending each large tool result as images a turn after it went out as text, which broke the prompt cache and Anthropic signed thinking every turn; results are now imaged from their first send, and `read` results stay text unless the model is known to edit exactly from images (Opus 5.5+) ([#14249](https://github.com/can1357/oh-my-pi/pull/14249) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed compaction on Claude sessions with thinking sometimes keeping about half the recent history `compaction.keepRecentTokens` asks for, because each kept turn was counted at its signature's size ([#15446](https://github.com/can1357/oh-my-pi/pull/15446) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed retry fallback rejecting a model with a smaller window by charging it the reasoning the active model's provider usage replayed, and the output cap charging reasoning a cold Responses session leaves out of its first request ([#15447](https://github.com/can1357/oh-my-pi/pull/15447) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed anonymized session exports losing whether bash timing was shown ([#15468](https://github.com/can1357/oh-my-pi/pull/15468) by [@iliaal](https://github.com/iliaal))
- Added `omp --restore <session>`: resumes a session like `--resume`, then goes on with what its last process left unfinished when it crashed or was killed, both the interrupted turn and the subagents it was running (their results reach the parent as usual); Tern's session daemon now restarts omp with it after a crash
- Kept private prompt-cache routing keys out of shared sessions and HTML exports ([#15467](https://github.com/can1357/oh-my-pi/pull/15467) by [@iliaal](https://github.com/iliaal))

## [18.10.2] - 2026-10-12

### Added

- Added `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` support: set it to stop Anthropic requests sending experimental beta fields that a company `ANTHROPIC_BASE_URL` gateway rejects, such as the Sonnet 5.5 `thinking.adaptive.block_binding` 400 ([#15458](https://github.com/can1357/oh-my-pi/pull/15458) by [@H4vC](https://github.com/H4vC))
- Added the `task.structured` setting (default off) for structured task results: when on, the task tool accepts `outputSchema`/`schemaMode` and subagents return results through `yield` as before

### Changed

- Subagents spawned by the task tool now return their final message as plain text, with no `yield` tool, output schemas, or "Submit Result" fields; eval `agent()`/workpool spawns still return structured results
- In Tern, a backgrounded `bash` command or `eval` cell keeps filling its own card with live output (In background, with a running clock) and settles it with the job's outcome, Cancelled when the job is killed; `wait` lists each job on one line (type, id, label, duration) instead of repeating its output
- ACP clients now see a backgrounded call's job output stream into its tool call, which settles completed or failed with the job

### Fixed

- Fails unstructured task runs that conclude without a final message
- Background task cards no longer stop updating once the agent ends its turn while the task is still running
- Transparent images the model receives (small icons, oversized screenshots) keep their transparency instead of turning into a black square, and resized edges no longer pick up a dark fringe

## [18.10.1] - 2026-10-12

### Added

- Added a Copy button that leads the turn footer under an answer in Tern (`⧉ · 2m13s · 71K tok · $0.85 this turn`, in place of the clock), which copies that answer

### Changed

- Running agents and background jobs in Tern now share one compact counter over the composer (an icon and a count each, the words on hover) instead of two "N running" pills; each count still opens its own sheet
- In Tern, `/session pin` and `/usage reset` open the same picker sheet as the other small selectors (the active account checked, a confirm strip before a reset is spent, unusable accounts dimmed with the reason); the thinking level picker shows each level's depth as a meter, the plugin and queue mode pickers use badges (version, installed, scope, recommended) and plain-language names instead of bracketed text, and the theme picker no longer repeats "(current)" beside its check
- In Tern, the text editor an extension opens (and the ask tool's custom answer and note) is now a sheet in the composer's place: the title over its details, the text written straight on the sheet, and Open in editor, Cancel and Submit buttons whose keys show in their tooltips instead of a keycap hint row

### Fixed

- Fixed `grep` on a single file showing in Tern as separate boxed snippets with no file row or syntax colors; it now looks the same as a `grep` over a directory

## [18.10.0] - 2026-10-12

### Added

- Added `/fork` support for creating a new Tern pane while a turn is streaming, preserving the original session
- Added `omp session pack`, `omp session unpack` and `omp session moved` to move a session with its artifacts to another machine and continue it there; resuming the copy left behind forks it instead of continuing it
- Added `omp auth export` and `omp auth import` to carry model sign-ins to another machine
- Added hiding a pending `ask` question without answering it: `Alt+H` (`app.ask.hide`) or the Hide button in Tern collapses the dialog to one line; the same key, `Enter`, or Show brings it back ([#15400](https://github.com/can1357/oh-my-pi/pull/15400) by [@H4vC](https://github.com/H4vC))

### Changed

- Local IPC endpoints (daemon broker, LSP mux, IDA hosts, text prediction, `omp stream`, Collab discovery, local model workers) now run on a native transport: owner-only on every platform, including Windows named pipes; on Windows, daemons started by an older omp are not reused, so close older sessions after upgrading.
- Output hidden behind an open `ask` dialog, command report or todo list now reaches terminal scrollback once it closes, rather than while it is still open ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed every session loading its own copy of the local mnemopi embedding model and keeping it in memory until exit; one server per model is shared across sessions and exits after 15 idle minutes ([#9908](https://github.com/can1357/oh-my-pi/issues/9908))
- Fixed the first-use mnemopi embedding-model download never completing for sessions shorter than the download; it now finishes in the shared embedding server after the session exits ([#10240](https://github.com/can1357/oh-my-pi/issues/10240))
- Fixed `RpcClient.stop()` occasionally waiting forever because the agent process was never signaled.
- Fixed blank rows opening under the input after an `ask` dialog, command report or todo list closed in a session that had filled the screen; the transcript now refills the screen ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))
- Fixed blank rows appearing between the last paragraphs of a streamed answer when the turn ended ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))

## [18.9.2] - 2026-10-11

### Fixed

- Improved responsiveness when adding assistant text after tool calls in long transcripts.
- Fixed `apply_patch` handling of context-free hunks when the target text appears multiple times.
- Fixed `find` filename ranking and sketch scoring with judge endpoints that limit the number of questions per request.
- Fixed `omp gc --apply` leaving temporary session files after an interrupted save.
- Fixed `omp auth-gateway serve` handling of OpenRouter routing variants such as `:floor` and `:nitro`.
- Improved validation errors for `computer` helpers with missing or non-string text arguments by identifying the helper and argument involved.
- Fixed `/tan` forks incorrectly inheriting the parent task's subagent spending while preserving token counts.
- Fixed `omp://` documentation links so they open the corresponding files in source checkouts.
- Fixed bare model IDs in `models.yml` incorrectly resolving to auto-discovered Ollama, llama.cpp, or LM Studio providers.
- Added warnings when configured Ollama, llama.cpp, or LM Studio endpoints cannot be reached, identifying the relevant environment variable.

## [18.9.1] - 2026-10-11

### Added

- Added `supportsThinkingBindingControls` to Bedrock `compat` in `models.yml`, so a Bedrock gateway or region that rejects Claude thinking-binding controls can turn them off ([#15316](https://github.com/can1357/oh-my-pi/pull/15316) by [@harshaygadekar](https://github.com/harshaygadekar))

## [18.9.0] - 2026-10-11

### Added

- Added browser target discovery and control, allowing agents to list the user's available pages and operate an already-open Tern browser block instead of opening a new view.
- Added the `ctx.annotations` extension API for submitting and collecting `/annotate` feedback on text and diffs.
- Added configurable Extra Context Files under `/settings` → Context, allowing custom instruction filenames without editing YAML.
- Added optional composer predictions via `composer.predictions`, which suggest the user's next message as ghost text after each turn and support Tab or Right to accept the suggestion. Predictions use an additional model request and are included in session usage and `/stats`.
- Added structured async job metadata exposing native job status and child-agent identity alongside the job ID.
- Enhanced `tui.autoGraph: smart` with data-aware chart recommendations, including labels, grouping, ordering, shading, reference rows, measure direction, and suitable chart types.
- Added `retry.fallbackOn` to restrict model fallback to quota errors (`usage-limit`) or to non-quota errors (`except-usage-limit`), while retaining `any` as the default.
- Added `omp usage reset` commands to list saved Codex and Claude rate-limit resets and redeem a selected reset from the CLI, scripts, or auth-broker clients.
- Added warnings for saved Codex and Claude resets that are nearing expiry, including affected accounts and redemption targets; interactive sessions also show a one-time conversation warning.
- On macOS, the `computer` tool now keeps the display awake while operating and reports when the screen is locked or asleep.
- Tern browser open results now indicate when a page is not currently visible, helping agents direct users to hidden picture-in-picture or omp-tab views.

### Changed

- Improved `computer.window()` failure messages by listing open windows grouped by application, with the requested application shown first.
- Standalone binary updates and installers now use Stencil's build service with SHA-256 verification; recent updates use substantially smaller verified patches, and `--binary --ref` accepts release tags.
- After an omp upgrade, an unused older browser relay started by omp is automatically replaced on the next browser call so relay fixes take effect without manual shutdown.
- Saved Codex and Claude resets in non-interactive sessions are now automatically redeemed when they are about to expire, unless `autoRedeem: no` is configured.
- Background Claude reset salvage now checks only accounts with eligible usage, reducing unnecessary usage-limit traffic.
- Reasoning provenance is preserved when `/btw` answers are promoted or turns are moved, preventing provider summaries from being sent as model-generated reasoning.

### Fixed

- Fixed unconfigured judge roles incorrectly falling back to a Google Vertex Claude model instead of the configured `tiny`, `smol`, or `default` models.
- Fixed `omp --resume -p` continuing stale todos instead of printing the answer and exiting.
- Fixed `/btw`, IRC, and composer-prediction requests losing the conversation prompt cache on Codex and after thinking-level changes on GPT-6 models.
- Fixed Tern browser operations on `about:blank` and no-op navigations hanging until timeout.
- Fixed SDK and RPC sessions using stale MCP tool lists when servers changed during extension loading.
- Fixed installing plugins from non-GitHub Git URLs and prevented inline credentials from being persisted in plugin metadata or lockfiles.
- Improved recovery from repeated OpenAI Responses request timeouts during productive long-running sessions.
- Fixed JavaScript eval syntax errors lacking source location and a useful code frame.
- Fixed Collab sessions failing to reconnect after network interruptions or device sleep.
- Fixed ACP and browser diagnostics and SSH listings using default paths instead of configured paths.
- Fixed advisors repeatedly returning to models that refused reviewed content; they now remain on the fallback until the conversation changes state.
- Plugin registry discovery warnings are now reported instead of silently ignored.
- Fixed OpenRouter Decisions judge requests through custom provider base URLs returning 404 errors.
- Fixed Codex configuration files being rejected and prevented supported settings from being ignored.
- Fixed secrets appearing in advisor previews when a preview was truncated.
- Restored public compatibility exports required by tools, legacy Pi extensions, and plugins.
- Fixed slow completions ignoring explicitly configured thinking levels, including `:max` and `:off`.
- Fixed session writes failing on Windows FSLogix profile disks.
- Limited persisted eval status history so long-running eval cells do not excessively enlarge session files or slow resume.
- Fixed Codex session prewarming from using a different model or service tier than the resolved session.
- Fixed subagent completion-probe usage disappearing after parking or restarting.
- Fixed Python eval processes hanging while waiting on the kernel control channel.
- Corrected the custom-tool quickstart to use the supported discovery flow and shipped example.
- Fixed browser screenshots providing incorrect coordinate-scaling guidance on high-device-scale displays.
- Fixed browser calls hanging when a tab renderer crashed; they now fail promptly and reload or close the affected tab as appropriate.
- Fixed sessions becoming permanently busy when retry-related session writes failed.
- Fixed collapsed todo lists wasting a row on the hidden-item indicator.
- Fixed concurrent SDK sessions interfering with one another's async jobs and subagent follow-up results.
- Fixed duplicate accessibility-tree output from computer-use eval cells.
- Fixed chained element actions such as `win.ref("e5").click()` throwing errors; element interaction options are now supported and documented.
- Fixed JavaScript and Python `read("artifact://N")` calls returning a capped preview instead of the artifact's selected text.
- Improved guidance for retrieving complete lines when `read`, `eval`, or `bash` output is truncated by the column limit.
- Fixed resumed, switched, and forked sessions losing the prompt cache when Mnemopi or Hindsight auto-recall was enabled.
- Fixed the first prompt losing provider prompt-cache coverage while MCP servers were still starting.
- Fixed coordinate clicks being dropped after password-form submission in omp-launched Chromium.
- Fixed classifier refusals ending fallback chains prematurely when the retry budget was exhausted.
- Fixed reading MCP-advertised `skill://` resources and other MCP resources, including discovery order, loading state, and clean shutdown of stalled servers.
- Fixed smart unexpected-stop detection missing slow judge results, allowing premature stops to recover correctly.
- The `cfg://` settings approval prompt now honors `ask.timeout` rather than always expiring after ten seconds.
- Fixed custom LiteLLM providers not receiving the built-in provider behavior and model/session handling.
- Fixed resumed Cursor sessions losing earlier reasoning after transcript truncation.
- Fixed `computer.window()` failing to find windows by ID or application when many windows were open.
- Fixed `grep` hiding matches that appeared beyond the first 512 bytes of a long line.
- Fixed snapcompaction leaving too little context room after compaction.
- Fixed usage-limited account pools redeeming saved resets for accounts outside the configured pool.

## [18.8.9] - 2026-10-10

### Added

- Added capability-driven extension terminal launches for tmux, Zellij, Herdr, and CMUX, with consolidated multiplexer detection, provider/shell capability feedback, and required POSIX-shell confirmation for shell-input launches; CMUX shell input preserves non-ASCII arguments and pane working directories ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added `/fork pane|window|tab` to open a fork of the session in a new multiplexer pane or window while this session keeps running; bare `/fork` still forks in place ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added Orca CLI-based launches for `/fork pane|window|tab` and `ctx.ui.openTerminal()`, with POSIX-shell confirmation; when Orca can only start a tab as a background terminal, the launch reports a warning instead of a visible tab ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).

### Changed

- CLI `--fork` now pairs tool calls the source session left unresolved with an unknown-outcome result, and `/tan` clones report such calls as unknown-outcome instead of aborted; forking a source whose process already exited keeps the process-exit recovery and pending-tool warning ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Table charts (`tui.autoGraph`) now cover before/after tables whose rows are different metrics (time, memory, counts): each row's change is drawn as a factor of its "before" value (`48× less`, `+27%`), and rows written in prose are skipped and named under the chart. A single column of scores like `12/12` is drawn as bars filling toward 100%
- In terminals that speak the Tern Surface Protocol (Tern), the composer's bottom bar shows the git branch and its status beside the model chip when the status line has the `git` segment; it outlasts the other facts as the bar narrows, and clicking it opens `/git` ([#15220](https://github.com/can1357/oh-my-pi/pull/15220) by [@H4vC](https://github.com/H4vC))
- Table charts plot scores like `154/160` as the share of their total instead of the first number, and tables comparing two or three columns across four or more metrics now get a chart: a grid of one small panel per metric

### Fixed

- Fixed table charts failing on a table cell such as `3 constructor` or `2 valueOf calls`

## [18.8.8] - 2026-10-10

### Added

- Added `/jobs kill <id>|all` to cancel a running background job (or every one this session owns) from the command line, even while the agent is busy ([#14160](https://github.com/can1357/oh-my-pi/pull/14160) by [@KanwarGill](https://github.com/KanwarGill))
- Added `omp anonymize [session] [-o dir]` to write a shareable copy of a session and its subagent transcripts: only an explicit allowlist of omp metadata (ids, timestamps, models, usage, built-in tool names and options) is kept; message, thinking, and tool-output text become size-annotated `[redacted …]` markers; tool-call paths become mock paths (`/home/seg3/seg4/src/seg9.ts:10-20`), shell commands keep known programs and flags, other literals such as a grep pattern become `PLACEHOLDER_N`, and extension or MCP payloads are redacted whole, with the same original always mapping to the same token across files ([#15077](https://github.com/can1357/oh-my-pi/pull/15077) by [@H4vC](https://github.com/H4vC))
- Added `/dump anon`, which writes the same anonymized session and subagent JSONL to a zip in the temp directory and copies its path ([#15077](https://github.com/can1357/oh-my-pi/pull/15077) by [@H4vC](https://github.com/H4vC))
- Added message times to `/dump` transcripts (assistant turns also show request duration and time to first token), and live status, last activity, pending tool calls, and the partially streamed turn to `/dump all` files for subagents still running, so a stuck subagent can be diagnosed from the archive ([#15121](https://github.com/can1357/oh-my-pi/pull/15121) by [@H4vC](https://github.com/H4vC))
- Added `contextFiles.extra` to load extra instruction files, such as `AGENTS.local.md`, beside the usual context file ([#15147](https://github.com/can1357/oh-my-pi/pull/15147) by [@Shadorain](https://github.com/Shadorain)).
- `/annotate` opens the note you are writing, a file or typed-prompt source, or (for local diff reviews) the current working-tree file in `$VISUAL` or `$EDITOR` with the external-editor key (Ctrl+G by default); a file source is saved back and its notes follow the edited text ([#15151](https://github.com/can1357/oh-my-pi/pull/15151) by [@Shadorain](https://github.com/Shadorain))

### Changed

- A `/models` compaction limit set past a model's standard context window now runs that model on its extended window instead of being silently clamped; the hub warns (noting long-context pricing) and saves on a second Enter, in the terminal and in Tern, and rejects limits past the model's largest window ([#15048](https://github.com/can1357/oh-my-pi/pull/15048) by [@H4vC](https://github.com/H4vC))
- A token compaction limit set in `/models` (or `compaction.modelThresholds`) is now the base omp scales with its usual policy, as if it were the model's window (85% of it by default for bases above ~109k, or `compaction.thresholdPercent` of it), instead of the exact point. Plain numbers saved since 18.8.5 therefore compact earlier; rewrite one as `"f<tokens>"` (or type `f400k` in the hub) to keep it an exact trigger. The `/models` limit field shows where the model would compact as you type (`compacts at 340K · 85% of 400K base`), the preview's **Compacts at** row says why, and the saved message repeats it ([#15065](https://github.com/can1357/oh-my-pi/pull/15065) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `/usage` (or clicking the status-line cost) while the usage dashboard was already open stacking a second dashboard on top; it now focuses the open one ([#15145](https://github.com/can1357/oh-my-pi/pull/15145) by [@H4vC](https://github.com/H4vC))
- Fixed the browser tool prompt not documenting `observe()`'s `viewportOnly` and `includeAll` options, or that `open`/`close`/`run` timeouts are seconds clamped to 1–300 while `waitFor*` timeouts are milliseconds ([#15104](https://github.com/can1357/oh-my-pi/pull/15104) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser relay pages opened in the background (`browser.newPage({ background: true })` in `tab.run`) taking over the user's selected tab; they now open unselected once the relay extension is reinstalled ([#15109](https://github.com/can1357/oh-my-pi/pull/15109) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `open` with `app.relay` and a `target` failing with `No page target matched` or `Selected tab is no longer available` when the matching tab was opened a moment earlier outside omp; it now waits briefly for the relay to list the tab ([#15112](https://github.com/can1357/oh-my-pi/pull/15112) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a timed-out `browser.open` holding up the next open of the same browser (apps launched with `app.path` excepted) until its abandoned launch or connect returned; the timeout error now names the step that stalled ([#15117](https://github.com/can1357/oh-my-pi/pull/15117) by [@jinpyo-jeon](https://github.com/jinpyo-jeon) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tabs crashing mid-load on some pages with a same-site iframe, Google Travel among them, after which every open, screenshot and evaluate on the tab timed out ([#15118](https://github.com/can1357/oh-my-pi/pull/15118) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the custom-tool examples' full-documentation link opening a missing page ([#15076](https://github.com/can1357/oh-my-pi/pull/15076) by [@qingshungLI](https://github.com/qingshungLI))
- Fixed the `/models` compaction limit preview and **Compacts at** row rounding fractional percentages (`12.5%` showed as `13%`) ([#15074](https://github.com/can1357/oh-my-pi/pull/15074) by [@H4vC](https://github.com/H4vC))
- Fixed `/omfg` save, overwrite, and validation prompts in Tern opening as a sheet over the candidate rule; they now sit in the composer slot like `ask`, so the rule stays readable while you choose ([#15058](https://github.com/can1357/oh-my-pi/pull/15058) by [@H4vC](https://github.com/H4vC))
- Fixed hotkeys pressed in Tern while omp is still starting (such as Alt+P for the model selector) being ignored; like in other terminals, they now take effect once startup finishes ([#15120](https://github.com/can1357/oh-my-pi/pull/15120) by [@H4vC](https://github.com/H4vC))
- Fixed a startup extension dialog (select, confirm, input) in Tern not receiving keys until it timed out ([#15122](https://github.com/can1357/oh-my-pi/pull/15122) by [@H4vC](https://github.com/H4vC))
- Fixed auto-compaction overflowing the context window every cycle when `compaction.thresholdTokens` or an `f<tokens>` model limit is at or past a window the provider caps lower (such as Factory's 196K Kimi K3); it now compacts at the window less the reserve, and `/models` shows the trigger as capped ([#15146](https://github.com/can1357/oh-my-pi/pull/15146) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed resumed xAI, Factory Droid and OpenAI sessions forgetting earlier reasoning on their first request, while a retry after a stale Responses item error still rebuilds history ([#15148](https://github.com/can1357/oh-my-pi/pull/15148) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the startup default ignoring the model a provider's discovery names as the account's default: with no model chosen, Devin Pro now starts on SWE-2 at High instead of SWE-1.6 ([#15115](https://github.com/can1357/oh-my-pi/pull/15115) by [@will-bogusz](https://github.com/will-bogusz))

## [18.8.7] - 2026-10-09

### Added

- Added automated release binary publication to build.stencil.so
- Added OSC 7501 program status reporting: terminals and agent inboxes that support it now show whether omp is working, waiting on your answer or approval (with the question), done, or failed (with the error), without parsing the window title. Turn it off with `terminal.programStatus`.
- Added title cards (icon and short code) to `/rename`: the title model picks one for a title you type, or for a generated title when the session has no card yet; `title.icons: boring` keeps renamed titles plain.
- Grammars for less common languages (Kotlin, Swift, Ruby, PHP, Haskell, Verilog, and others) are now downloaded on first use for code summaries, block context, `ast_grep`, `ast_edit`, and TTSR rules; offline, files in those languages are skipped with a note instead of failing. `PI_GRAMMARS_URL` overrides the download location.
- Added `bash.gitGuard` (default off) for checkouts shared by concurrent agents: the bash tool refuses `git stash`, `git reset --hard` or to another commit, and `git checkout`/`switch`/`restore` that would overwrite working-tree files unless a merge or rebase conflict is being resolved; unstaging stays allowed, and commands are judged as they actually run, including inside substitutions, functions, and after `cd`.

### Changed

- Updated `write` tool error message to mention local:// scratch support
- Web search now tells the agent about its X post operators (`site:x.com`, `from:<handle>`) when you are logged in to xAI, so questions about reactions on X reach X search.
- Reduced memory retained after merging unchanged discovered and cached models ([#14252](https://github.com/can1357/oh-my-pi/pull/14252) by [@iliaal](https://github.com/iliaal)).
- The default `smol` model now prefers Claude Haiku 5.5 when it is available.
- Automatic session titles now start when the agent's reply begins rather than when you submit, so a slow-thinking first reply gets a card title (icon and code) instead of a plain fallback title.
- `read file.jsonl?q=…` keeps the other lines' results when a line before the last fails and shows jq's error ahead of them, instead of failing the read; anything else the query wrote to stderr, such as `debug` output, now leads the result too ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Title card icons now picture each session's specific subject instead of a generic bug, flask, speedometer, gear, or terminal, or the project's language logo, so sessions in the same project are easier to tell apart.
- Agents whose tool list omits `write` but still get it to run `xd://` tools can now also write `local://` files (reports, notes) outside plan mode; working-tree writes stay blocked.
- Added `worktree.onStart` and `worktree.onExit` settings to start each session in its own worktree and clean it up on exit ([#14908](https://github.com/can1357/oh-my-pi/pull/14908) by [@gitpushoriginmaster](https://github.com/gitpushoriginmaster))
- Added `speech.speed` and `tts.localSpeed` settings (0.5–2.5, default 1) to speed up or slow down local Kokoro speech for live vocalization and the `tts` tool / `omp say`, plus an `omp say --speed` flag; ACP voice clients find both settings and their presets in `speech.models.list` ([#5868](https://github.com/can1357/oh-my-pi/issues/5868))
- `omp update` and the startup update notice leave an omp installed by another app (Tern) to that app instead of replacing its files.
- The startup update notice no longer appears when omp runs from a source checkout.

### Fixed

- Reduced memory growth after one-shot side requests without interrupting ongoing conversations ([#14334](https://github.com/can1357/oh-my-pi/pull/14334) by [@iliaal](https://github.com/iliaal)).
- Fixed sessions staying untitled when you interrupted the first reply to send a queued steer message.
- Fixed browser downloads saving into another tab's `downloads` folder, and `tab.waitForDownload()` saving into the system Downloads folder once another tab closed; each tab in a Chromium omp launched or spawned now saves into its own, iframe downloads included. In those browsers a download no tab tracks (started by a page omp did not open, or finishing after its tab closed) now keeps Chromium's GUID file name instead of its suggested name; connected and relay browsers keep real file names ([#14544](https://github.com/can1357/oh-my-pi/pull/14544) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls in relay mode failing with "The browser relay … is out of date" after an omp upgrade until the old relay was killed by hand; omp now restarts a relay it started itself under an older version ([#14416](https://github.com/can1357/oh-my-pi/pull/14416) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/rename` without a title dropping the session's title card (icon and short code) ([#14980](https://github.com/can1357/oh-my-pi/issues/14980))
- Fixed title cards showing the emoji instead of the Nerd Font icon when the model misremembered the icon's name: dashes for underscores (`nf-md-text-box`), the wrong icon set (`nf-md-spinner` for `nf-fa-spinner`), or reordered, missing, or extra words (`nf-md-test` for `nf-md-test_tube`).
- Fixed `omp update` ignoring the `update.channel` setting: canary users were checked against stable releases, and `--canary`/`--stable` were never remembered.
- Fixed interrupting a reply to send a queued steer message briefly showing omp as idle (title, progress, working indicator) before the steer ran; RPC and SDK clients also no longer see a final `agent_end` for that interrupt.
- Fixed browser tab recordings and video frame/contact-sheet extraction creating `omp-browser-recording-*` and `omp-video-*` scratch directories in your working directory instead of the system temp directory.
- Fixed edit snapshots retaining excess history when metadata or displayed-line provenance grows; the 64 MiB snapshot budget now counts UTF-8 bytes, so CJK- and emoji-heavy files keep fewer versions ([#14975](https://github.com/can1357/oh-my-pi/pull/14975) by [@iliaal](https://github.com/iliaal)).

## [18.8.6] - 2026-10-08

### Added

- Added per-session Git worktree support with `worktree.onStart` and `worktree.onExit` settings to create an isolated worktree for each session and clean it up when the session ends.
- Expanded xAI web search with X post search, including X-only and author-specific queries, author exclusions, date and recency filters, and automatic xAI routing when credentials are available.
- Added xAI-powered reading of X posts, threads and replies, profiles, searches, and hashtags when logged in, replacing the unavailable Nitter mirrors.

### Changed

- Web search now prefers an authenticated `xai-oauth` login over an `xai` API key when both are available, unless `modelProviderOrder` specifies a different order.

### Fixed

- Fixed judge-gated features continuing to use a stale model chain after switching judge roles.
- Improved Anthropic prompt-cache reuse when pruning tool results from long conversations.
- Fixed resumed Claude sessions losing earlier thinking context and prompt-cache reuse when extensions or MCP tools were registered before the first message.
- Fixed subagent advisors configured with `@advisor` using the built-in `slow` model instead of the configured advisor role.
- Fixed the `/switch` command and alternate model picker crashing when stored model speed statistics contained an unnamed model.
- Fixed `lsp` and `generate_image` attempting to read FIFO, terminal, or unbounded device paths, which could hang or exhaust memory.
- Fixed aside messages from extensions being blocked behind a running wait operation.
- Fixed extensions importing `@oh-my-pi/pi-tui/native/*` failing to load in compiled `omp` binaries.
- Fixed raw token markers appearing instead of Nerd Font icons in Anthropic idle recaps, `/btw` and `/omfg` replies, and streaming previews.
- Fixed sessions moved with `/wt` disappearing from resume lists; sessions in Git worktrees now remain discoverable and can be resumed or relocated if their worktree was removed.
- Fixed live config reload ignoring edits made during startup or right after a config symlink was retargeted, until the next unrelated edit.

## [18.8.5] - 2026-10-08

### Added

- Added per-model auto-compaction points: the `/models` preview shows where each model compacts, and in the Roles view `k` (or the **Compaction limit** button) sets it for the selected role's or fallback's model (`90000`, `90k`, `1M`, `80%`; empty resets). Also configurable as `compaction.modelThresholds` with `provider/model-id` or `provider/*` keys ([#14952](https://github.com/can1357/oh-my-pi/pull/14952) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `omp usage` reporting an account exactly at its reserve (e.g. 30% left with a 30% reserve) as eligible instead of inside reserve ([#14765](https://github.com/can1357/oh-my-pi/pull/14765) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the todo reminder pushing the agent to keep working after it offered options and asked the user to choose ([#14800](https://github.com/can1357/oh-my-pi/pull/14800) by [@mrmans0n](https://github.com/mrmans0n))
- Fixed the todo reminder telling the model to keep working right after it asked the user a bolded or italicised question ([#12051](https://github.com/can1357/oh-my-pi/issues/12051), [#14353](https://github.com/can1357/oh-my-pi/pull/14353) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed short model selectors such as `p/a:max` or `a:max` dropping their explicit thinking level when a role was reassigned or used for image questions; a model whose ID literally ends in `:max` or `:auto` is still treated as that model ([#14554](https://github.com/can1357/oh-my-pi/pull/14554) by [@xiangnan0811](https://github.com/xiangnan0811))
- Fixed starting a subagent switching the parent session's later language servers from shared to private ([#14628](https://github.com/can1357/oh-my-pi/pull/14628) by [@jorgoose](https://github.com/jorgoose))
- Fixed a finishing subagent cancelling local tiny-model requests (titles, task labels, judgments) still running for the parent or other subagents ([#14629](https://github.com/can1357/oh-my-pi/pull/14629) by [@jorgoose](https://github.com/jorgoose))
- Fixed rust-analyzer on Windows not running through a running lspmux server, as it already did on Linux and macOS ([#14630](https://github.com/can1357/oh-my-pi/pull/14630) by [@jorgoose](https://github.com/jorgoose))
- Fixed a malformed or unreadable project `plugin-overrides.json` being ignored silently, which re-enabled project-disabled plugins without a trace; omp now logs a warning naming the file ([#14518](https://github.com/can1357/oh-my-pi/issues/14518), [#14573](https://github.com/can1357/oh-my-pi/pull/14573) by [@oleg494](https://github.com/oleg494))
- Fixed Claude Opus 5.5 and Sonnet 5.5 disappearing with mixed-access Google Antigravity accounts; models now route to accounts that serve them, and revoked accounts no longer block catalog refresh ([#14924](https://github.com/can1357/oh-my-pi/issues/14924)).
- Fixed clipboard-pasted image chips opening a nonexistent file instead of the image, including after `/move` ([#14927](https://github.com/can1357/oh-my-pi/issues/14927)).
- Fixed clipboard-pasted image chips opening the auto-resized copy sent to the model instead of the image as pasted ([#14929](https://github.com/can1357/oh-my-pi/pull/14929))
- Fixed `omp token <provider> --account N --force-refresh` printing the stored token unchanged while it was still valid; it now re-mints that account. Security scans pinned to one account, including Codex Security cloud requests, refresh it after a 401 and may reuse a still-usable token minted in the previous five minutes, as `omp auth-broker serve` now also may for its clients' 401 recovery ([#14752](https://github.com/can1357/oh-my-pi/pull/14752) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed revived subagents moving to the parent's automatically chosen account and re-writing their whole prompt cache instead of staying on the account that served their earlier turns; a parent's explicit `/session pin` still moves them ([#14749](https://github.com/can1357/oh-my-pi/pull/14749) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a fallback chain switching back to a usage-limited primary model every 30 minutes, failing a request each time, when the provider's usage report showed a later reset; the session now stays on the fallback until that reset ([#14757](https://github.com/can1357/oh-my-pi/pull/14757) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/usage`, the status line usage segment and `/logout` treating every Google Antigravity account (and every Codex Team seat in one workspace) as the session's account, and `omp usage` not listing such an account when its usage fetch failed ([#14900](https://github.com/can1357/oh-my-pi/pull/14900) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Tern showing an agent as finished when automatic context maintenance ends partway through a turn; omp now keeps reporting the turn's working state until the turn actually ends ([#14917](https://github.com/can1357/oh-my-pi/pull/14917) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed the terminal title and Tern busy state staying in the working state after an interrupt cancels a scheduled retry or continuation before it starts ([#14917](https://github.com/can1357/oh-my-pi/pull/14917) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed Anthropic web search through a custom `anthropic-messages` provider sending a plain API-key request even though the provider's conversations use Claude Code request shaping; search now honors the model's `isOAuth` like the main conversation, so keys that only work with that shaping no longer fail with HTTP 429 `rate_limit_error` ([#14919](https://github.com/can1357/oh-my-pi/pull/14919) by [@farnoy](https://github.com/farnoy))
- Fixed Anthropic web search spreading the model's configured headers under its own without the main conversation's case-insensitive merge and enforced-header filtering, so a configured `authorization` header could replace the credential or join it comma-separated on the wire ([#14919](https://github.com/can1357/oh-my-pi/pull/14919) by [@farnoy](https://github.com/farnoy))

### Removed

- Removed the `PI_SUBPROCESS_CMD` environment variable; subagents run in-process and never read it ([#14632](https://github.com/can1357/oh-my-pi/pull/14632) by [@jorgoose](https://github.com/jorgoose))

## [18.8.4] - 2026-10-08

### Changed

- Agent Hub keeps existing agents in place while open; new agents appear first in the flat roster or within their tree sibling group ([#13066](https://github.com/can1357/oh-my-pi/pull/13066) by [@kmccleary3301](https://github.com/kmccleary3301))

### Fixed

- Fixed `omp auth-broker serve` logging every client as `unknown` (or as whatever a caller put in `X-Forwarded-For`); it now logs the socket address, with `--trust-proxy-headers` for brokers behind a reverse proxy ([#14762](https://github.com/can1357/oh-my-pi/pull/14762) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed relative file links in Tern assistant replies opening against the folder omp was started in after `/wt` or `/move`; they now open the file in the session's working directory ([#14879](https://github.com/can1357/oh-my-pi/pull/14879) by [@H4vC](https://github.com/H4vC))
- Fixed the BTW history, git shortcuts, and autoresearch sheets in Tern having no Close button, and the plan review sheet having no Cancel button ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed the agent transcript viewer and `/annotate` review in Tern having no clickable way out; both now show a clickable `esc` at the top right ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed the `/move` folder picker in Tern having only key hints; Accept (Tab), Cancel (Esc) and Confirm (Enter) are now clickable buttons ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed `omp usage` listing a second "7 days … not reported" row for a Codex account that reports only a weekly window, and misaligning its rows against accounts that report a 5-hour window too ([#14760](https://github.com/can1357/oh-my-pi/pull/14760) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp auth-gateway serve` showing the usage and credential health of providers listed in `disabledProviders`, account emails included, on `/v1/usage` and `/v1/credentials/check` ([#14755](https://github.com/can1357/oh-my-pi/pull/14755) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage --history` on auth-broker clients always reporting no recorded history; it now reads the broker host's history, as `omp usage clients` already does ([#14758](https://github.com/can1357/oh-my-pi/pull/14758) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage --history` and `omp usage clients` dying with a stack dump when the auth broker is unreachable or lacks the endpoint; they now print a one-line error and exit nonzero
- Fixed `omp usage --history` showing two Codex accounts that share an email under the same name; they now carry the same qualifier as `omp usage` ([#14767](https://github.com/can1357/oh-my-pi/pull/14767) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `--model`, `/model` and `/switch` with a bare id that several logged-in providers carry ignoring `modelProviderOrder` and recent use; they now pick the same provider as `modelRoles`, and `omp bench`, compress, cleanse and the stdio auth gateway follow the same ranking ([#14517](https://github.com/can1357/oh-my-pi/pull/14517) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage --provider <id>` blaming a missing usage endpoint when no credentials are stored for that provider, and `omp usage invalidate --provider <id>` reporting success for it; both now list the providers that have credentials ([#14763](https://github.com/can1357/oh-my-pi/pull/14763) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage` labelling an exhausted account "inside reserve" on its account-policy line; it now says "exhausted" ([#14764](https://github.com/can1357/oh-my-pi/pull/14764) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/new` keeping plan mode (and its plan-role model) or goal mode active in the new session ([#14653](https://github.com/can1357/oh-my-pi/issues/14653))
- Fixed parallel first bash calls each spawning an rc-sourcing shell ([#14680](https://github.com/can1357/oh-my-pi/pull/14680) by [@H4vC](https://github.com/H4vC))
- Fixed the todo list's auto-clear never firing while subagents were streaming progress ([#14692](https://github.com/can1357/oh-my-pi/pull/14692) by [@H4vC](https://github.com/H4vC))
- Fixed memory growth while ACP client-terminal commands run ([#14680](https://github.com/can1357/oh-my-pi/pull/14680) by [@H4vC](https://github.com/H4vC))
- Fixed ephemeral side-channel replies (idle recap, completion probe, `runEphemeralTurn`) truncating in quadratic time ([#14695](https://github.com/can1357/oh-my-pi/pull/14695) by [@H4vC](https://github.com/H4vC))
- Sped up `omp compress` by tokenizing each draft once per round ([#14702](https://github.com/can1357/oh-my-pi/pull/14702) by [@H4vC](https://github.com/H4vC))
- Fixed the agent slowing down while streaming long eval cells ([#14704](https://github.com/can1357/oh-my-pi/pull/14704) by [@H4vC](https://github.com/H4vC))
- Fixed quadratic slowdown reading large Python kernel output (big reprs, base64 images) ([#14704](https://github.com/can1357/oh-my-pi/pull/14704) by [@H4vC](https://github.com/H4vC))
- Sped up TUI repaints of live stream and `/record` rows ([#14705](https://github.com/can1357/oh-my-pi/pull/14705) by [@H4vC](https://github.com/H4vC))
- Fixed quadratic slowdown in `omp cleanse` on large tsc/clippy/golangci output ([#14706](https://github.com/can1357/oh-my-pi/pull/14706) by [@H4vC](https://github.com/H4vC))
- Fixed documents served as `application/octet-stream` being downloaded twice ([#14708](https://github.com/can1357/oh-my-pi/pull/14708) by [@H4vC](https://github.com/H4vC))
- Fixed collab TUI guests rebuilding the transcript per token ([#14715](https://github.com/can1357/oh-my-pi/pull/14715) by [@H4vC](https://github.com/H4vC))

## [18.8.3] - 2026-10-07

### Fixed

- Fixed repeat opens of the model picker, model hub, or agents views stacking duplicates; the open one is brought forward instead ([#14846](https://github.com/can1357/oh-my-pi/pull/14846) by [@H4vC](https://github.com/H4vC))

## [18.8.2] - 2026-10-07

### Fixed

- Fixed long Anthropic sessions with repeated tool screenshots exceeding the request-size limit; live images are now trimmed by bytes, recoverable 413s may compact older history, and terminal subagent failures reach the parent ([#14453](https://github.com/can1357/oh-my-pi/issues/14453)).
- Fixed Tern browser tabs opened with a `url` returning before the page loaded, which made the first `observe()` or `title()` read the blank page.

### Removed

- Removed per-call `model` overrides from `task`, eval `agent()`, and `workpool()`; subagents use configured agent models and settings.

## [18.8.1] - 2026-10-07

### Added

- Added account pools for task agents, allowing an agent and its related work—including advisors, title generation, subagents, and resumed sessions—to use only specified OAuth accounts and fail rather than fall back to another account or an API key.
- Added `omp usage accounts` to list OAuth account provider and identity keys without exposing tokens, making account-pool configuration easier.

### Changed

- Generated session titles now include their card icon and short code, so the `/resume` picker and session listings show this context; `title.icons` applies to newly generated titles.
- Symlinked routing configurations now reload when an intermediate file or profile-directory link is replaced, without requiring a session restart.

### Fixed

- Improved Tern `ask` questions so the question no longer obscures the transcript and can be answered while reviewing and scrolling through the relevant context.
- Added warnings for unrecognized `compat` keys in `models.yml` while continuing to load the configuration; warnings identify the file and key path.
- Fixed `/new` so new sessions reset plan and goal modes, todo state, and related planning configuration instead of carrying stale state forward; fresh prewalk behavior is also restored after handoffs, cancellations, or automatic recovery.
- Fixed OAuth alias login and logout flows so they refresh the underlying provider's models, report authentication state correctly, and list and remove the accounts associated with that provider.
- Fixed model speed statistics so throughput from non-default OpenAI or Codex service tiers is kept separate and displayed for the tier used by the session.
- Fixed stale model catalogs remaining in memory after provider or catalog refreshes.
- Fixed `write` and `edit` from hanging or exhausting memory when given FIFOs, terminals, device files, or other non-regular targets; unsupported targets are now rejected safely.
- Fixed long conversations from losing user and tool-result images when the conversation also contained assistant-generated images.
- Fixed `local://` session paths from escaping their intended storage directory when given `.` or `..` session identifiers.
- Fixed `omp gc --archive --apply` from leaving orphaned session-title records behind.
- Fixed `/retry` after an interrupted reopened `ask` prompt when an extension had registered a context handler.
- Fixed browser relay sessions from missing cross-origin iframe content that loaded before the tab was opened.
- Fixed browser clicks on invisible native radio and checkbox inputs, including controls commonly used by GOV.UK forms.
- Fixed `/model` so selecting the model already assigned to a project's default role still switches to that model correctly.
- Fixed `wait` and background task state when a completion has already been consumed elsewhere, preventing premature interruption and incorrect idle detection.
- Fixed repeated coding-plan fallback confirmations after declining a fallback in cases involving changing thinking settings, unavailable quota data, or account recovery.
- Fixed Python evaluation when the shared runner temporary directory was created by another user.
- Added RPC support for completing multi-select `ask` questions without relying on TUI keyboard navigation.
- Corrected tool behavior and configuration documentation for `read`, background `bash`, Python evaluation, replace editing, goal removal, and `advisor.immuneTurns`.
- Fixed custom glob backends from hanging indefinitely; scans now respect the tool deadline and report incomplete results when necessary.
- Fixed `--resume <path>` from silently creating a new session for a missing path; it now reports the missing path, consistent with `--fork <path>` and `--resume <id>`.

## [18.8.0] - 2026-10-07

### Added

- Write-tool previews now render as files stream: SVG files appear as images, and Mermaid files (`.mmd` and `.mermaid`) appear as diagrams. Tern also previews supported 3D model formats (`.obj`, `.ply`, `.wrl`, `.x3dv`, `.stl`, `.gltf`, and `.usda`) and renders SVG writes as SVG figures.
- Added the `title.icons` setting to show session title cards with a Nerd Font glyph and emoji fallback (`nf+emoji`, default), always the emoji (`emoji`), or as plain titles (`boring`).
- Added the `title.generator` setting to name sessions from a fork of the reply (`fork`, default) or with the title model only (`tiny`).

### Changed

- Session titles are generated using the session's model when possible, with a fallback to the lightweight title model; `TITLE_SYSTEM.md` continues to override the title prompt.
- Session titles now include a card index, icon, and short code, with appropriate Nerd Font rendering in Tern panes.
- When Nerd Font symbols are unavailable, session titling requests only an emoji.
- Subagent completion indicators now advance to 99% when the subagent submits its result.
- In Tern panes, headed and headless browser opens are shown in Tern picture-in-picture by default; set `app.tern: false`, `browser.tern`, or `PI_BROWSER_TERN=0` to open Chromium instead.
- In Tern panes, `/fork` opens the fork in a neighboring pane while preserving the original session.
- Tern's empty composer now shows the session title, or “What are we cooking?” when no title is available.
- Tern todo cards now display their checklist by default and can be collapsed by clicking the card header.
- Improved performance across browser extraction, web and document fetching, file tools, search, session handling, LSP/DAP, MCP, subagents, SSH file operations, image processing, voice and dictation, collaboration, and large-output or large-file workflows.
- Prompt history search now updates shortly after typing stops while Enter and mouse selections use the latest query.
- Improved responsiveness and reduced resource usage for long sessions, large files and documents, streaming evaluations, terminal graphics, live voice calls, and other high-volume workflows.
- Hosts that are not supported Mastodon, Lemmy, or Discourse instances are no longer repeatedly probed for those services, improving URL-fetch performance.

### Fixed

- Fixed a message sent while an earlier title request was still running never getting its own try at naming the session when that request came back empty.
- Fixed `/new` incorrectly carrying plan mode, its plan-specific model, or goal mode into the new session.
- Fixed todo lists failing to auto-clear while subagents streamed progress.
- Fixed memory growth during ACP client-terminal commands.
- Fixed freezes after large pastes containing unclosed tags.
- Fixed slowdowns when processing long evaluation output, large Python kernel results, compiler/linter output, and ephemeral side-channel replies.
- Fixed documents served as `application/octet-stream` being downloaded twice.
- Fixed collaboration guests rebuilding the transcript excessively during streaming.

## [18.7.0] - 2026-10-06

### Added

- Added last-chance consumption of eligible banked Codex and Claude resets expiring within five minutes when auto-redeem is enabled, even with low usage or reserved credits.
- Added inline rendering of agent-generated SVG diagrams, charts, and mockups, with theme-aware colors and a `tui.renderSvg` setting to disable it.
- Added automatic chart generation for numeric tables, configurable with `tui.autoGraph` (`always`, `smart`, or `off`). The agent now chooses suitable visual formats—including charts, Mermaid, SVG, tables, or prose—based on the content. Charts and this guidance apply to the main TUI session only, not to subagents, print, RPC, or ACP.
- Added first-class JSON and JSONL querying to the `read` tool with `?q=<jq-filter>`, including in-process filtering, raw or compact output, and offset/limit pagination for efficient large-file access.
- Added `/prewalk off` to cancel a pending model handoff without changing the active model, saved prewalk setting, or continuation history.
- Added logout support to RPC clients through `get_logout_accounts` and `logout`, with matching methods in the TypeScript, Python, Go, and Rust SDKs.
- Added custom model-kind declarations for providers and extensions, allowing image, speech, embedding, judge, and other supported model roles to be registered and routed correctly.
- Added working-directory reporting for Tern terminal sessions so the native composer bar can display the current folder.

### Changed

- Improved JSON and JSONL query streaming and pagination to reduce resource usage, support partial results, and provide clearer continuation between result pages.
- Clarified the `read` tool documentation with complete examples for requesting line ranges.

### Fixed

- Fixed model-preset tests failing when provider credentials are configured in the environment.
- Fixed unauthenticated Macs auto-selecting the on-device Apple model when the default prompt exceeds its context window; Apple remains selectable explicitly.
- Fixed replay and compaction tests failing after bundled model roster changes.
- Fixed standalone builds failing when the native addon archive could not be resolved.
- Fixed JSON query parsing and parameter decoding for filters beginning with hyphens and other encoded query values.
- Fixed task execution after settings could not be saved; subagents now use the current in-memory settings while the save failure is reported as a warning.
- Fixed prewalk and model-recovery state across `/new`, handoffs, cancellations, and automatic recovery.
- Fixed login, logout, model refresh, and provider-status reporting for aliased providers such as `openai-codex-device`.
- Fixed model speed statistics mixing fast service-tier results into standard-tier averages; `/models` now reports the applicable tier separately.
- Fixed the `write` and `edit` tools hanging or consuming excessive resources when given FIFOs, terminals, device files, or other non-regular targets; unsupported targets are now rejected safely.
- Fixed long conversations losing user or tool-result images because assistant-generated images were counted against provider image limits.
- Fixed local session paths for special session IDs such as `.` and `..` so they cannot escape the intended storage directory.
- Fixed `omp gc --archive --apply` leaving orphaned session-title records behind.
- Fixed `/retry` after an interrupted process exit while an extension-driven prompt was reopening.
- Fixed browser relay sessions failing to discover or interact with cross-origin iframe content that loaded before the tab was opened.
- Fixed browser clicks on visually styled radios and checkboxes whose underlying inputs are hidden.
- Fixed `/model` failing to switch when selecting the model already assigned to a project's default role.
- Fixed `wait` returning early when a background completion had already been consumed by another operation.
- Fixed symlinked routing configurations failing to reload after their target links were replaced.
- Fixed repeated coding-plan fallback confirmations in cases involving changing thinking settings, unavailable quota information, or account recovery.
- Fixed Python evaluation failing when a shared runner temporary directory was created by another user.
- Fixed RPC clients being unable to complete multi-select questions in multi-question `ask` prompts.
- Corrected inaccurate tool and setting descriptions, including `read` ranges, background `bash` behavior, Python evaluation capabilities, edit replacement guidance, goal removal behavior, and `advisor.immuneTurns`.
- Fixed custom glob backends hanging indefinitely; scans now honor tool deadlines and cancellation.
- Fixed `--resume <path>` silently creating a new session when the specified path did not exist; it now reports the missing path.
- Fixed `/settings` opening duplicate menus when invoked while the settings menu was already open.
- Fixed native Git operations resolving repositories incorrectly when run through symbolic links.

## [18.6.3] - 2026-10-06

### Breaking Changes

- `createAgentSession` now throws `Could not restore model <provider/id>` when a resumed session's saved models cannot be restored, and `AgentSession.switchSession` throws it, keeping the current session, when it opens such a session; both still fall back with a warning when `hasUI` is set and `retry.modelFallback` is on, and hosts that cannot show that warning can opt out with `allowSessionModelFallback: false` ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).

### Added

- Added an agents HUD pill counting running subagents, opening the agent hub on click
- In Tern the thinking level shows as the composer model chip's icon instead of a separate chip, still cycling on click, while `statusLine.compactThinkingLevel` (Compact Thinking Level, on by default) is on
- Added `computer.zoom()` and window-local `zoom()` in JavaScript and Python Eval, with native-detail region captures that preserve full-screenshot click coordinates.
- Added window menus, combined `observe()`, native application discovery/launch, live display handles, bounded input holds, human-approved task control, and macOS Space helpers in both Eval languages.
- RPC `open_session` and `switch_session` accept an optional `provider`/`modelId` pair that binds the session to that model instead of its saved one, as `--model` does at startup; `RpcClient.openSession()`/`switchSession()` and the Python client's `open_session()`/`switch_session()` take it too ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm))
- Added `compat.statefulResponses` to `models.yml`, so a provider or model can opt into or out of stored Responses chaining without the process-wide `PI_OPENAI_STATEFUL` ([#13686](https://github.com/can1357/oh-my-pi/pull/13686) by [@alphastorm](https://github.com/alphastorm)).
- Added the `app.stt.pushToTalk` keybinding, defaulting to `Space`, so push-to-talk can be remapped or disabled independently from speech-to-text and `app.stt.toggle` ([#6592](https://github.com/can1357/oh-my-pi/pull/6592) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added an `expandThinkingBlocks` setting that keeps finished thinking blocks expanded in Tern instead of collapsing them at turn end ([#14519](https://github.com/can1357/oh-my-pi/pull/14519) by [@H4vC](https://github.com/H4vC))
- RPC clients can show and toggle `/slow`: `get_state` reports `slowModeSupported`, `slowModeEnabled`, and a provider-neutral `usageLimit` (wrap-up or low-priority stage, with reset times for the client's timezone), and the new `set_slow_mode` command turns it on or off; the TypeScript client and the generated Python, Go, and Rust SDKs gain a matching `setSlowMode`/`set_slow_mode`/`SetSlowMode` method ([#14153](https://github.com/can1357/oh-my-pi/pull/14153) by [@andrebrait](https://github.com/andrebrait))
- RPC clients can now stop a turn the way Esc does in the TUI with `abort_and_restore_queue`: queued steering and follow-up messages are taken back and returned for the editor instead of running in a new turn after the abort ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- RPC `remove_queued_message` now returns the removed message's images, so clients can put an edited queued message back in the editor with its attachments ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- Added `/btw` side questions for RPC hosts: `btw` asks one (or a follow-up in an earlier topic) while the main turn keeps running, the answer streams as `btw_delta` / `btw_record` frames, `btw_cancel` stops it, and `get_btw_history` lists the session's BTW history shared with the TUI ([#14110](https://github.com/can1357/oh-my-pi/pull/14110) by [@andrebrait](https://github.com/andrebrait))
- Added the `providers.muse-code.storeResponses` setting (off by default; `PI_MUSE_STORE_RESPONSES` overrides it) to store Muse Code results on Meta's servers, so a turn whose connection drops is recovered instead of re-run ([#14534](https://github.com/can1357/oh-my-pi/pull/14534) by [@abilliontokens](https://github.com/abilliontokens)).

### Changed

- In Tern the spinner, elapsed time and intent share one activity line with the todo, which stays in place between turns, and the tok/s readout moves into the composer bar after the thinking level
- Computer-use desktop captures now default to the focused window's monitor, with primary-monitor fallback; `computer.display: all` remains available explicitly.
- Computer-use guidance selects AX for semantic controls and screenshots for custom-drawn surfaces, with grouped actions and explicit state verification.
- Bash commands that print binary or other non-UTF-8 output no longer stall while their output is decoded ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Edit previews stay responsive while long edits stream, and `read` parses large files for block context off the main thread ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- While a `sloppy`-mode edit streams, its preview no longer guesses an edit for a `*** Find` whose `*** Replace` has not arrived yet; the preview of an earlier file section that ends in a bare `*** Find` still matches what will be applied ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- `@` file mentions autocomplete faster in large repositories ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Large mermaid flowcharts and state diagrams render much faster while a response streams ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Diff hunk headers now name the enclosing function the way git does: the nearest earlier line starting with a letter, `_` or `$`, cut to 80 bytes; `#`-prefixed and indented lines are no longer picked ([#14521](https://github.com/can1357/oh-my-pi/pull/14521) by [@H4vC](https://github.com/H4vC))
- Made browser `tab.observe()` much faster on element-heavy pages, especially over the relay: listed elements are resolved to handles only when `tab.id(n)` uses them ([#14431](https://github.com/can1357/oh-my-pi/pull/14431) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed Tern tooltips naming keys with Nerd Font icons Tern's UI font lacks (a box after "Thinking effort"); they show keycaps (`⇧⇥`) whatever the symbol preset
- Fixed `/new`, session switches, and Esc aborts hanging for up to 30 seconds while an extension's `message_end` hook was still running; they now wait only for end-of-turn maintenance.
- Fixed Tern's per-turn usage row showing a 24-hour time while the user message above it showed a 12-hour time; both now follow the terminal's clock ([#14565](https://github.com/can1357/oh-my-pi/pull/14565) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed Tern's agents pill missing while a finished subagent runs again after an IRC message woke or revived it; it now counts running agents as the status-line badge does
- Fixed browser `tab.goto`, `back`, `forward` and `reload` timing out on pages whose ad, chat or other iframe never finishes loading, although the page itself had loaded ([#14421](https://github.com/can1357/oh-my-pi/pull/14421) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the token count after a snapcompact compaction (divider and RPC result) disagreeing with the context count right after it ([#14291](https://github.com/can1357/oh-my-pi/pull/14291) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed snapcompact archives stopping at 17 frames on models that read 1568px frames (OpenAI, Codex, and Claude before Opus 4.7); they now keep 26 under the same 3 MB image payload cap, and an archive whose frames run heavier than estimated is re-rendered with fewer frames instead of being rejected ([#14277](https://github.com/can1357/oh-my-pi/pull/14277) by [@will-bogusz](https://github.com/will-bogusz)).
- Preserved original-detail image pixels through both Eval runtimes instead of resizing screenshots again and requiring model-side coordinate conversion.
- Retired queued and in-flight native input on computer-run cancellation and teardown, including unawaited operations, without canceling later runs.
- Fixed the `/usage` sheet in Tern missing the Close button the other report sheets have ([#14455](https://github.com/can1357/oh-my-pi/pull/14455) by [@H4vC](https://github.com/H4vC)).
- Fixed a browser page load abandoned by cancelling a run still replacing the page afterwards; the cancelled load is now stopped, so a run that had taken over request interception also returns at once instead of failing with "Failed to restore browser request interception". Cancelling a run that is not navigating leaves the page's in-flight requests alone ([#14425](https://github.com/can1357/oh-my-pi/pull/14425) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cancelling a bash command on Windows sometimes terminating an unrelated program ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `umask` in a bash command changing the umask of omp itself ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed a mermaid `xychart` whose axis range is finer than floating-point precision freezing the terminal ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed resuming a session whose saved model cannot be restored silently sending its transcript to another model. At startup, `--continue`/`--resume` in print, JSON, RPC, and `rpc-ui` modes (and in the TUI with `retry.modelFallback: false`) now exits with an error naming the model instead of using the settings-default or first available model. At runtime, RPC `open_session` and `switch_session`, ACP session load and fork, and extension session switches fail with `Could not restore model <provider/id>` and keep the current session instead of continuing on the current model; TUI `/resume` warns `Could not restore model <provider/id>. Using <provider/id>`, or fails with the error when `retry.modelFallback` is off. `/resume` also restores models from discovery-backed providers the way startup does ([#12274](https://github.com/can1357/oh-my-pi/issues/12274), [#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).
- Auto-retry no longer switches to the fallback chain when Codex's native turn lane rejects live steering after the response streamed reasoning; the turn retries on the same model with the steering message as ordinary input, and the chain is consulted only once no same-model retry is left ([#14242](https://github.com/can1357/oh-my-pi/pull/14242) by [@alphastorm](https://github.com/alphastorm))
- Fixed bash commands re-running a direnv `.envrc` (and devenv setup) on every call; an unchanged direnv environment is now reused ([#14310](https://github.com/can1357/oh-my-pi/pull/14310) by [@n3oney](https://github.com/n3oney)).
- Fixed the `computer` guide telling the model that refs from its earlier `ax()` reads expire; it now says an element keeps its `[ref=eN]` across reads until its role or label changes ([#14485](https://github.com/can1357/oh-my-pi/pull/14485) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed snapcompact inline imaging judging savings by the gateway's frame cost instead of the reading model's ([#14286](https://github.com/can1357/oh-my-pi/pull/14286) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed a session running past local midnight losing its earlier Claude reasoning (or failing with a 400 under strict thinking binding) because a message you sent mid-turn was rewritten with the new date ([#14339](https://github.com/can1357/oh-my-pi/pull/14339) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed OpenAI and Codex Remote Compaction V2 dropping a `/skill:` or collab prompt you sent from the kept history, and kept screenshots inflating the post-compaction token count and discarding speculative compactions ([#14247](https://github.com/can1357/oh-my-pi/pull/14247) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cold-resumed subagents losing signed thinking because their system prompt blocks were joined ([#14338](https://github.com/can1357/oh-my-pi/pull/14338) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the first kept assistant turn losing its thinking after Anthropic native compaction, including after a date or working-directory change and on later compactions ([#14251](https://github.com/can1357/oh-my-pi/pull/14251) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Claude rejecting or dropping the thinking kept after a compaction when the date or working directory had changed during a tool call in the kept turns; the date/cwd reminder those turns were sent with is no longer removed ([#14502](https://github.com/can1357/oh-my-pi/pull/14502) by [@H4vC](https://github.com/H4vC))
- Fixed browser `tab.waitForDownload()` and `tab.downloads()` reporting a path that does not exist when another open tab set a different `downloads` directory ([#14434](https://github.com/can1357/oh-my-pi/pull/14434) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed subagents keeping the MCP tools they started with after `/mcp reload` or adding or removing an MCP server; running and revived subagents now follow the main session's MCP tools ([#14441](https://github.com/can1357/oh-my-pi/pull/14441) by [@abilliontokens](https://github.com/abilliontokens)).
- Fixed the browser relay failing its first command on a tab that DevTools or another debugger extension already had open ([#14224](https://github.com/can1357/oh-my-pi/pull/14224) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser runs through the relay hanging and failing on pages with cross-origin iframes (embedded sign-in, payment or help widgets) ([#14228](https://github.com/can1357/oh-my-pi/pull/14228) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser clicks on Chromium and Tern tabs landing on the surrounding paragraph, without following the link, when the link wraps across two lines ([#14229](https://github.com/can1357/oh-my-pi/pull/14229) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tab and element-handle clicks and `check`/`uncheck` on an element that never becomes clickable timing out with no reason; the timeout now names the last failed check, such as `display:none` ([#14230](https://github.com/can1357/oh-my-pi/pull/14230) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `check()`, `uncheck()` and `click()` refusing or timing out on custom-styled checkboxes and radios whose real input is transparent or drawn over by its label ([#14231](https://github.com/can1357/oh-my-pi/pull/14231) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp auth-gateway serve` advertising and routing models from providers listed in `disabledProviders`; `omp auth-gateway check` now skips those providers' credentials too ([#14234](https://github.com/can1357/oh-my-pi/pull/14234) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls in relay mode each waiting 35 seconds after Chrome quit and then reporting that the extension "never connected"; they now fail at once and say it disconnected ([#14236](https://github.com/can1357/oh-my-pi/pull/14236) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/shake` and other history rewrites during a running tool call leaving the context meter stale and dropping that tool call from the agent's history ([#14261](https://github.com/can1357/oh-my-pi/pull/14261) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a session using a custom `browser.relayUrl` port stopping the browser relay that other sessions were using on a different port ([#14407](https://github.com/can1357/oh-my-pi/pull/14407) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.click(selector)` failing at once with "matched no visible element" when the page renders the target a moment later; it now waits like `tab.fill`, `tab.type` and `tab.dblclick` ([#14408](https://github.com/can1357/oh-my-pi/pull/14408) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.fill()` and `tab.type()` on a disabled or read-only field wiping it and typing into whichever field had focus while reporting success; they now fail with the reason ([#14412](https://github.com/can1357/oh-my-pi/pull/14412) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.fill(selector, "")` clearing a field without telling the page, so React and Vue forms kept and submitted the old value; the clear now fires `input` and `change` ([#14413](https://github.com/can1357/oh-my-pi/pull/14413) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.waitForDownload()` missing a download started by the next tab action on tabs opened without a `downloads` directory; the file landed in the browser's default folder and the wait timed out ([#14417](https://github.com/can1357/oh-my-pi/pull/14417) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `browser.open` failing with a bare `[object ErrorEvent]` when the browser's debugger websocket refuses the connection; the error now names the endpoint and why it failed ([#14418](https://github.com/can1357/oh-my-pi/pull/14418) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tab evaluations hanging when the page redirected again while the tab was being read; they now run on the page the redirect landed on ([#14423](https://github.com/can1357/oh-my-pi/pull/14423) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser dropdown selection resetting to the first option when given an option's visible label instead of its value, on Chrome and cmux tabs and element handles; `select()` now fails and leaves the dropdown unchanged when a value matches no option, on every backend ([#14226](https://github.com/can1357/oh-my-pi/pull/14226) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser key combos such as `Control+a` failing on Chrome tabs, frames and elements, and macOS editing shortcuts and clipboard copy/paste doing nothing ([#14225](https://github.com/can1357/oh-my-pi/pull/14225) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.extract("text")` running headings, paragraphs, list items and table cells together on one line, and leaking `<script>`/`<style>` text with a `selector` ([#14227](https://github.com/can1357/oh-my-pi/pull/14227) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp dry-balance` saving a 30-day session pin to `agent.db` for every sampled session id ([#14512](https://github.com/can1357/oh-my-pi/pull/14512) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp dry-balance` rejecting `--config`; it now applies the overlay like `PI_CONFIG_FILES`, so account-policy experiments route as configured ([#14513](https://github.com/can1357/oh-my-pi/pull/14513) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp dry-balance` failing to resolve credential-scoped dynamic models, such as Factory Droid's, that `omp models` lists ([#14514](https://github.com/can1357/oh-my-pi/pull/14514) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser element right and double clicks (`click({ button, count })`) becoming one left click on Tern and cmux tabs; cmux now refuses the buttons and counts it cannot press ([#14232](https://github.com/can1357/oh-my-pi/pull/14232) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `open` and `tab.observe()` reporting a fixed 1365x768 viewport on relay, attached and visible browsers instead of the tab's real window size and pixel ratio ([#14409](https://github.com/can1357/oh-my-pi/pull/14409) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser runs and helper calls failing with "Failed to restore browser request interception" after their work had finished, including every call on pages with a hung cross-site iframe ([#14410](https://github.com/can1357/oh-my-pi/pull/14410) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `browser.open` on a page that outlasts its `timeout` closing the tab with a bare "Browser open timed out"; the tab now stays on what loaded and the error names the navigation and `browser.tab(name)`. A new tab whose navigation fails outright, or whose open is cancelled, is still closed ([#14420](https://github.com/can1357/oh-my-pi/pull/14420) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.observe()` leaving out every control inside iframes (embedded sign-in, payment and checkout forms), including iframes inside a web component's shadow root under `selector`, so they got no ids to act on. An iframe that does not answer within 5 seconds is left out and skipped by later observations until it navigates ([#14415](https://github.com/can1357/oh-my-pi/pull/14415) by [@will-bogusz](https://github.com/will-bogusz))
- Pressing Esc while a queued message is about to be sent now restores it to the editor instead of the stopped turn recording it ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- Fixed `edit` silently dropping late LSP diagnostics from slow servers such as tsserver; they now arrive like they do for `write` ([#14214](https://github.com/can1357/oh-my-pi/issues/14214))
- Fixed multi-question `ask` dropping the ticked options of a multi-select question when the user also typed an "Other" answer; the model now receives both ([#14369](https://github.com/can1357/oh-my-pi/issues/14369))
- Focused subagents can now recall queued steering messages with Alt+Up or Shift+Up without restoring a message from the main session ([#14464](https://github.com/can1357/oh-my-pi/issues/14464)).
- Fixed results that a focused subagent submits after you prompt it in the TUI never reaching the parent agent: the subagent's `agent://<id>` artifact is now updated and the parent receives the completion ([#14428](https://github.com/can1357/oh-my-pi/issues/14428))
- Computer use on KDE Plasma Wayland now types printable characters through the keymap KWin announces instead of failing with "no usable XKB keymap was announced", and `type("…\n")` presses Enter ([#13848](https://github.com/can1357/oh-my-pi/issues/13848))
- Budget-stopped subagents no longer issue automatic retry requests after being reported cancelled; they remain available for explicit resumption ([#13892](https://github.com/can1357/oh-my-pi/issues/13892)).
- Fixed switching models mid-session keeping the previous model's `inlineToolDescriptors: auto` decision, which sent empty tool descriptions to the new model and failed with `function.description is required` ([#14200](https://github.com/can1357/oh-my-pi/issues/14200))
- Fixed advisors staying quota-paused when another account's temporary auth block ends at the retry wait limit ([#14551](https://github.com/can1357/oh-my-pi/issues/14551)).
- Fixed `omp worktree add` and other git operations failing with `git open: … does not appear to be a git repository` when the checkout directory name ends in `.git` ([#14553](https://github.com/can1357/oh-my-pi/issues/14553))
- Fixed Mnemopi embedding workers (and other local-model workers) staying alive and holding gigabytes of RAM after the omp process that started them exited mid-embedding ([#14340](https://github.com/can1357/oh-my-pi/issues/14340))
- Fixed a supervised PTY service on Windows hanging when it asks the terminal for the cursor position; the launch broker now answers the query as it does on Linux and macOS

## [18.6.2] - 2026-10-04

### Fixed

- Fixed snapcompact's short final frames preventing vision-backed sessions from continuing on backends that reject 32px-or-smaller images ([#14355](https://github.com/can1357/oh-my-pi/issues/14355)).
- Fixed the agent's `goal` calls asking for approval under `--approval-mode write`, which paused goal-mode loops at `complete`; `always-ask` still prompts for goal changes but not `get` ([#14368](https://github.com/can1357/oh-my-pi/issues/14368))
- Fixed MCP server connection progress popping up a toast for every server that connects or fails in native terminals such as Tern; it now shows only in the classic terminal transcript

## [18.6.1] - 2026-10-04

### Fixed

- Fixed waiting for subagent follow-up messages: responses now appear as background jobs that can be waited on or canceled, and are delivered only once.
- Improved `/switch` autocomplete so model and role suggestions use the same relevance ordering as the model picker, including support for `@role` aliases.
- Fixed concurrent `skill://` searches blocking other filesystem operations and delaying subagent artifact publication.
- Fixed compatibility checks for browser relays from other OMP versions and added guidance for resolving stale connection-refused errors.
- Fixed follow-up hashline edits being incorrectly rejected after earlier edits shifted anchored lines, while continuing to reject genuinely stale line references.
- Fixed `pi.exec()` reporting exit code `0` when a process was terminated by a timeout or signal; terminated processes now report code `-1`.
- Fixed `/collab` guests being unable to respond to setting-change approval and tool-issue report consent prompts.
- Fixed follow-up hashline edits being rejected as anchored on lines "never displayed" after an earlier edit shifted those lines, when the replacement carries the anchored content; genuinely stale line numbers are still rejected ([#14254](https://github.com/can1357/oh-my-pi/pull/14254) by [@abilliontokens](https://github.com/abilliontokens)).
- Fixed long `/btw` answers in Tern being clipped with no way to scroll: `/btw` now answers in the scrollable BTW history sheet ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))
- Fixed `/btw` answers longer than 4 KiB being cut off with `[…truncated]` once they finished ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))
- In Tern, Esc puts the BTW history sheet away while an answer keeps streaming (`/btw` reopens it); `x` cancels the answer ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))

## [18.6.0] - 2026-10-03

### Added

- The `/models` Roles view shows which saved model preset is in effect, and Ctrl+←/→ (or `p`/`P` on the role rows, for macOS where Ctrl+←/→ switches Spaces) switches to the next or previous one, in Tern and text mode ([#14210](https://github.com/can1357/oh-my-pi/pull/14210) by [@H4vC](https://github.com/H4vC))

### Changed

- Picking a model for a role in `/models` now puts the cursor on the model list, so ↑/↓ choose a model and Enter assigns it right away instead of moving through the sidebar and dropping the role selection; ← still reaches the providers ([#14210](https://github.com/can1357/oh-my-pi/pull/14210) by [@H4vC](https://github.com/H4vC))
- Sped up secret redaction on long conversations: it no longer slows down as history grows ([#14213](https://github.com/can1357/oh-my-pi/pull/14213) by [@H4vC](https://github.com/H4vC))
- Startup is faster with plugins that bundle large dependency trees: the extension loader no longer re-reads and re-checks the same files while loading them (e.g. ~280 ms → ~185 ms with the IDA MCP plugin) ([#14219](https://github.com/can1357/oh-my-pi/pull/14219) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed an `EPIPE: broken pipe` unhandled rejection crashing the session when a debug adapter, eval kernel, IDA worker, or RPC server exits mid-write (seen on Windows) ([#14196](https://github.com/can1357/oh-my-pi/pull/14196) by [@andrebrait](https://github.com/andrebrait))

## [18.0.6] - 2026-08-26

### Added

- Added fast, cached conventional commit message generation to the git TUI and `omp commit --legacy`, including automatic handling of whitespace-only changes, clearer commit scopes, and improved grammar and tense in generated summaries.
- The git TUI sidebar now supports collapsing and expanding the Unstaged and Staged sections, with keyboard shortcuts to stage or unstage an entire section.
- Long streaming thinking and reasoning output now continues into terminal scrollback during a turn instead of remaining clipped to the viewport.

### Changed

- `omp commit --legacy` now uses the same conventional commit message generation as the git TUI.
- The git TUI sidebar now groups new files separately from tracked changes in the Unstaged section, while Staged and commit file lists use a unified status-based view.
- Improved resilience when streaming output changes during rendering, preventing incomplete blocks from causing further display updates to fail.

### Fixed

- Commit-message generation errors in the git TUI now remain visible in the status bar instead of disappearing and returning to an idle state.
- Fixed `omp update` leaving standalone Windows binaries on the old version when stale Bun launcher metadata was present, and preserved launchers installed by a newer concurrent update during binary repair ([#9806](https://github.com/can1357/oh-my-pi/issues/9806)).
- Quitting `omp git` during commit-message generation now exits cleanly without leaving the process running.

## [18.0.5] - 2026-08-25

### Added

- Added append-only transcript declarations and stable-row APIs for components with immutable history prefixes.
- Added the `:img` read selector to rasterize local SVG and SVGZ files for vision input.
- Added side-by-side image and SVG previews to `omp git`, including Git LFS object resolution and clear placeholders for unavailable or unsupported binary content.
- Added the `omp if-bench` command for zero-tool instruction-following and working-memory benchmarking across models, with live progress and ranked results.
- Added `q` to quit the git TUI.
- Added advanced whitespace filtering to the git TUI, including formatting-only changes and import-only changes in TypeScript, JavaScript, Rust, and Go.
- Improved the git TUI sidebar by compressing single-child directory chains and separating new or untracked files from tracked changes.
- Added Yolo-Auto to `/login` and documented the `YOLO_AUTO_API_KEY` environment variable.
- Updated the OpenRouter `/login` flow to support browser-based sign-in and automatic API-key provisioning, while retaining support for pasted `sk-or-…` keys.
- Added DeepInfra support for the `image_gen` and `tts` tools, including provider selection and MP3 or WAV output for text-to-speech.

### Changed

- Standardized completed edit results with hashline-style paths and numbered previews across edit modes.
- Improved `omp git` responsiveness with immediate file rendering, progressive syntax highlighting, and deferred large-commit statistics.
- Documented that `retry.maxDelayMs: 0` permits provider-requested quota waits to continue until automatic retry, rather than enforcing a wait ceiling.
- Expanded git TUI navigation and file-management shortcuts, including refresh, stage/unstage, directory operations, hunk and file navigation, pane movement, diff-view selection, commit-form access, and paging.

### Fixed

- Fixed race condition where tunnel startup was incorrectly reported as failure on quick process exit
- Fixed Obsidian theme task instructions and usage-limit text becoming unreadable against dark backgrounds.
- Fixed marketplace-installed plugins failing to discover their `rules/` directories.
- Fixed advisor notes in `/tree` displaying internal XML wrappers instead of readable text.
- Fixed successful agent and subagent results being discarded when cleanup exceeded its deadline.
- Fixed exiting plan mode mid-turn so the active turn now stops immediately.
- Fixed Windows workstation context reporting a virtual display adapter instead of the physical GPU.
- Fixed numbered selector menus such as `/review` ignoring digit-key selection.
- Fixed the welcome screen failing to reflow after terminal resizing.
- Fixed transcript layout issues that could clip assistant text, leave stale tool cards, disrupt scrolling, or make large-session rendering and shutdown unreliable.
- Fixed streamed assistant responses failing when later provider updates revised earlier Markdown.
- Fixed cache-miss status placement after streamed assistant output.
- Fixed `/model` role-cycle icons overlapping their ordinal on full-width terminals.
- Fixed constrained `/collab` QR codes rendering as empty rows; the browser URL hint is now shown instead.
- Fixed `hub list` and child peer rosters incorrectly including parked agents in model context and restored accurate status counts.
- Fixed browser relay clients hanging when enabling the Runtime domain on a shared tab.
- Fixed interactive TTSR interruptions being displayed as errors after successful rule injection.
- Fixed fast tool completions leaving a persistent running summary that obstructed later output.
- Fixed the Windows console welcome header being duplicated after cold launch.
- Fixed git TUI hunk navigation feedback when the sidebar has focus and preserved file selection after staging or unstaging.
- Fixed long sessions becoming unrecoverable when providers reject histories exceeding message-count limits.
- Improved `/dump` output with readable system-notice titles and XML-fenced raw payloads.
- Fixed kernel sessions failing to recover when cancellation was reported by a dead kernel.
- Applied advisor tool-call loop limits to prevent repeated failing calls from continuing without bound.
- Fixed `lsp rename_file` incorrectly reporting inaccessible paths as nonexistent and mishandling uncertain destination checks.
- Fixed LSP clients with different launch or initialization configurations incorrectly sharing one process; reloading now replaces superseded clients.
- Fixed the browser relay leaving Chrome's debugging infobar attached after the last client released a tab.
- Fixed auto-retry countdowns appearing frozen during long provider-requested waits.
- Fixed the Todo HUD becoming stale after viewing a subagent and returning to the main session.
- Fixed child-task artifact links and duplicate `hub jobs` result bodies.
- Fixed `omp update` showing a POSIX reinstall command on Windows after a package-rename migration failure.
- Preserved `thinking.requiresEffort: false` in custom model configuration so supported local Qwen templates can disable thinking explicitly.
- Fixed project settings from shared capability files being able to replace an entire settings group when a conflicting non-object value is present; the conflicting value is now ignored with a warning.
- Jina Reader requests now use configured credentials for higher authenticated rate limits while remaining available anonymously.
- Fixed advisor session persistence and loading performance for repeated retries and unusually large advisor transcripts.
- Fixed failed `browser.open` calls leaving OMP-spawned application processes running when no tab could be acquired.
- Improved browser-handle failures with prompt, operation-specific timeout errors instead of waiting for the entire browser cell.
- Fixed autonomous runs becoming idle after thinking-only length stops during speculative handoff.
- Fixed completed assistant replies disappearing from the live transcript under viewport pressure.
- Accelerated SHA-2 and SHA-3 checksums on supported ARM64 hardware.
- Fixed large MCP tool payloads being stored redundantly on disk.

## [18.0.4] - 2026-08-24

### Added

- Added the `omp git` command (and `/git` slash command): an interactive, fullscreen repository TUI featuring a split/inline/hunk diff viewer with minimap scrollbar, syntax highlighting, a staging sidebar with line-level staging, commit composer with amend support, and author avatars. Supports keyboard navigation, full mouse interaction, and pinning views to specific commits via `omp git <revision>`.
- Overhauled the `/extensions` Extension Control Center into a fullscreen alternate-screen dashboard with mouse support, tab navigation, unified inspector views across extension types, live MCP connection management, and expandable details (`Ctrl+O`).
- Added support for live syntax highlighting in streaming markdown code blocks.
- Added an immediately editable startup composer for interactive launches, preserving drafts typed while session initialization is in progress.

### Changed

- Improved streaming markdown and thinking block rendering performance on long sessions by batching token updates and eliminating redundant re-processing.
- Optimized streaming edit verification and session restoration for large files and history-heavy sessions.

### Fixed

- Fixed invalid streamed edit patches occasionally reaching the edit tool instead of being stopped early.
- Fixed `!` shell commands on zsh/fish by running them inside a real PTY, resolving terminal option errors and preserving ANSI color formatting.
- Fixed transcript layout corruption and viewport compression caused by interrupted streams, empty blocks, or collapsed wrapped diff lines.
- Fixed transcript scrollback loss where output below sticky cards (such as hub-wait or todo) failed to commit to terminal history.
- Improved HTTP 413 error handling: accurately distinguish between true token-context overflows and provider byte/media budget limits, persist terminal errors across sessions, and enable proper fallback-chain model switching.
- Fixed discovery-backed session models failing to restore when resuming sessions with `omp --resume` or `--continue`.
- Fixed browser tool initial launch timeouts on slow or cold host environments.
- Fixed eval runtime probes hanging on Windows due to inherited stdin handles.
- Fixed Claude models replaying partial thinking blocks as conversation text when interrupted mid-turn.
- Fixed image request failures with Kimi Code and Moonshot models by ensuring inline base64 image delivery.
- Fixed SQLite WAL-mode databases without sidecars failing to open in the Read tool.
- Fixed pasted image thumbnail rendering in the composer attachment preview.
- Fixed Linux startup event loop delays caused by legacy extension cache fsync churn.
- Fixed subagent advisors abandoning reviews on the final yield turn during session teardown.
- Fixed `/todo` expand/collapse commands and corrected `/shake thinking` reporting.

## [18.0.3] - 2026-08-23

### Added

- Added opt-in edit auto-repair (`edit.autoRepair.enabled`): when an edit breaks a file's AST parse, the smol model repairs the broken region in place — validated by re-parse, revert-rejected, and surfaced as a diff in the tool result — instead of only warning.

### Fixed

- Resolved cursor drift and text duplication caused by overlapping or out-of-bounds spelling ranges
- Squeezed transcript tool rows no longer render as a bare unstyled `╭─ Hub` frame: a squeezed block keeps its real render whenever it fits the allocated rows, and blocks that genuinely overflow fold to a themed frame that names the tool's activity (e.g. `Hub · send → Main`).
- Python/Ruby/Julia eval cells that hit their wall-clock timeout during a `parallel()`/`agent()`/`tool.*` fan-out no longer get their kernel force-killed (losing all session state): the timeout now aborts in-flight bridge calls so the runner unwinds as a clean KeyboardInterrupt and the kernel survives.
- Multi-select ask options whose labels end in `(Recommended)` now show their checked state and avoid duplicate recommendation suffixes ([#9452](https://github.com/can1357/oh-my-pi/issues/9452)).

## [18.0.2] - 2026-08-23

### Added

- Added update channels: `omp update --canary` installs canary prereleases from the npm `canary` dist-tag and `omp update --stable` switches back; the chosen channel persists and drives the startup update check.

### Changed

- Unexpected Stops now offers None, Mechanical (default), and Smart modes; Smart adds small-model classification to recover text-only stops.

### Fixed

- Fixed crash during update output when theme configuration is missing
- Fixed flickering typo undercurls while typing by projecting state during revalidation
- Fixed self-update on Windows leaving the `omp` command missing or stuck on the previous version when package-manager reinstalls fail on running files
- Ctrl+T now toggles every thinking block in the transcript, including blocks already retired to terminal history ([#9440](https://github.com/can1357/oh-my-pi/issues/9440)).
- Copilot Grok 4.6 Responses streams that repeatedly close after thinking now stop after one same-model retry instead of consuming the full retry budget ([#9427](https://github.com/can1357/oh-my-pi/issues/9427)).
- `/mcp test` now reports cancellation immediately when Esc is pressed during a slow config lookup, instead of staying suspended until the read settles ([#9419](https://github.com/can1357/oh-my-pi/issues/9419)).
- Fixed remote browser relay endpoints advertising a client-local CDP WebSocket URL: `/json/version` now reflects a valid request `Host` and falls back to the relay's loopback address when it is absent or unusable.
- Restored red/green and syntax highlighting in edit-tool result bodies ([#9439](https://github.com/can1357/oh-my-pi/issues/9439)).
- Fixed goal mode failing to start (`No such tool: xd://goal`) when `goal.enabled` was turned on after the session had already started; the `goal` tool is now registered lazily on goal-mode entry ([#9444](https://github.com/can1357/oh-my-pi/issues/9444)).

## [18.0.1] - 2026-08-23

### Added

- Plan review can save a plan to a chosen path and start a new session.
- Edit results now warn when an edit leaves a previously parsing file unparseable, independent of the `edit.blackbox.enabled` recorder.
- Added provider-wide Amazon Bedrock guardrail settings to models configuration, including custom models.
- Added the `/pin` slash command to pin and unpin sessions so they stay at the top of the `--resume` picker UI.
- Optional edit parse-regression capture appends the before/after content, model, variant, and arguments to `~/.omp/agent/edit-blackbox.jsonl` when `edit.blackbox.enabled` is enabled.

### Changed

- Bash commands now automatically transition to the background by default when exceeding the threshold
- Transcript blocks now retire to terminal history as explicit ordered batches, active tools collapse to compact indicators under viewport pressure, and the `tui.scrollbackRebuild` and `tui.resizeScrollback` settings were removed.
- Transcript retirement is now capacity-driven: finalized blocks (and the welcome header) stay live in the viewport — reflowing to the current width on resize and visible the instant a message is submitted — and only commit to immutable terminal history when the screen runs out of room.
- Resizing no longer duplicates the editor and status rows: the settled repaint recovers its anchor from the terminal's own cursor-position report after reflow.
- The Advisor agent's guidance now prioritizes concrete technical risks and transcript-evident execution failures, while strictly prohibiting meta-advice on user intent, ceremony, or workflow narration.
- Edit-tool inline selections whose text contains the divider character itself (box-drawing code) are now resolved instead of failing the batch: a trailing divider reads as a deletion, an odd count splits at the middle divider, an even count reads as a deletion of the selected text, each with an advisory note.
- The welcome screen's recent-sessions list no longer content-scans every session file in the project directory: session titles are indexed in history.db as they are created/renamed, and startup resolves the newest files by mtime with a per-file scan fallback that backfills the index (cuts the pre-input startup transition by ~250ms per 10k sessions).
- Interactive startup no longer re-runs slash-command discovery: the composer's autocomplete reuses the discovery pass that session construction already performed.
- Interactive startup now reuses the prepaint composer's in-flight recent-session load, starts custom-command discovery with the other independent filesystem scans, and overlaps auth-cache/config reads with settings initialization instead of repeating or serializing them.
- Interactive startup now commits the complete composer frame synchronously before `session_start` hooks, lazily materializes only cached model providers needed by the configured default role, and starts cache-aware online runtime-provider discovery after the first UI paint.
- Advisor criteria for `concern` and `blocker` levels are expanded to better identify serializing independent tasks, bypassing specialized tools, ignoring verified sources, and premature yielding before convergence.
- The Advisor is now explicitly instructed to promote clean code cutovers (deleting obsolete paths and tests) unless backwards compatibility is required by the user or project rules.
- The advisor now flags transcript-evident execution failures—missed parallelism, overplanning, ungrounded assumptions, unnecessary abstraction, incomplete scope, stubs, and thin verification—before they force user steering.
- Slash-command autocomplete now collapses skills into a single `/skill:` row; the individual skills list once the prefix reaches `/skill:` (accepting the row with Tab/Enter expands it in place).
- `omp cleanse` and `/cleanse` now dispatch repair subagents while checkers are still running: diagnostics stream in (parsed from partial checker output every 5s), new files spawn workers up to the agent cap with least-loaded batching, and late diagnostics for a file being repaired are steered into the owning worker's chat instead of waiting for the full diagnostic pass.
- Suggested plan save filenames now come from a dedicated 1-3 word topic prompt instead of the sentence-length session title (e.g. `PYO3_METHODS_PLAN.md` instead of `SPLIT_PYENVIRONMENTBACKEND_REQUEST_INTO_PYO3_METHODS_PLAN.md`), with verbose fallbacks trimmed at a word boundary.
- Subagents in a shared working tree no longer run formatters, linters, or project-wide builds/test suites unless their assignment asks for it; validation runs once by the main agent.
- Context file deduplication now checks paragraph containment instead of byte-exact matching: a less-authoritative file whose normalized paragraphs appear contiguously within a more authoritative file is omitted, reducing redundant prompt context.
- Context file containment dedup now sorts by depth descending internally, treating files without a depth as least authoritative, so concatenated multi-root or user-level context cannot drop a closer-to-cwd file.
- Paragraph splitting for containment comparison is now fenced-code-block-aware: text inside a fenced example in a more authoritative file no longer counts as a contained instruction, preventing active context rules from being discarded.

### Fixed

- Fixed UI jitter in the edit tool gutter by reserving space for line counts
- Edit-tool add lines written directly above a `` gap now insert under their anchor line instead of splicing at the post-gap anchor, often mid-line without a newline.
- Edit-tool add lines may contain literal selection-marker glyphs; such payloads previously failed with an unusable corrected payload.
- A bare edit selection whose REWRITE restates the whole line now replaces the full line instead of duplicating the line's prefix and suffix around the span.
- A mid-line `…` in an edit REWRITE no longer re-emits a multi-line capture, so literal ellipses inside strings survive.
- Fixed double-Esc (session tree / branch selector) appearing dead on long sessions: opening it no longer replays the entire transcript through the terminal (which blocked for tens of seconds on PTY backpressure and cleared native scrollback), only the viewport repaints.
- Fixed prompt history whitespace duplicates: prompts are normalized on save (CRLF folded, per-line trailing padding stripped) so terminal-copy resubmissions upsert instead of adding a near-identical row, and a one-time pass collapses existing padded duplicates keeping the latest submission's metadata.
- Fixed prompt history duplicates: each prompt is now stored once with its latest project path, session ID, and submission time, and session resume or transcript rebuilds no longer repopulate persistent history.
- `/models` no longer shows dead sidebar tabs for unconfigured Ollama, llama.cpp, and LM Studio endpoints; explicitly configured endpoints remain visible for diagnosis ([#2761](https://github.com/can1357/oh-my-pi/issues/2761)).
- Fixed prompt input lag under CPU load while file and macOS spelling completions are active.
- Fixed blank `mnemopi.dbPath` settings silently creating volatile memory banks instead of using persistent agent storage ([#9360](https://github.com/can1357/oh-my-pi/issues/9360)).
- Fixed legacy Pi extensions being reparsed on every startup because their persistent parse cache could not be created ([#9339](https://github.com/can1357/oh-my-pi/pull/9339) by [@walodayeet](https://github.com/walodayeet)).
- Fixed Kitty text-sized Markdown headings activating before `tui.textSizing` is enabled.
- Fixed terminal-title updates racing the TUI's off-thread output pump, which could tear an escape sequence mid-frame and print the title (e.g. `0;π ∴ <session title>`) into the editor line as if typed.
- Fixed the edit tool corrupting files on unified-diff-shaped payloads: missing-separator recovery no longer hijacks `-`/`+` bodies (which deleted matched anchors and duplicated the surrounding block); they now flow to the unified-diff reinterpretation.
- Fixed the edit tool writing literal `…` lines: a whole-line rewrite gap with no captured MATCH gap now fails closed with guidance instead of splicing an ellipsis into the file.
- Fixed status text retaining hidden DCS, PM, and APC payloads after escape-sequence sanitization.
- Fixed extension load errors truncating explicitly excluded package import specifiers.
- Fixed subagents crashing before their first turn when an extension contributed a tool or skill without a `description`; the context-breakdown token estimate now coalesces missing descriptions and system-prompt sections instead of passing `undefined` to the tokenizer ([#9331](https://github.com/can1357/oh-my-pi/issues/9331)).
- Clarified that Mnemopi `/memory enqueue` only promotes working memories older than the configured consolidation gate (12 hours by default) and that normal shutdown does not run bank sleep ([#9356](https://github.com/can1357/oh-my-pi/issues/9356)).
- Fixed asynchronous V2 remote compaction dropping user and tool messages added after its speculative snapshot ([#9351](https://github.com/can1357/oh-my-pi/issues/9351)).
- Fixed startup crashes when temporary Git worktrees point to repository metadata that the current user cannot access.
- Hidden custom tools (`hidden: true`) stay out of the parent session's active set and `/tools` unless `--tools` or an agent `tools:` list names them. They used to be always-included.
- Hidden custom tools (`hidden: true`) stay out of the parent session's active set and the TUI's `/tools` list unless `--tools` or an agent `tools:` list names them. They used to be always-included.
- Fixed edit retries suggesting the same invalid payload and permission prompts showing unknown paths for sloppy edits ([#9350](https://github.com/can1357/oh-my-pi/issues/9350)).
- Fixed Agent Hub aborted rows failing to open their read-only transcript when selected with Enter.
- Fixed `/mcp test` leaving a stale "(esc to cancel)" hint after the test finished and swallowing Esc presses during the grace window; the hint now stops advertising Esc once the test settles, a late Esc shows an "already finished" status instead of silently doing nothing, and one Esc press consumes the cancellation ownership so the next Esc reaches the running turn ([#9173](https://github.com/can1357/oh-my-pi/issues/9173)).
- Fixed MCP request timeouts surfacing as `Unexpected end of JSON input` instead of `Request timeout after Nms` when the abort lands mid-JSON-body read, including when the caller's signal aborts after the timer fires ([#9048](https://github.com/can1357/oh-my-pi/issues/9048)).
- Fixed streamed `xd://` device writes (including MCP tools) looking like a hung in-flight call while the model is still thinking; they now show as queued until the tool actually starts.
- Fixed `/clear` and `/new` keeping a stale `AGENTS.md` (and other context files) in the system prompt; a new session now re-reads them from disk ([#9273](https://github.com/can1357/oh-my-pi/issues/9273)).
- Auto-continue turns that die mid-tool-call with `OpenAI completions stream closed before a finish_reason was received` (and the Responses/Azure "closed before a terminal response event" variants): premature gateway stream closes now classify like idle stalls and HTTP/2 resets, so a resolved tool turn is continued after its preserved partial output instead of surfacing the error.
- Todo tool schemas now identify `items` as valid for single-phase `init` and `append`.
- Fixed Todo tool guidance to clarify that blocked tasks never auto-promote after state-changing operations (#8121).
- Fixed timed-out or interrupted glob searches keeping native filesystem workers alive and blocking subsequent agent turns.
- Fixed legacy Pi extensions being re-parsed on every launch instead of using the persistent cache ([#9170](https://github.com/can1357/oh-my-pi/pull/9170) by [@fmguerreiro](https://github.com/fmguerreiro)).
- `/mcp reload` now picks up external edits to `mcp.json`.
- Fixed `lsp reload` clearing active language-server settings instead of reapplying them.
- Fixed workspace diagnostics skipping lower-priority languages in polyglot project roots ([#8385](https://github.com/can1357/oh-my-pi/issues/8385)).
- Fixed isolated task cleanup deleting the only branch that retained an agent's commits after apply-back failed ([#9216](https://github.com/can1357/oh-my-pi/pull/9216), thanks [@Mustaqeem66](https://github.com/Mustaqeem66)).
- Fixed bare `hub wait` calls reporting nothing to wait for while an already-queued bus message remained unread.
- Fixed Code Mode activating for sessions whose caller never enabled `eval`, which handed restricted subagents an unrestricted JS runtime; the eval transport must now be part of the caller's own tool set.
- Fixed Code Mode dropping `write` from the direct surface when plan mode starts, and dropping `task` delegation guidance from the plan prompt once `task` is reachable only through the eval bridge.
- Fixed the eval tool advertising bridged declarations for tools the model can still call directly, such as a plan-mode transport `write`, by reading the partition the session actually applied.
- Fixed Code Mode turn metadata resolving a wire-name collision by tool registry order, and mishandling tools named after `Object.prototype` members or after the eval bridge's own internal operations (`__agent__`, `__budget__`, `__completion__`, `__concurrency__`).
- Fixed generated Code Mode declarations rendering an array of a union as `"a" | "b"[]`, which models read as a scalar-or-array type and submitted invalid arguments against.
- Fixed SDK sessions with a custom agent directory inheriting process-global model overrides instead of loading that directory's own `models.yml`.
- Fixed Eval guidance that implied `agent()` children share parent kernel state and advertised them when spawning was disabled.
- Fixed Bash guidance that implied raising `timeout` extends foreground execution beyond the auto-background threshold.
- Fixed Bash and Eval guidance that implied raising `timeout` extends foreground execution beyond the auto-background threshold ([#9155](https://github.com/can1357/oh-my-pi/pull/9155) by [@MikeeI](https://github.com/MikeeI)).
- Status-line usage no longer combines quota windows scoped to different models or tiers ([#9138](https://github.com/can1357/oh-my-pi/issues/9138)).
- Fixed `PI_PROXY` being ignored outside provider streams: the CLI now installs it on the process-wide `fetch` at startup, so OAuth token refresh/login, usage probes, and model discovery are proxied too. Combined with the Anthropic transport fix in `pi-ai`, a region-blocked machine reaching Anthropic through a proxy no longer fails with `403 Request not allowed`.
- Subagent failures now name the resolved provider and model that produced the error ([#9137](https://github.com/can1357/oh-my-pi/pull/9137) by [@Mustaqeem66](https://github.com/Mustaqeem66))
- Fixed read-only subagents (`scout`, restricted-tool custom agents) crashing before their first prompt when extensions register callable tool schemas.
- Fixed smart paste dropping text from X11 clipboard owners whose image read fails instead of reporting no image.
- Fixed `formatContent` silently swallowing formatter errors: the empty `catch {}` was replaced with per-server error tracking, and failed formatter requests now surface as `FileFormatResult.FAILED` instead of being misclassified as unchanged ([#8388](https://github.com/can1357/oh-my-pi/issues/8388)).
- Fixed `formatContent` reporting no-formatter as unchanged: when no configured server supports formatting, the result is now correctly classified as `FileFormatResult.UNSUPPORTED` ([#8388](https://github.com/can1357/oh-my-pi/issues/8388)).
- Fixed MCP request timeouts surfacing as `Unexpected end of JSON input` instead of `Request timeout after Nms` when the abort lands mid-JSON-body read.
- Fixed CJS modules being misclassified as ESM when imported from an ESM parent module. The extension loader now identifies unshadowed CommonJS syntax from Babel's parsed AST before deferring to the importer's module kind. This resolves `SyntaxError: Missing 'default' export` for packages with conditional exports (e.g. playwright-core) where an ESM wrapper re-exports from a CJS entry, while ambiguous files continue to inherit their importer's classification.

## [18.0.0] - 2026-08-22

### Added

- Added the `omp render` command to replay session threads and benchmark transcript pipeline performance.
- Added configurable typo detection (`Ctrl+.` suggestions), Tab word completion, and opt-in autocorrect to the macOS prompt editor.
- Added a live benchmark dashboard to `omp bench` with real-time performance estimates, p50/p95 statistics, distinct input/output throughput metrics, cost tracking, mixed challenge suites by default, and a `--prefill-bytes` option for synthetic prefill benchmarks.
- Added the `/shake thinking` command to strip model reasoning blocks from session history.
- Added icon support and usage-frequency ranking to slash-command autocomplete suggestions.
- Enhanced the edit tool to support `＋`-prefixed line insertions, unified diff formats, bare selection replacements, and robust recovery for common syntax variations and ambiguous match spans.
- Startup composer now renders immediately using cached session and theme data, allowing typing before session initialization finishes without dropping keystrokes.

### Changed

- Session history rewinds (via `Esc-Esc` or `/tree`) now truncate transcript tails in place instead of clearing and replaying the entire terminal scrollback.
- Switched the fallback edit mode to `sloppy` for models lacking hashline support.
- macOS spelling checks now run in the background to avoid blocking editor rendering and keystroke responsiveness.
- Word completions accepted via Tab now insert a trailing space when not immediately followed by whitespace or punctuation.
- Increased default visible autocomplete dropdown rows to 10 and added the `autocompleteMaxVisible` configuration setting.
- Slash-command descriptions in the autocomplete popup now truncate to two lines instead of wrapping indefinitely.

### Fixed

- Fixed streaming code blocks not rendering syntax highlighting live until completion.
- Fixed an issue where interrupting Claude during reasoning would replay partial thinking blocks on subsequent turns and cause API rejection errors.
- Fixed session resume performance by avoiding redundant edit-matching execution across historical transcripts.
- Fixed image requests to Kimi Code / Moonshot failing with 400 errors by sending inline base64 images directly.
- Fixed reading WAL-mode SQLite databases that do not have active `-wal` or `-shm` files.
- Fixed terminal transcript layout corruption on Windows caused by collapsed edit results with long wrapped diff lines ([#9302](https://github.com/can1357/oh-my-pi/issues/9302)).
- Fixed disappearing terminal scrollback history below updating cards such as background jobs or hub status cards.
- Fixed pasted image attachment thumbnails rendering as blank boxes in Kitty terminal graphics mode.
- Fixed context gauge display issues in the status line for unnamed sessions.
- Fixed accurate benchmark input token counts on providers with automatic prompt caching.
- Fixed C# files incorrectly displaying D3.js icons in edit results ([#9323](https://github.com/can1357/oh-my-pi/issues/9323)).
- Fixed incorrect token delta reporting in expanded context compaction summaries when pre-compaction usage was omitted by the provider ([#9293](https://github.com/can1357/oh-my-pi/issues/9293)).

## [17.4.4] - 2026-08-22

### Added

- Added the `tui.resizeScrollback` setting (default `append`) controlling how a settled width resize refreshes pane scrollback when the terminal repaints in place (tmux/screen/Zellij panes, in-place direct terminals). Multiplexers rewrap old output naively on width changes, leaving history hard-broken at the old width; `append` re-emits the transcript at the new width below it (one fresh copy per settled resize), `rebuild` clears pane history first so it holds exactly one current-width copy (needs a host that honors ED3, like tmux; erases pre-session scrollback), and `preserve` keeps the old-width history untouched with zero growth ([#8193](https://github.com/can1357/oh-my-pi/issues/8193)).

### Fixed

- Fixed the composer image chip painting its right border inside the card and mangling the thumbnail's first row: the Kitty placement prefix was counted as visible width, breaking the thumbnail centering.
- Fixed edit-tool whole-line inserts (an insert selection alone on its own line) splicing into the anchor line instead of landing on a new line when the anchor was the last matched line, preceded a blank line, or sat at EOF.
- Edit tool prompt now documents whole-line insert selections and that a REWRITE `…` with no captured MATCH gap is written to the file literally.
- Fixed multiplexer width resizes (tmux/screen/Zellij/cmux/Herdr panes) replaying the entire transcript into pane history — one duplicated transcript copy and seconds of visible scrolling per width change. The width-epoch boundary now resolves for real transcripts: finalized blocks without `getTranscriptBlockVersion` are treated as immutable per the documented contract, Container-derived blocks without a nested epoch source fall back to whole-segment stability instead of failing, and bash/eval/tool/read-group blocks report a block version for their genuine post-finalize mutations. The interactive resize listener no longer marks every SIGWINCH as "render pending", which forced the conservative replay-from-row-zero fallback on every settled resize ([#8193](https://github.com/can1357/oh-my-pi/issues/8193), [#7026](https://github.com/can1357/oh-my-pi/issues/7026)).

## [17.4.3] - 2026-08-21

### Fixed

- Fixed the edit tool rejecting payloads containing a glued `«»` line: after MATCH it now reads as the mistyped `»` separator, elsewhere as a stray terminator to drop.

## [17.4.2] - 2026-08-21

### Added

- Added an opt-in image URL broker (`images.urls.enabled`) that publishes outgoing images through an ordered chain of backends instead of sending inline base64 to URL-fetching providers
- Composer attachment chips (ported from omp2): pasted images and large text pastes stage as rounded preview cards above the prompt — image cards show a live thumbnail (Kitty Unicode placeholders) with pixel dimensions, text cards a snippet with `+N lines`/`N chars` — while the editor buffer holds a compact `<icon> #N` token in the card's identity color.

### Changed

- Pasted images now insert only the `[Image #N, WxH]` marker; the redundant trailing `attachment://N` URI is no longer added to the composer.
- Added a consolidated CLI reference (`docs/cli-reference.md`) documenting every top-level subcommand and launch flag, including headless print mode (`--print`/`-p`, `--print-thoughts`) ([#9252](https://github.com/can1357/oh-my-pi/issues/9252))

### Fixed

- Fixed unreadable colors in macOS Terminal.app by using its supported 256-color mode ([#9162](https://github.com/can1357/oh-my-pi/issues/9162)).
- Fixed Esc after a fast `/mcp test` result aborting the active agent turn instead of consuming the advertised cancellation input ([#9173](https://github.com/can1357/oh-my-pi/issues/9173)).
- Fixed task spawns crashing when legacy boolean per-agent prewalk or advisor overrides are present in `config.yml`.
- Fixed ACP `session/prompt` requests hanging forever when a builtin slash command's residual prompt (e.g. `/force:<tool> /some-command`) resolved locally, which also wedged all subsequent prompts on the session ([#9206](https://github.com/can1357/oh-my-pi/issues/9206)).
- Fixed eval-spawned subagent output being omitted from per-turn output-token budgets, including failed and isolated runs ([#9187](https://github.com/can1357/oh-my-pi/issues/9187)).
- Fixed `/compact` over RPC blocking the serialized command queue for the full summarization round-trip, so a follow-up `abort` could not interrupt it ([#9200](https://github.com/can1357/oh-my-pi/issues/9200)).
- Fixed RPC UI select requests dropping option descriptions, allowing hosts to render described choices ([#9175](https://github.com/can1357/oh-my-pi/issues/9175)).
- Fixed `/todo edit` failing with "Could not parse Markdown" when checklist items had backslash-escaped brackets (`- \[x\]`), which editors and markdown renderers commonly emit ([#9188](https://github.com/can1357/oh-my-pi/issues/9188)).
- Fixed `omp setup --check`/`--json` with no component printing usage text to stdout and exiting 0; it now errors on stderr and exits non-zero so scripted JSON health checks fail loudly ([#9221](https://github.com/can1357/oh-my-pi/issues/9221)).
- Fixed an aggressive `task.maxRuntimeMs` mislabeling committed subagent outcomes: a budget-killed run is no longer reported as a runtime-limit timeout, and a subagent that yielded a complete result before the deadline is no longer reported as aborted when teardown crosses the deadline ([#9191](https://github.com/can1357/oh-my-pi/issues/9191)).
- Fixed startup fallback-chain warnings for discovered OpenCode Zen, OpenCode Go, and GitHub Copilot models cached under credential-scoped IDs ([#9205](https://github.com/can1357/oh-my-pi/issues/9205)).
- Fixed interactive `/models` and Ctrl+P cycling omitting an `enabledModels`/`--models` model discovered by a background provider refresh (e.g. `opencode-go/ox-alpha-free`) after startup, by rebuilding the scoped list once discovery completes ([#9220](https://github.com/can1357/oh-my-pi/issues/9220)).
- Documented how to enable, trigger, target, and manually re-arm prewalk ([#9179](https://github.com/can1357/oh-my-pi/issues/9179)).
- Pasted images and large text pastes appear in the composer as compact icon tokens instead of bracketed markers; the bracketed form remains the outgoing/stored format, and the transcript renders it back as the compact chip.
- Deleting an attachment's inline token now removes the attachment from the submission (surviving image markers are renumbered).
- Restored prompts (esc-esc, `/tree`, branch, queued-message dequeue, failed-submit recovery) collapse image markers back into clickable atomic chip tokens and re-materialize their file links instead of degrading to dead text.

## [17.4.1] - 2026-08-21

### Added

- Added `PERSONALITY.md` support: `~/.omp/agent/PERSONALITY.md` (profile/XDG-aware agent dir) replaces the system prompt's personality block text; `personality: none` still omits the block ([#8528](https://github.com/can1357/oh-my-pi/issues/8528))
- Sloppy edits now support inline replacements with `⟪old│new⟫` syntax (`⟪old│⟫` for deletions and `⟪│new⟫` for insertions), alongside automatic recovery for common formatting mistakes without needing a retry.
- Sloppy edits now recover operations that mix `⟪old│new⟫` inline replacements with a `»` REWRITE instead of failing the payload: a redundant REWRITE is dropped, a diverging one is applied as the final text, and a note explains the interpretation.
- Expanded archive support in `read` and `write` tools: `read` can now inspect and extract members from `.rar`, `.7z`, `.iso`, `.cab`, `.deb`, `.rpm`, `.cpio`, `.ar`/`.a`, `.lzh`, `.arj`, compressed tar files (`.tar.bz2`, `.tar.xz`, `.tar.zst`), package formats (`.whl`, `.ipa`, `.xpi`, `.vsix`, `.nupkg`, `.cbz`, `.cbr`), `.asar` archives, and single-file compressed streams; `write` can create `.tar.zst` and update `.asar` archives.
- Added Code Mode for Codex `code_mode_only` models via `providers.openai-codex.codeMode` (`off`/`on`/`auto`), demoting non-essential tools into an eval bridge with generated TypeScript definitions.
- MCP tool names longer than 64 characters are now automatically truncated with a deterministic hash suffix to comply with strict provider validators.
- Marketplace-installed plugins with manifest settings can now be configured through `omp plugin config` and Settings → Plugins.
- Configured discovery providers with `authHeader` now preserve cached models across application restarts.
- Added repeat read warning hints when identical file content is read multiple times.
- Explicit DAP adapters can now attach without a PID or port when `attachDefaults` provide the target arguments.
- Added `isProjectTrusted()` compatibility shim to `ExtensionContext` for extensions targeting upstream per-directory trust gates.

### Changed

- Added `compaction.asyncEnabled` (default: on) to speculatively summarize context in the background before hitting threshold limits, avoiding blocking summarization pauses.
- Replaced `compaction.strategy` and `compaction.remoteEnabled` with an ordered `compaction.methodOrder` preference list.
- Handoff maintenance (`/handoff` and automatic handoff compaction) now commits generated summaries directly to the active session instead of starting a new session.
- Added `extendedContext` setting (`/settings` → Context → General, default: on) to optionally clamp models with premium long-context pricing tiers (such as OpenAI GPT-5.6 Sol/Terra/Luna) to standard-pricing token limits before compaction triggers.
- Token counting and token estimations are now dynamically scoped to each specific model tokenizer rather than using a single process-global tokenizer.
- `omp cleanse` and `/cleanse` now feature a live interactive status board displaying active checkers, repair subagents, tool metrics, and token/cost totals in real time.
- Eval-bridge nested `tool.<name>()` calls now enforce ACP permission gates and tool allowlists identically to direct tool calls.
- Added `tokenizer` option to custom models and `modelOverrides` to allow overriding the local tokenizer family for proxied model endpoints.
- Added `qwenTemplateReasoningEffort` to the `models.yml` `compat` schema to configure or disable reasoning effort flags for strict local inference servers.
- Settings menus now support click-to-toggle and drag-to-reorder for list items, as well as warning indicators and risk notes on sensitive options such as External Thinking.
- Supervised process completion notices now render as compact single-line entries.
- The todo HUD header now displays a consolidated progress bar showing task completion across all stages.
- `/settings` rows can now carry a risk note: a warning glyph on the row plus a warning-colored line above the description. `External Thinking` (`externalThinking`, `--external-thinking`) is the first user — providers have flagged the request shape it produces as abuse, up to account-level enforcement, so both the settings entry and `--help` now say so.

### Fixed

- Fixed regional HTTP 401 data-residency errors during Codex chat, web search, and image generation requests by passing token residency metadata on requests.
- Fixed macOS SSH ControlMaster socket creation failures caused by `sun_path` length limits when using named profiles.
- Fixed an issue where Nix-packaged builds failed to load on-demand native addons (`onnxruntime-node`/`sherpa-onnx`) due to missing shared C++ runtime library paths.
- Fixed external editor spawning (Ctrl+G, plan review, `/todo edit`) failing to attach to visible terminals for editors like `emacsclient`.
- Fixed `omp --resume` spinning at 100% CPU when new session entries arrived during initial transcript rendering.
- Fixed session resume hints and fatal exit messages omitting the active `--profile` argument.
- Fixed MCP OAuth authorization requests failing on pre-registered clients with restricted scopes by using RFC 9728 `scopes_supported`.
- Fixed isolated task subagents causing out-of-memory crashes on repositories with large uncommitted binary files by pre-sizing diffs and enforcing snapshot limits.
- Fixed LM Studio and lazy-loaded local models retaining uninitialized context lengths by re-probing loaded context lengths after initial inference.
- Fixed project-scoped Claude Code marketplace plugins incorrectly loading into sessions in other projects.
- Fixed configured advisors backed by discoverable providers remaining inactive on initial session startup until manually toggled.
- Fixed resolving `--model @<role>` failing for roles backed by discovery providers like oMLX, Ollama, and llama-swap.
- Fixed retry fallback chains stopping prematurely when encountering nested fallback configurations, and fixed session role priority during fallback chain selection.
- Fixed cancelled prompts disappearing upon abort during turn setup, properly restoring user text and attachments to the input editor.
- Fixed built-in shell utilities (`grep`, `rg`, `diff`, `find`, `timeout`, `top`, `date`, `head`, `tail`, `stat`, `truncate`, `kill`) across numerous POSIX/GNU/BSD compatibility edge cases and early-pipeline SIGPIPE handling.
- Fixed Cursor sessions missing standard string-replacement edit tooling after server tool injection.
- Fixed `hub wait` duplicating frozen rows into native scrollback during viewport overflow.
- Fixed dark-theme contrast issues on markdown code-fence headers.
- Fixed prompt guidance and descriptions for Task tools and SSH usage.
- ACP editor clients that support elicitation forms (Zed) can now use `ask`, so the agent can pose single-choice, multi-select, and free-text questions inline instead of guessing.
- `/retry` and `/handoff` now work over ACP, so editor clients (Zed) list them and can run them instead of sending the text to the model.
- Added `qwenTemplateReasoningEffort` to the `models.yml` `compat` schema, so the auto-enabled Qwen 3.8+ template effort dialect (`chat_template_kwargs.reasoning_effort`) can be switched off per provider/model for strict local servers that reject unknown `chat_template_kwargs`.
- Extensions can provide a normalized `usage` provider through `pi.registerProvider()`. Its reports now flow through AuthStorage caching, history, and usage displays, and the override is removed when the extension provider is unregistered.

## [17.4.0] - 2026-08-20

### Added

- `/cleanse` (and `omp cleanse`) — run the checker/repair loop in-session, with a live status board of running checkers, repair subagents, and token/cost totals.
- `omp ps` — interactive monitor for daemon-supervised background processes.
- Composer layouts — `composer.shape` picks the editor frame (rounded box, Claude Code rules, upstream-pi rules, borderless), with live previews in `/settings` and the setup wizard.
- Context line — `statusLine.contextLine` gauge (`percentage`, `annotated`, `embedded`) showing context usage and compaction boundaries.
- Backgroundable Python — `eval` cells can run async and auto-background like `bash`, with configurable thresholds.
- Local Claude token counting — Anthropic-family tokens now count via a native local tokenizer, and every counter (session maintenance, advisor, stats, context tools) uses the active model's own tokenizer.
- `extendedContext` setting — pick whether models with premium long-context pricing (272K/1M tiers on Codex-class models) use the extended window or compact early and stay on standard pricing.
- `/extended-context` — toggle premium long-context windows without leaving the session.
- Speculative compaction — with `compaction.asyncEnabled`, all compaction modes compact in parallel while the session continues, then splice the result in instantly.
- `tokenizer` property on custom models and `modelOverrides` to pin the tokenizer family for proxy models.
- `qwenTemplateReasoningEffort` in `models.yml` `compat` to disable the Qwen 3.8+ reasoning-effort template parameter for strict local servers.
- Click-to-toggle and drag-to-reorder for list-valued editors in `/settings`.
- `icon.subscription` and `icon.advisor` symbol-theme tokens (Nerd Font, Unicode, ASCII).

### Changed

- Typing anywhere in the /models UI now immediately focuses the model list for instant search and arrow navigation.
- Revamped the todo HUD — overall progress renders along the tree-spine connector with smooth completion transitions.
- Compaction divider now names the maintenance method that fired (`remote-compacted`, `soft-compacted`, `handed-off`, `snap-compacted`) and shows the before → after context size (e.g. `256K→20K`).
- `/handoff` (and automatic handoff compaction) now compacts in place, replacing the session context instead of forking a new session.
- Compaction method priorities — `compaction.methodOrder` takes an ordered preference list (e.g. `[remote, snap]` uses remote compaction where the provider supports it, such as OpenAI, and snap everywhere else), replacing `compaction.strategy`/`compaction.remoteEnabled`.
- Unified inline overlays and selectors (model picker, settings, `/cleanse`) into one titled rounded-box panel style.
- Risk badges and warnings on `/settings` rows, starting with External Thinking.
- Faster CLI Startup

### Fixed

- `/models` keeps `auto` thinking on non-default roles such as `task` instead of changing the active model and displaying the role as `max`.
- Subagent `yield` structured results no longer get corrupted by lossy argument repairs; prompt guidance improved for weak callers.
- GitHub `file_read` returns proper image blocks and direct view URLs for image/binary files.
- Cancelled prompts during pre-stream turn setup restore the text and image attachments to the editor.
- `top` builtin accepts single-dash macOS flags such as `-pid` and `-stats`.
- GNU/BSD compat sweep across built-in shell utilities (`timeout`, `diff`, `find`, `date`, `tail`, `head`, `rg`, `stat`, `truncate`, `cksum`, `sleep`, `which`, `nohup`, `kill`).

## [17.3.8] - 2026-08-19

- Fixed unquoted internal URLs in `bash` commands consuming adjacent shell operators into the resolved filesystem path.

### Added

- Added `providers.cacheRetention` setting (`/settings` → Providers → Protocol) to control prompt-cache retention per request: `auto` keeps the provider default (Anthropic: 5m entries with idle keep-alive refreshes), `short` forces 5m, `long` restores 1h TTLs where supported and disables the keep-alive refresh loop, `none` disables prompt caching.

### Changed

- The `read` tool now materializes a local text file once per invocation instead of once per consumer. A ranged read of a file within the snapshot cap previously cost four opens and three UTF-8 decodes — an 8KiB binary sniff, a streaming scan for the rendered window, a whole-file read for bracket context, and another whole-file read to hash the snapshot — with two of those readers separately normalizing line endings; whole-file reads under the structural summarizer paid a fifth read. Byte counts and truncation boundaries are now measured on the buffered bytes, so they stay exact for content that is not valid UTF-8. Files above the snapshot cap keep streaming, since nothing on that path wants the whole file. Raw reads, which skip the tree-sitter parse that documented the old cost, no longer pay for it.
- Documented that `bash.patterns` gates the `bash` tool only and does not cover a shell that `eval` can spawn via subprocess, and that closing that path needs a `tools.approval.eval` policy — noted in `docs/bash-tool-runtime.md`, `docs/approval-mode.md`, and `docs/settings.md` ([#8838](https://github.com/can1357/oh-my-pi/issues/8838)).

### Fixed

- Fixed the `/btw` panel re-committing its frame to native scrollback on every update while the primary turn is still streaming: a live region that pins itself (an anchored HUD/panel such as `/btw`) no longer leaks its scrolled-off rows just because an unpinned transcript seam sits above it in the same frame ([#8793](https://github.com/can1357/oh-my-pi/issues/8793)).
- Fixed a submitted `/skill:<name>` command staying invisible in the transcript until its awaited preflight (memory recall, `before_agent_start` hooks, auto-thinking classification, pre-prompt compaction) finished, so a slow step such as a Hindsight auto-recall timeout made the command look unaccepted. Idle skill submissions now paint an optimistic row immediately — like a normal prompt — and reconcile it in place when the canonical `message_start` lands ([#8895](https://github.com/can1357/oh-my-pi/issues/8895)).
- Fixed broker-backed MCP OAuth credentials never refreshing, so remote OAuth MCP servers dropped out of `/mcp` once their access token expired under `omp auth-broker serve`. The client threw on the broker-redacted refresh sentinel instead of asking the broker to refresh, and the broker had no `mcp_oauth:*` refresh path (`POST /v1/credential/:id/refresh` answered `Unknown OAuth provider`). The client now routes redacted MCP refreshes through the broker, and the broker refreshes MCP credentials with a generic `refresh_token` grant from the credential's embedded token endpoint and client id — so the background refresher also keeps MCP tokens live ([#8933](https://github.com/can1357/oh-my-pi/issues/8933)).
- Fixed `omp commit` split-commit failing with `corrupt binary patch` when a split commit contains a binary file. `parseFileDiffs` split the captured diff on `"\ndiff --git "`, consuming the `\n` that terminates each block, and `patch.join` stripped trailing newlines — both dropped the blank line that terminates a `GIT binary patch` block, so the rebuilt patch was rejected by `git apply --binary`. Both trailing and mid-diff binary blocks now survive the parse/rebuild round-trip byte-exact ([#8899](https://github.com/can1357/oh-my-pi/issues/8899)).
- Fixed `omp update` (and other non-launch subcommands) crashing with `error: Unknown option '--cwd'` when a leading global launch flag preceded the subcommand — e.g. a shell alias/wrapper that runs `omp --cwd <dir> update`. `resolveCliArgv` hoisted the subcommand to the front but forwarded the launch-only flag into `update`'s strict `node:util.parseArgs` parser, which rejected it. Launch-global flags before a launch-shaped command (`acp`/`launch`) are still forwarded; before any other subcommand they are now stripped as inapplicable ([#8891](https://github.com/can1357/oh-my-pi/issues/8891)).
- Fixed Claude Code marketplace plugins ignoring the `enabledPlugins` switch in `~/.claude/settings.json` and `.claude/settings(.local).json`: a plugin turned off for a project no longer loads there, and a local-scope install enabled for a project loads even when its recorded `projectPath` is a different directory
- Fixed revived subagents (warm lifecycle reviver and cold persisted reviver) rebuilding the session without initializing the extension runtime, leaving every runtime action throwing `ExtensionRuntimeNotInitializedError`. An extension with a `tool_call` handler that touched a runtime action (e.g. `appendEntry`) then tripped the fail-closed gate in `emitToolCall` and blocked every tool — including the hidden `yield` — so the revived agent could neither finish nor exit and looped until killed. Both revivers now call the shared `initializeExtensions` helper, restoring runtime actions, `onError`, and the `session_start` event ([#8824](https://github.com/can1357/oh-my-pi/issues/8824)).
- Fixed `omp commit` split-commit crashing with a misleading `No diff found for <path>` when a staged binary (or any payload) pushed `git diff --cached --binary` past the 8 MiB subprocess output cap. The capture is truncated silently, so files sorting after the binary vanished from the parsed diff; the split flow now requests a complete diff and fails fast naming the real cause instead ([#8897](https://github.com/can1357/oh-my-pi/issues/8897)).
- Fixed a mid-run compaction being misread as a phantom overflow: after a compaction rebased the in-flight context snapshot, `getContextBreakdown` used message position (`anchorIndex >= cutoffCount`) as a freshness proxy, so an in-flight provider response whose request predated the compaction out-ranked the rebased estimate and reported the pre-compaction token count (~2.6x the real one). This tripped the "Compaction freed too little context to make progress" guard and drove the frame-rescue path on a byte-identical `tokensBefore`. Assistant context snapshots now carry a monotonic compaction epoch, and a post-cutoff anchor whose epoch predates the last compaction is no longer trusted over the rebased estimate ([#8887](https://github.com/can1357/oh-my-pi/issues/8887)).
- Fixed `after_provider_response` extension handlers receiving the primary session model in `ctx.model` and `ctx.models.current()` for cross-provider side requests. `ExtensionRunner.emitAfterProviderResponse` accepted the response model but discarded it, so a handler revoking a credential on an HTTP 402 could target the wrong provider. It now threads the response model into the context, matching `emitBeforeProviderRequest` ([#8955](https://github.com/can1357/oh-my-pi/issues/8955)).
- Fixed the TinyFish web search provider ignoring the `lang:`/`language:` query directive, so every request fell back to the API's US/English geolocation. `parsed.lang` now maps onto TinyFish's `location`/`language` parameters (e.g. `lang:it-it` → `location=IT&language=it`), matching the DuckDuckGo, Perplexity, and SearXNG providers ([#8913](https://github.com/can1357/oh-my-pi/issues/8913)).
- Fixed the `/model` Roles panel silently dropping roles and model-keyed fallback chains that fell past the visible panel height: the list had no scroll window, so entries below the cutoff were unreachable with no indication anything was missing. The panel now windows around the cursor like the provider list and shows an `↑/↓ N more` hint when rows are clipped ([#8817](https://github.com/can1357/oh-my-pi/issues/8817)).
- Fixed task and eval subagents discovering newly added agent definitions while resolving their role aliases from stale startup settings. Subagent preflight now atomically reloads persisted settings before agent discovery while preserving live runtime overrides.
- Fixed images returned by tools mounted under `xd://` rendering only as file links instead of inline terminal graphics.
- Resume Cursor idle-stall turns after completed MCP/todo tool results. The watchdog already closes the Connect stream, so unmarked blocks no longer need the `exec-resolved` marker to continue.
- Fixed the Web Search Provider Order settings summary showing providers excluded from web search ([#8884](https://github.com/can1357/oh-my-pi/issues/8884)).
- Fixed subagents aborting when external thinking exposes `think` as the required prelude before their remaining tools become callable ([#8909](https://github.com/can1357/oh-my-pi/pull/8909) by [@olegpulatov](https://github.com/olegpulatov)).
- Fixed session-title generation ignoring user `/skill:<name>` invocations, so titles now see the skill name and args instead of only later assistant text.
- Fixed destructive `rm` escaping the critical-pattern approval check when anything separates the flags from the target, so `rm -rf -- /`, `rm --recursive --force /` and `rm -rf --no-preserve-root /` are now classified critical like `rm -rf /`. `--no-preserve-root` is treated as critical wherever it appears, since it is what defeats coreutils' own refusal to recurse on `/`.
- Fixed thinking-loop aborts (`AIError.Flag.ThinkingLoop`) walking `retry.fallbackChains` and switching to another model family on attempt 1, so a healthy planning turn on Grok 4.6 (SuperGrok / Cursor OAuth) no longer gets replaced by whatever the chain lists next. The loop guard now re-samples the same model with its `thinking-loop-redirect` notice, and no longer parks the model selector on a fallback cooldown. ([#8760](https://github.com/can1357/oh-my-pi/issues/8760))
- Fixed the clipboard image-paste keybind attaching Finder's generated file icon instead of the copied image on macOS. Current Finder `Cmd+C` pasteboards advertise both a `public.file-url` and a generated 1024x1024 icon bitmap, so `arboard::get_image()` succeeded with the icon and `InputController.handleImagePaste` attached it before the file-URL branch was ever reached. The handler now probes `readMacFileUrlsFromClipboard()` before the bitmap representation, so an image file URL wins over the co-advertised icon; pure bitmap pasteboards (screenshots, browser copies) and non-image file URLs still fall through to the image/text paths ([#8769](https://github.com/can1357/oh-my-pi/issues/8769)).
- Fixed the Home Manager module (`programs.omp.settings`) breaking every launch on macOS with `Failed to acquire native file lock … Permission denied (os error 13)`. The declared config is now copied into `~/.omp/agent/config.yml` as a writable file via `home.activation` instead of a read-only `/nix/store` symlink, so OMP can acquire its config lock and persist runtime changes; `home-manager switch` still reapplies the declared settings ([#8775](https://github.com/can1357/oh-my-pi/issues/8775)).
- Fixed OpenCode MCP servers 401ing when config used OpenCode's `{env:VAR}`/`{file:path}` substitution (e.g. `Bearer {env:MCP_KEY}` headers); the OpenCode loader now expands those tokens the way OpenCode does instead of only `${VAR}` ([#8778](https://github.com/can1357/oh-my-pi/issues/8778)).
- Fixed `omp update` leaking Bun's raw `fetch()` error ("pass `verbose: true` in the second argument to fetch()") when a proxy environment variable (`HTTPS_PROXY`, `ALL_PROXY`, …) uses an unsupported scheme such as SOCKS; the update check now reports an actionable message naming the offending variable and the http/https proxy requirement ([#8784](https://github.com/can1357/oh-my-pi/issues/8784)).
- Fixed worker subprocesses (memory embeddings, tiny-model titles, TTS/STT, JS eval, browser relay, LSP mux, daemon broker) running with their cwd pinned to the CLI install directory. They share the agent's foreground process group, and terminal cwd heuristics such as kitty's `new_tab_with_cwd` pick the newest process in that group, so new terminal tabs opened in `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist` while any worker was alive. Workers now spawn with the absolute host entry and inherit the agent's cwd.
- Preserved MCP `ImageContent` tool-result blocks so vision-capable models and the TUI can inspect returned images instead of receiving only a text placeholder ([#8687](https://github.com/can1357/oh-my-pi/issues/8687)).
- Fixed a whole-file `read` of a file with a UTF-8 BOM minting a hashline tag hashed from BOM-bearing text. Because the patcher's live read strips the BOM, the next edit to that file only applied through stale-hash recovery and reported that the file had changed externally when it had not.
- Extension bare imports of workspace members now resolve inside installed git-dependency monorepo plugins (the walk recognizes `workspaces` roots; installed node_modules copies still shadow members)
- Fixed `omp completions <shell>` hanging after writing shell completion scripts to stdout by invoking `postmortem.quit(0)` upon completion. Prevents lingering event loop handles (such as background timers or sockets loaded when inspecting command metadata) from pinning the process and blocking tools like `chezmoi`.
- Fixed `omp --smoke-test` recursively deleting unrelated directories in `os.tmpdir()` (tmux/ssh sockets, editor state, build trees). The smoke broker now keeps its runtime dir under a private parent, and the dead-scope reclaim refuses any root that is not the `daemons` container and only prunes entries named like a 16-hex daemon scope key ([#8721](https://github.com/can1357/oh-my-pi/issues/8721)).
- Fixed high CPU during multi-subagent / workflowz / orchestrate sessions: each live tool block (streaming args, a running partial tool, or a `task` subagent) armed its own 80ms spinner `setInterval` driving `requestComponentRender`, so N concurrent live blocks created N unsynchronized repaint timers that kept the render scheduler awake near-continuously. The per-block timers are now consolidated into a single shared spinner ticker that repaints every live block in one coalesced frame per glyph step, independent of block count ([#8731](https://github.com/can1357/oh-my-pi/issues/8731)).
- Fixed `omp update` writing to the PATH launcher instead of the running binary on binary-only releases (major bumps or `omp.dist: "binary"`): a foreign symlink — e.g. an admin symlink into a shared install — now resolves to its real binary in every distribution channel, avoiding an `EACCES` on a root-owned link directory or a split-brain copy that shadows the shared install. Package-manager launchers keep their deliberate in-place takeover. ([#8732](https://github.com/can1357/oh-my-pi/issues/8732))
- Added `.css` to the built-in Biome server `fileTypes` so CSS files route through Biome's linter/asserter by default instead of requiring a full per-project `fileTypes` override. ([#8741](https://github.com/can1357/oh-my-pi/pull/8741))
- Fixed memory extraction sending its instructions, few-shot examples, and the user's message as a single user turn, which caused small local models to echo the examples instead of extracting facts; instructions now travel as a system turn and the raw text as the user turn
- Fixed local title generation stopping on a stop string that appeared in the prompt instead of the generated tokens
- Fixed the Subagents HUD role display and restored generated task labels by keeping spawn handles separate from UI descriptions.
- Fixed `models.yml` custom-model providers declaring `auth: oauth` being rejected by validation with "apiKey is required", which forced a dummy `apiKey` that then shadowed the broker's OAuth tokens ([#8937](https://github.com/can1357/oh-my-pi/pull/8937) by [@usr-bin-roygbiv](https://github.com/usr-bin-roygbiv)).
- Provider-qualified model selectors (e.g. `anthropic/claude-opus-5`) now fail closed when the named provider is unavailable instead of silently re-binding to OpenRouter's same-named flat id and billing the aggregator ([#8832](https://github.com/can1357/oh-my-pi/issues/8832)).
- Fixed PlanYolo plan approval dropping all MCP tools: the post-handoff tool restore now accounts for MCP discovery that completed while planning instead of restoring a pre-discovery snapshot.
- Fixed parallel `web_search` calls hanging forever past the 60s timeout when the shared headless-browser daemon or page died mid-setup; browser fallback setup and teardown are now abort-protected ([#8865](https://github.com/can1357/oh-my-pi/issues/8865)).
- Fixed extension-package `.mcp.json` `${VAR}` env placeholders (stdio env/command/args/cwd, HTTP url/headers/oauth) reaching MCP servers unexpanded.
- Advisor blocker advisories raised inside the post-interrupt immune window now wake a new turn instead of parking as asides until the next user prompt.
- The exit banner only advertises `omp --resume <id>` when the session was actually written to disk, so the printed command no longer fails for sessions that ended before persistence ([#8860](https://github.com/can1357/oh-my-pi/issues/8860)).
- Fixed terminals that deliver Shift+Enter as a bare LF (or the legacy CSI `13;2~` form) getting a plain switch instead of summarize-and-switch in the `/tree` selector ([#8821](https://github.com/can1357/oh-my-pi/issues/8821)).
- Fixed OMP panicking at startup when the host environment contains a non-UTF-8 variable value; such entries are now skipped when copying the host environment into the shell ([#8925](https://github.com/can1357/oh-my-pi/issues/8925)).
- Fixed `/mcp reauth` refusing to run the OAuth flow for HTTP MCP servers that allow unauthenticated `initialize` but require auth for `tools/call`; endpoint discovery now runs against the server URL before giving up ([#8922](https://github.com/can1357/oh-my-pi/issues/8922)).

## [17.3.7] - 2026-08-17

### Changed

- Send the `omp/<version>` User-Agent on xAI chat (`xai` and `xai-oauth`) unless the request already set its own ([#8840](https://github.com/can1357/oh-my-pi/pull/8840) by [@Jaaneek](https://github.com/Jaaneek)).

## [17.3.6] - 2026-08-17

### Added

- Added `ExtensionAPI.registerFileWriteFallback(handler)` and `ExtensionAPI.registerFileDeleteFallback(handler)`, letting an extension supply a fallback writer or deleter that is consulted when a native `write`, `edit`, or `apply_patch` byte-write or unlink is denied with a permission error (`EPERM`/`EACCES`/`EROFS`) — for hosts that embed the agent inside a sandbox that denies direct filesystem access but exposes a privileged channel. The brokered path is symlink-resolved so a handler's allowlist sees the real destination, a destination that cannot be resolved is not brokered at all, and `req.sessionId` names the session that issued the mutation so a handler sharing the process-wide registry can enforce policy per session. See [`docs/extensions.md`](../../docs/extensions.md).

### Changed

- Updated the default model for XAI_API_KEY (xai) and SuperGrok OAuth (xai-oauth) to grok-4.6. Automatic model selection continues to prefer paid xai/grok-4.6 when only XAI_API_KEY is set, with xai-oauth/grok-4.6 still available explicitly.

### Fixed

- Fixed `omp stats` and `/stats` dashboards being unreachable from container hosts by accepting an explicit `--host` bind address while preserving the `127.0.0.1` default.

## [17.3.5] - 2026-08-16

### Added

- Added Extensions tab group to settings schema

### Changed

- Routed paid xAI models (XAI_API_KEY / xai/…) through the Responses API used by SuperGrok OAuth instead of Chat Completions, including reliable replay of encrypted reasoning content on follow-up turns.
- Updated the default model for XAI_API_KEY (xai) to grok-4.5, and the default SuperGrok OAuth (xai-oauth) model to grok-4.5. Automatic model selection continues to prefer paid xai/grok-4.5 when only XAI_API_KEY is set, with xai-oauth/grok-4.5 still available explicitly.
- Stopped sending presence/frequency penalties and stop sequences to xAI reasoning models such as grok-4.5, which reject them.

### Fixed

- Fixed `hub` job and wait lists hiding stale running subagent registrations that have no turn in flight, ensuring they remain visible so operators can cancel them
- Fixed external thinking scratchpads running alongside native reasoning on xAI Grok 4 and other reasoning-only Responses models that reject `reasoning.effort`
- Fixed llama.cpp model discovery producing a baseUrl without the /v1 prefix for non-Qwen models, causing 404 errors on OpenAI-compatible endpoints.
- Fixed prompt caching on open-weight providers (DeepSeek, Qwen, GLM, …) so tool schemas stay cached across directory changes and midnight rollovers.
- Fixed omp --fork omitting the source session's artifact directory, so CLI-created forks now preserve artifact:// references like interactive /fork.
- Fixed long ask option labels being hard-truncated at the terminal width; labels now wrap onto indented continuation lines.
- Fixed toggling display.showTokenUsage from /settings leaving existing token-usage rows stale until the transcript was rebuilt.
- Fixed mid-run auto-compaction blocking the live loop while waiting on extension handlers, which could hang after a snapcompact or context-full pass.
- Reduced peak memory for persisted subagent revival probes by streaming large file-backed session journals instead of loading them fully.
- Improved responsiveness of streaming edit previews for large diffs by rendering only the visible tail.
- Fixed repeated /btw panels committing transient frames to native scrollback and replaying conversation history after dismissal.
- Clarified that closing browser tool sessions releases managed handles without closing pages in spawned, CDP-connected, or relay browsers.
- Fixed interrupted vibe_wait calls being reported as elapsed timeout windows.
- Improved checkpoint/rewind prompt rendering to stay accurate after a rewind and be more concise.
- Fixed Cursor turns dying with HTTP/2 stream errors (NGHTTP2_INTERNAL_ERROR / NGHTTP2_REFUSED_STREAM) after tool calls already had results, instead of leaving the agent idle until the user typed "continue".
- Fixed mixed-case plugin tool names being lowercased during tool-set refresh, which unmounted them from xd:// whenever MCP tools connected.
- Fixed Exa MCP servers being unmounted when their config explicitly requests tools the native Exa integration does not provide, breaking /mcp reconnect exa.
- Fixed Claude Code custom tool discovery attempting to import non-module files from .claude/tools.
- Fixed Agent Hub parking a mid-spawn child session so subsequent task calls failed with an ownership error and the row could never be revived.
- Fixed the welcome banner displaying a stale model name when the session's active model changes after startup (e.g. after a delayed config load or an explicit /model switch).
- Fixed Nix standalone binaries retaining Bun's build-time package in their runtime closure.
- Fixed birch user/custom message card contrast on dark terminals, where chat bubbles could render light-on-light.
- Fixed hidden tool snapshots preventing long streamed assistant responses from entering terminal scrollback.
- Prevented omp models from loading ambient hook factories while preserving extension-contributed providers.
- Fixed the ask dialog's multi-select mode dead-ending on Enter; Space now toggles options and Enter submits the current selection.
- Fixed workspace diagnostics reporting a clean workspace when its checker crashed without producing output.
- Fixed manual /compact failing outright when a summarization request hit a transient provider overload.
- Fixed transient Anthropic failures (overloaded_error, rate_limit_error, 429/500/502/503/529) aborting or silently degrading side-effect-free background LLM calls such as session title generation, TTS speech enhancement, commit-message generation, thinking/stop classifiers, memory extraction/consolidation, and commit analysis/summary/changelog passes; these now retry with backoff honoring retry-after instead of failing or returning an indistinguishable empty result.
- Fixed the shared headless browser daemon launching from the macOS system Google Chrome bundle, which could cause macOS to route the user's link clicks to the automation daemon and silently swallow them; the daemon now prefers an isolated Chrome for Testing binary on macOS.
- Reclaimed abandoned daemon runtime directories under ~/.omp/run/daemons/, preventing unbounded growth of leftover Chromium profiles and broker state.
- Kept the welcome screen's Tips, LSP Servers, and Recent sessions visible when a long model name still leaves enough terminal width for both columns.
- Fixed focused shimmer animation frames (ultrathink, orchestrate, workflowz) repainting the full TUI too frequently, causing high CPU usage while composing prompts on WSL2.
- Fixed the /debug report bundle including unrelated historic sessions, leaking other sessions' files and bloating archives.
- Fixed adopted keep-alive agents remaining stuck in a running state in the registry after deferred turn settlement, and prevented stale refs from sustaining bare hub wait calls indefinitely.
- Fixed home-relative marketplace catalog paths not being expanded before cache access, preventing updates from writing into a literal ~ directory.
- Fixed broker-owned headless Chromium opening and retaining an unowned blank foreground window on Windows.
- Fixed the auto thinking classifier failing every turn on Anthropic models served through LiteLLM/Vertex due to a thinking-budget mismatch.
- Fixed always-ask approval prompts bypassing edit preview readiness when a built-in tool executes under its wire-level alias, such as edit running as apply_patch.
- Fixed lsp reload crashing non-rust-analyzer language servers by sending them a rust-analyzer-specific request; that request is now gated to rust-analyzer only.
- Fixed browser open failing with "Shared browser daemon unavailable" when HTTP_PROXY/HTTPS_PROXY is set, because liveness probes were incorrectly routed through the proxy.
- Fixed defaultThinkingLevel: auto skipping classification for user-invoked /skill:<name> turns, leaving the effort stuck on pending auto.
- Fixed custom-tool directory discovery recursing into subtrees despite a non-recursive default, which could crash startup when scanning large dependency directories such as Python venvs.
- Repaired torn session JSONL appends after disk-write failures, rewrote malformed resumed files before their next append, retried transient persistence failures, and surfaced failures in the TUI.
- Prevented Anthropic model fallback from replaying model-bound thinking blocks across models, and surfaced immutable-thinking errors without retrying the unchanged invalid turn.
- Fixed empty-stop failure messages always suggesting a context problem even when the provider billed output tokens; the message now reports the billed token count and points at a provider-side filter/translation issue when appropriate.
- Fixed a parked, session-less agent-registry entry with no reviver permanently poisoning its agent id, preventing fresh subagent spawns from reusing that id.
- Made extension tool-call timeouts configurable and paused them during user dialogs.
- Fixed /vibe cancellation leaving an in-flight model turn unaware that Vibe mode and its tools were removed.
- Fixed empty local-model stops lingering on the persisted active branch after retries, preventing them from resurfacing after reload or a mid-retry process kill.
- Fixed the Biome linter client silently dropping every diagnostic due to an outdated JSON output schema; it now supports Biome 2.x's diagnostic format.
- Fixed `hub jobs` and empty `hub wait` snapshots hiding running subagents that have no live turn, which removed the only way to discover and `hub cancel` a stale registration; such agents are listed again and flagged as having no turn in flight.
- Fixed external thinking being offered on xAI reasoning-only Responses models (grok-4 family) that reject `reasoning.effort`, where the private scratchpad ran alongside native reasoning instead of replacing it.
- Fixed the extension tool-call handler timeout rendering outside a titled section in `/settings` by registering its Extensions group on the Tools tab.

## [17.3.4] - 2026-08-14

### Changed

- Replaced the MuPDF-WASM PDF document backend with `pdf-inspector` through `@oh-my-pi/pi-natives`, preserving cached text conversion and PDF line selectors while reporting pages that need OCR.
- Restored `read <pdf>:` and `read <pdf>:<image>.png` page rendering by automatically capturing PDF pages through the headless Chromium browser tool.

### Fixed

- Fixed Streamable HTTP MCP sessions being invalidated by opening the optional GET SSE stream before sending `notifications/initialized`, which prevented Figma Dev Mode MCP from connecting ([#8514](https://github.com/can1357/oh-my-pi/issues/8514)).
- Fixed the `/hotkeys` table describing Ctrl+D (`app.exit`) as "Exit (when editor is empty)" when it actually exits unconditionally and saves the current prompt as a resumable draft ([#8530](https://github.com/can1357/oh-my-pi/issues/8530)).
- Fixed Ctrl+G external editors failing to launch on Windows because Bun re-quoted the embedded `cmd.exe /c` command line ([#8544](https://github.com/can1357/oh-my-pi/issues/8544)).

## [17.3.3] - 2026-08-14

### Fixed

- Automatically continued Gemini turns that stopped after thinking without final output, using a bounded final-answer reminder instead of exhausting generic retries.
- Retried Gemini `MALFORMED_FUNCTION_CALL` failures when every emitted tool call was proven unexecuted, while preserving real tool-result and visible-output replay guards.
- Kept current terminal retry errors in one pinned banner with attempt context while surfacing local continuation failures instead of stale provider errors.

## [17.3.2] - 2026-08-13

### Fixed

- Fixed the parent TUI stalling after a subagent submits its result until terminal focus or resize wakes the event loop ([#8462](https://github.com/can1357/oh-my-pi/issues/8462)).
- Fixed `omp update` misclassifying foreign npm/bun bin aliases while preserving package-manager ownership for globally linked checkouts ([#8468](https://github.com/can1357/oh-my-pi/issues/8468)).
- Fixed `read` hashline headers collapsing nested in-workspace paths to the bare basename, which let a same-basename file at the session cwd capture a verbatim follow-up `edit` and deterministically reject it with `hash is not from this session`. Headers now retain the workspace-relative path (e.g. `[src/settings.json#0063]`) ([#8482](https://github.com/can1357/oh-my-pi/issues/8482)).

## [17.3.1] - 2026-08-13

### Fixed

- Fixed Claude Code user discovery ignoring CLAUDE_CONFIG_DIR for configuration, plugins, MCP servers, and imported sessions.
- Fixed the status-line git branch display freezing after switching branches.
- Fixed Pi extension contexts omitting the runtime mode, which caused TUI guards to silently disable extension UI.
- Fixed extension-registered tool names being rejected by the --tools flag before extension discovery, which prevented least-privilege sessions from allowlisting plugin tools.
- Fixed omp plugin install failing with cloning errors for legacy Pi extensions whose tool schemas use legacy-typebox builders.
- Fixed omp update aborting with chmod ENOENT when concurrent update runs overlapped by using unique download temporary paths.
- Fixed the browser tool executable probe launching the user's installed GUI Chromium on Windows: the `--version` version probe from ecb22957 was Linux-scoped but ran for every platform candidate, so on Windows it could hand off to a running `chrome.exe`, open a normal browser window, then reject the candidate and fall back to cached Chrome for Testing. The probe is now confined to Linux ([#8445](https://github.com/can1357/oh-my-pi/issues/8445)).

## [17.3.0] - 2026-08-13

### Breaking Changes

- Removed the global `advisor.subagents` setting. Subagent advisors are now configured per agent via frontmatter or `task.agentAdvisor`. Existing configurations of `advisor.subagents: true` will automatically migrate to `task.agentAdvisor: { task: "on" }`.

### Added

- Added Astral `ty` as a built-in fallback Python LSP server (`ty server`), ordered behind `pyright`, `basedpyright`, and `pylsp`.
- Added first-party Nix support, including reproducible source builds for Linux and macOS, a pinned development shell, NixOS and Home Manager modules, and offline Bun dependency support.
- Added support for per-agent advisors configured via the `advisor` frontmatter field or the `task.agentAdvisor` settings, allowing different agents to be advised by different models.
- Redesigned the `/agents` interface as a fullscreen hub featuring a scope sidebar, type-to-filter search, a pinned detail pane, mouse support, and interactive property chips for configuring agent settings.
- Prepared for the upcoming npm package rename by updating `omp update` and startup version checks to follow the `omp.rename` pointer in the published manifest.

### Changed

- Updated `/usage`, `omp usage`, and the status line to display authoritative OpenCode Go quota usage directly from the official endpoint, replacing estimated costs with actual usage across three time windows (5h, 7d, and monthly).
- Documented the source-available local protocol relay and clarified that production collaboration relay binaries are not currently published.
- Enabled bounded Anthropic prompt-cache refreshes for the main agent loop while isolating advisor and side-channel requests from the shared refresh timer.

### Fixed

- Fixed multiple Language Server Protocol (LSP) issues, including concurrent sessions sharing backend overlays, stale document overlays after workspace edits, incorrect transactional edit advertisements, unhandled snippet placeholders in rust-analyzer, and failing to restore overwritten targets during failed file renames.
- Fixed LSP `diagnostics` incorrectly reporting success when all language servers failed.
- Fixed Hindsight memory scoping splitting repositories across multiple scopes on case-sensitive filesystems by lowercasing the project label.
- Fixed the CLI crashing at startup with a raw `AuthBrokerError` when the configured auth broker is unreachable, replacing it with an actionable error message.
- Fixed various resource and process leaks, including idle launch brokers staying alive indefinitely, stale MCP connections leaving child processes open, and undrained stdout in DAP `runInTerminal` requests.
- Fixed custom STB-backed vision providers failing to decode WebP images by automatically detecting image formats from bytes and normalizing WebP blocks.
- Fixed command-backed provider API keys (`!command`) staying pinned to cached values after receiving an HTTP 401 error.
- Fixed the `/agents` Control Center failing to open when model overrides are configured as YAML arrays.
- Fixed session-title generation regressions by restoring plain-sentence phrasing and name-fidelity instructions.
- Fixed agent-facing prompts and system instructions mentioning tools that are absent from the current session catalog.
- Fixed manual `/shake` discarding all tool results; it now retains a small recent tail of results to preserve active working context.
- Fixed `omp install` failing validation for extensions importing legacy `is<Tool>ToolResult` event guards.
- Fixed profile aliases generated by standalone binaries invoking Bun's embedded virtual script instead of the installed `omp` command.
- Fixed `/skill:<name>` tokens in `/plan` or `/vibe` inline prompts being treated as literal text instead of executing the skill.
- Fixed long streaming `write` previews stalling the TUI by optimizing file scanning and splitting.
- Fixed the Windows console disappearing when running commands like `/stats`.
- Fixed retry-fallback selection switching to a fallback model with a context window too small to hold the current session context.
- Fixed OpenCode discovery ignoring `opencode.jsonc` files and rejecting comments in `opencode.json`.
- Fixed WSL2 startup hanging forever when the Windows interop pipe is wedged: the WSL host-home discovery probes (`cmd.exe`, `wslpath`) now run under a 500ms hard timeout and fall back to the Linux `$HOME`/`~/.omp` candidates ([#8402](https://github.com/can1357/oh-my-pi/issues/8402)).

## [17.2.15] - 2026-08-12

### Added

- Added `--external-thinking` CLI flag to force external thinking tool activation.
- Added `omp compress` command, which uses an isolated, two-tool agent loop to rewrite single or multiple text files (supporting glob patterns and concurrent processing) into dense prompt registers.
- Expanded tool discovery in `omp cleanse` to support `staticcheck` and `golangci-lint` (Go); `mypy`, `pylint`, `flake8`, `ty`, and `basedpyright` (Python); `oxlint`, `deno lint`, `stylelint`, and `vue-tsc` (JS/TS); and `actionlint` (GitHub Workflows).
- Added support for natural language requests in `omp cleanse "<request>"`, which launches a discovery subagent to automatically inspect the project, determine the correct commands, and map outputs.
- Added an interactive picker to `omp cleanse` when run without arguments on a TTY, allowing users to run all checkers, select a specific checker, or describe what to fix.

### Changed

- Restricted the `think` tool to GPT, Claude, and Gemini transports that support native reasoning replacement.
- Increased the default subagent cap for `omp cleanse` from 8 to 32.

### Fixed

- Fixed a hang in headless `omp -p` runs when `plan.defaultOnStartup: true` is enabled by disabling the startup default in print mode.
- Fixed `display.hideToolActivity` failing to hide certain activity blocks, such as reminders, diagnostics, and completions.
- Fixed several issues in the MCP Streamable HTTP transport, including updating the negotiated protocol version to `2025-11-25`, resolving connection drops and SSE resumption gaps, and preventing double-execution of tools during auth refreshes.
- Fixed `/handoff` losing local artifacts (plans, scratch files, research notes) by copying them across the handoff session boundary.
- Replaced libarchive-based tar parsing with a hardened, in-process tar reader to prevent crashes and safely handle complex archive structures, symlinks, and sparse metadata.
- Fixed `Ctrl+O` tool-output expansion failing to reach launch-completion messages wrapped in the hidden tool activity container.

## [17.2.14] - 2026-08-11

### Added

- Added `externalThinking` setting for private scratchpad reasoning via the new `think` tool

## [17.2.13] - 2026-08-11

### Added

- Added `searxng.safesearch` setting option for SearXNG searches
- `omp update` now honors an `omp.dist` distribution field published in the release's npm manifest and treats major-version bumps without one as binary-only: bun/npm-managed installs are migrated to the standalone GitHub release binary in place instead of running a package-manager install that a non-npm release (e.g. a runtime change) would break. Windows script-shim installs (npm's `omp.cmd`/`omp.ps1`) are taken over seamlessly by installing `omp.exe` beside the shims and retiring them.
- Added support for Cloudflare AI Gateway routing for Gemini search
- Added support for Exa MCP search provider
- Added domain inclusion/exclusion filtering and URL deduplication for TinyFish search
- Fixed `/vibe` mode losing the pre-vibe toolset when a session already in vibe mode switches into another session that is also in vibe mode, which left `bash`, `edit`, `write`, `grep`, `glob`, `task`, and `hub` silently unavailable after exiting the mode; the pre-vibe toolset is now recorded on the `mode_change` entry and restored from there.
- Preserved extension-filtered pasted image payloads and source links when `/goal`, `/plan`, or `/vibe` submits the composer draft.
- Fixed Agent Hub lineage registration timestamps displaying in UTC instead of the user's local timezone.
- Fixed Python/Julia/Ruby eval kernels failing to start after their staged runner script was cleared mid-session (e.g. a macOS tmpdir sweep): the memoized runner path is now re-validated so a long-lived process self-heals instead of only recovering on restart ([#8140](https://github.com/can1357/oh-my-pi/issues/8140)).
- Fixed session resume fully reading and parsing the journal twice by reusing the entries already loaded by `SessionManager.open()` ([#8117](https://github.com/can1357/oh-my-pi/issues/8117)).
- Fixed RPC `message_end` frames being serialized more than once before output while preserving v1 and v2 wire bytes ([#8118](https://github.com/can1357/oh-my-pi/issues/8118)).
- Fixed message conversion caching strongly retaining the last session transcript and converted output after session disposal ([#8119](https://github.com/can1357/oh-my-pi/issues/8119)).
- Fixed timed-out LSP requests continuing to consume server CPU and block queued requests by sending `$/cancelRequest` ([#8116](https://github.com/can1357/oh-my-pi/issues/8116)).
- Fixed `shutdownAll()` leaving the configured LSP idle checker alive and preventing short-lived SDK hosts from exiting ([#8115](https://github.com/can1357/oh-my-pi/issues/8115)).
- Fixed terminal Mermaid borders and junctions using low-contrast UI chrome colors instead of the active theme's readable content color.
- Fixed Cursor provider sessions flooding bash/grep validation errors (`cwd`/`case`/`skip` "was undefined") when Cursor omitted optional exec-frame fields; the exec bridge now omits unset optional kwargs before tool execution and transcript synthesis.
- Added structured reset-reason logging to advisor context re-primes (issue #7226): every history-rewrite trigger (compact, auto-compaction, compaction-rescue, shake, drop-images, prune-tool-outputs, prune-stale-tool-results, conversation-boundary, context-maintenance) now emits an `advisor context reset` debug event with its reason, so full-transcript replays can be attributed to a concrete path.
- Added `quarantine-recovery` and `quarantine-retry-exhausted` reset reasons to advisor context-reset debug logs, so advisor full re-primes after quarantined output remain attributable without changing quarantine retry semantics (issue #7226).

### Changed

- Standardized first-party outbound User-Agent headers on `omp/<version>` via the shared `USER_AGENT` utility.

### Fixed

- Fixed `/usage`, `/advisor status`, and every other panel command answering only after the agent stopped working. Since `17.0.1` their output was queued until the turn settled (to stop mid-turn transcript mounts duplicating rows in native scrollback, issues #4806/#6767), and the deferral was silent, so on a long turn the command was indistinguishable from a dead one. The panel now renders immediately above the editor in an anchored container that is cleared and rebuilt in place, never entering the transcript, and the full output still lands in the transcript at the next settle. The preview is capped to 40% of the viewport (minimum 6 rows) so a tall report cannot push the prompt off screen.
- Fixed the todo panel showing no progress while the agent worked through a plan: every sub-todo read as unchecked no matter how far along the run was. Three causes, all in the collapsed (default) view — the walking viewport dropped *every* closed row, so a completion only ever removed a line and the card's strike-reveal animation ran against a row nobody rendered; the phase the agent was actually in was the one phase header rendered without a `done/total` count; and the 60s todo auto-clear deleted closed tasks from an unfinished plan, resetting the phase counter to `0/n` and renumbering the stages until the next `todo` call restored the real snapshot. The viewport now keeps the newest closed task as a checked lead row (additive to the open-task cap), every phase header carries its progress, counts include abandoned tasks, and auto-clear only fires once the whole list is settled.
- Status-line `usage` now renders monthly Cursor quotas (`mo N%`) in addition to the existing `5h` / `7d` windows ([#7998](https://github.com/can1357/oh-my-pi/pull/7998) by [@dnth](https://github.com/dnth)).
- Restored the `ctx.ui.custom()` overlay API that regressed after v0.45.6: `overlayOptions` (anchor/width/maxHeight/margin positioning and sizing) is now forwarded to `showOverlay` instead of a hardcoded full-cover geometry, `onHandle` receives the resulting `OverlayHandle`, and `OverlayHandle`/`OverlayOptions` are exported from the extension API types again.
- Fixed a content refusal that arrives after the model already emitted a tool call ending the turn outright instead of consulting the model fallback chain. When the refused turn produced nothing visible and every emitted tool call provably never executed (each paired with a synthetic `executed: false` result), the turn is now retryable and the configured `retry.fallbackChains` entry gets its chance, matching how a refusal with no tool calls already behaves.
- Fixed proxy discovery preferring the bundled catalog name over the proxy-reported name, so `omp models refresh` now updates stale display names (e.g. a proxy serving `longcat-2.0` as `"LongCat"` no longer shows the raw id).
- Fixed the compiled binary build on Windows: `Bun.Glob.scan` yields backslash-separated paths, which the legacy Pi virtual module used verbatim for export keys and generated identifiers, producing invalid JavaScript.
- Fixed Ctrl+O (`app.tools.expand`) not expanding truncated tool output while a tool-approval prompt or other selection dialog held keyboard focus, by promoting the shortcut to a global input listener that fires regardless of focus (it still defers to fullscreen overlays and the tree selector's own Ctrl+O filter cycle) ([#7837](https://github.com/can1357/oh-my-pi/issues/7837)).
- Fixed `omp commit` printing a wall of bundled source when a `pre-commit`/`commit-msg` hook refuses a commit: hook failures are now reported with the hook's own message, split plans report how far they got, and the command exits non-zero cleanly ([#7834](https://github.com/can1357/oh-my-pi/issues/7834)).
- Fixed `omp commit --push` exiting 0 without pushing when the working tree is already clean; it now pushes the existing commits (or fails non-zero if the push is refused) ([#7834](https://github.com/can1357/oh-my-pi/issues/7834)).
- Subagents spawned through a model-role alias now inherit that role's `retry.fallbackChains` entry instead of the `default` chain. Both spawn paths (`task` and vibe workers) expand the alias — the bundled `task` agent's `@task`, `sonic`/`scout`'s `@smol` — before it reaches the executor, so the role identity was lost and every child was pinned to the `default` chain, routing retries onto models the operator had deliberately kept out of the role's chain. Completes [#7694](https://github.com/can1357/oh-my-pi/pull/7694), which only covered agents whose unexpanded alias reached the executor ([#7910](https://github.com/can1357/oh-my-pi/pull/7910) by [@enieuwy](https://github.com/enieuwy)).
- Fixed standalone `AGENTS.md` discovery stopping at nested Git repository roots, so enclosing workspace instructions are loaded while home-level instructions remain scoped correctly.
- Split the advisor Session update delivery into per-source-message user messages (single `Agent.prompt(AgentMessage[])` call) so provider prompt caches grow with the session instead of staying pinned at the instructions/tools boundary; rendering stays byte-identical to the old single-block update.
- Restore the advisor primary-context dedup map when a failed advisor turn is rolled back, so retried batches re-deliver first-time plan/goal context in full instead of collapsing it to "(unchanged — still in effect)".
- Include all renderer-read fields (excludeFromContext, bashExecution command, pythonExecution code, branch/compaction summary + fromId, fileMention files) in advisor prefix fingerprints so clones changing only those fields correctly trigger a re-render.
- Fixed Gemini advisors treating a valid silent review as an empty-response failure, repeatedly retrying the turn and eventually dropping the advisor backlog. ([#8223](https://github.com/can1357/oh-my-pi/issues/8223))
- Fixed bash-tool commands receiving an unguarded `CI=1`, which broke clap-based CLIs (e.g. `tauri android build`) that parse `CI` as a strict boolean, and ignored the documented `PI_BASH_NO_CI` opt-out. The per-command env now injects clap-compatible `CI=true` and honors `PI_BASH_NO_CI`/`CLAUDE_BASH_NO_CI` ([#8229](https://github.com/can1357/oh-my-pi/issues/8229)).
- Fixed macOS key hints rendering the Linux/Windows modifier names `Alt` and `Super` across every hint surface (`/hotkeys`, status bar, autocomplete, pending-message bar, copy selector, ask dialog): `alt` now renders as `Option` and `super` as `Cmd` on darwin, and the static `/hotkeys` navigation rows are platform-aware instead of hardcoding macOS `Option`/`Cmd` names on every platform ([#8235](https://github.com/can1357/oh-my-pi/issues/8235)).
- Fixed `omp plugin uninstall <plugin> --dry-run` actually removing the plugin on both the npm and marketplace routes; dry-run now reports what would be removed and leaves installed plugin state unchanged ([#8178](https://github.com/can1357/oh-my-pi/issues/8178)).
- Fixed handled OMP shutdown persisting running subagents as terminally aborted instead of restoring their transcripts as parked and revivable. ([#8216](https://github.com/can1357/oh-my-pi/issues/8216))
- Fixed `always-ask` approval prompts opening before large edit previews finish rendering, preventing blind approvals ([#7957](https://github.com/can1357/oh-my-pi/issues/7957)).
- Fixed Pi-compatible extensions registering tools during asynchronous session startup being omitted from the live model tool registry.

### Removed

- Removed the `resolveAgentModelSource` model-resolver export, whose only use was being fed to `resolveExplicitModelRole`. Replaced by `resolveAgentModelSelection`, which returns the expanded `patterns` and the pre-expansion `role` together so a spawn path cannot derive one without the other ([#7910](https://github.com/can1357/oh-my-pi/pull/7910) by [@enieuwy](https://github.com/enieuwy)).
- A run is now attributed to the model that actually produced its output, not whichever model the session was last pointed at. A retry fallback that errored on its first request — an exhausted quota, a hard provider error — was credited with the whole run in the Agent Hub row and the settled task result, even when the previous model did every turn. Sessions expose the serving model directly, holding the last model that produced output while a candidate is armed but unproven, and transcript-derived history stops at the newest turn that produced output.

## [17.2.12] - 2026-08-08

### Fixed

- Fixed shell minimization replacing meaningful `rustc --print` output with `OK`.
- Fixed shell minimization altering outputs shorter than 1,000 characters; these now pass through unchanged.
- Fixed primary and advisor Codex sessions falling back to another provider before trying sibling accounts when an account lacks Trusted Access for Cyber approval.
- Fixed task subagent assistant turns being omitted from the per-model TPS/TTFT aggregates shown by `/models`. ([#8022](https://github.com/can1357/oh-my-pi/issues/8022))
- Fixed terminal-title spinner writes consuming CPU during WSL/ConPTY agent waits by using the same static working separator as native Windows ([#8012](https://github.com/can1357/oh-my-pi/issues/8012)).
- Fixed long-running sessions leaking memory for every completed keep-alive `task`/scout subagent: a disposed (parked) subagent's `AgentSession` stayed pinned through the lifecycle adoption record's reviver closure, and `dispose()` never released the message array, append-only provider transcript, session-manager entries, or the raw-SSE debug buffer, so heavy transcripts and captured provider wire frames accumulated for the process lifetime ([#8003](https://github.com/can1357/oh-my-pi/issues/8003)).
- Fixed Z.AI web search dropping sources and exposing raw JSON when MCP responses double-encode content text ([#8000](https://github.com/can1357/oh-my-pi/issues/8000)).
- Fixed `/handoff` masking empty/whitespace-only generation and harness-initiated aborts as "Handoff cancelled"; manual empty generation now surfaces a logged failure, harness aborts preserve their reason (or report "Handoff aborted by session"), and auto-handoff still falls back to context-full compaction ([#7993](https://github.com/can1357/oh-my-pi/issues/7993)).
- Fixed Claude marketplace task agents treating provider-specific model aliases as OMP selectors, allowing them to inherit the parent model ([#7966](https://github.com/can1357/oh-my-pi/issues/7966)).

## [17.2.11] - 2026-08-07

### Added

- Added support for the Agent Plugins 1.0.0 standard, enabling automatic discovery, validation, and secure execution of compliant plugin packages.
- Added the `omp share <session>` command to share saved sessions by ID prefix or file path without launching the agent.
- Added the `AGENT=1` environment variable to child processes spawned by `coding-agent` to allow downstream tools to detect agent-driven execution.

### Changed

- Consolidated Exa web-search configuration under `exa.enabled`, automatically migrating legacy `exa.enableSearch` values and removing obsolete Researcher and Websets settings.
- Removed stale `computer.backend` values during configuration migration.
- Updated documentation and error messages for the JavaScript/TypeScript debug adapter (`js-debug-adapter`) to clarify supported installation paths (Mason, standalone tarball, or `JS_DEBUG_DAP_SERVER`).

### Fixed

- Fixed an issue where `/reload-plugins` and the Agent Control Center failed to propagate updated agent definitions to existing tools without a restart.
- Fixed legacy Pi extensions failing to load when calling `pi.unregisterProvider()`, ensuring provider replacements take effect immediately.
- Fixed zero-width daemon readiness and wait regex matches being rejected by the hub wire decoder.
- Fixed proxy model discovery preferring bundled catalog names over proxy-reported names, allowing `omp models refresh` to correctly update display names.
- Fixed Windows compiled binary builds failing due to backslash-separated paths in `Bun.Glob.scan` producing invalid JavaScript in virtual modules.
- Fixed the Ctrl+O (`app.tools.expand`) shortcut not expanding truncated tool output when a tool-approval prompt or selection dialog had keyboard focus.
- Improved `omp commit` error reporting when pre-commit or commit-msg hooks fail, displaying the hook's own message and exiting non-zero cleanly instead of printing bundled source code.
- Fixed `omp commit --push` exiting with code 0 without pushing when the working tree is already clean; it now correctly pushes existing commits.
- Fixed `omp commit` exiting with code 0 when the commit agent failed and fell back to a mechanical commit; it now exits non-zero to indicate the fallback was used.
- Fixed strict output schemas being rejected when native JSON Schema definition maps contain `ref` or applicator branches use `properties` without `type`.
- Fixed shell syntax extraction in `cd <path> && ...` commands to prevent redirects, extra arguments, or shell expansions from being incorrectly absorbed into the structured working directory path.
- Applied reason-specific backoff to transient rate-limit retries and consolidated exhausted retry errors.
- Fixed session-tree rows rendering as empty bullets for bookkeeping entries (such as title changes, credential pins, and mode changes); these are now hidden by default and properly labeled in `all` mode.
- Fixed extension and custom tools inheriting same-named built-in TUI renderers, which could overwrite successful results with incorrect status text.
- Fixed prewalk lifecycle handling to prevent plan injection on rejected same-model/same-effort arms, ensure consumed plan nudges do not return after context rebuilds, and prevent settings-enabled prewalk from implicitly re-arming restored sessions.
- Fixed the todo completion reminder interrupting pauses when waiting for non-English questions (such as Chinese, Japanese, Korean, or Spanish prompts ending in `？` or `?`).
- Normalized resolved file paths in read summaries, PDF image handles, and notebook errors to prevent agents from learning malformed paths.
- Fixed a bug where a per-turn `before_agent_start` system prompt override was silently dropped during base-prompt rebuilds.
- Fixed ACP `session/load` and `session/resume` failing with `ACP session not found` for sessions created under the legacy hashed project-directory scheme by falling back to a global ID scan.
- Fixed `vault://<name>?op=...` commands targeting the active vault instead of the named vault in Obsidian CLI queries.
- Fixed the status-line `session_name` segment to honor the `statusLine.sessionAccent` setting, falling back to the theme's accent color when disabled.
- Fixed automatic `agent.continue()` paths failing to run context-fit maintenance when reverting to a smaller-context model after a cooldown expiry.
- Fixed `/handoff` reporting "Handoff cancelled" for actual generation or stream timeout errors, ensuring the real error is surfaced.

## [17.2.10] - 2026-08-06

### Breaking Changes

- Replaced the re-exported `zod` API with an `omptype`-backed compatibility facade (`@oh-my-pi/omptype/zod`). Plugins retain the standard Zod-style builder interface, but real Zod-specific APIs are no longer available.

### Added

- Added a `--trusted-extension <absolute-path>` CLI flag to load an exact extension-module allowlist, bypassing ambient extension discovery.
- Added resumable session details to fatal crash outputs, including a suggested `omp --resume <session-id>` command to quickly resume persisted live agent sessions.

### Changed

- Reworked the Ctrl+S Agent Hub into a responsive fullscreen roster and selected-agent inspector, featuring aggregate status/usage metrics, detailed per-agent views (task, model, activity, usage, lineage), roster and spawn-tree views, stable ordering, asynchronous persisted-session discovery, restored historical metadata, and improved keyboard and mouse navigation.
- Replaced `arktype` with `@oh-my-pi/omptype` for all tool parameter and configuration schemas, resulting in significantly faster startup times. Configuration schema errors are now reported via `OmpErrors` entries using the standard `path`/`problem` format.

### Fixed

- Fixed panel commands (such as `/usage` and `/advisor status`) appearing unresponsive during active turns by flushing the deferred-panel queue at every settle, terminal or not. The deferral itself stays silent: mounting a status line into the transcript mid-turn re-renders rows below the live block and duplicates them in native scrollback (issues #4806/#6767).
- Fixed the bundled `ts-no-tiny-functions` rule failing to match one-line arrow functions in files with trailing newlines.
- Fixed advisor refusals skipping the model fallback chain, and bounded refusal recovery to a single attempt per model to prevent infinite fallback loops.
- Fixed repeated `/mcp reauth` commands getting stuck by ensuring new reauthorization requests cancel and clean up any pending MCP OAuth login flows.
- Fixed WSL host-home resolution to build `/mnt/<drive>/...` fallback paths using POSIX semantics regardless of the host platform.
- Fixed Python evaluation shell helpers (`!cmd`, `%%bash`, `%pip`) letting child processes inherit the runner's stdin, which previously caused deadlocks on Windows. Additionally, `%%bash` now correctly resolves Git Bash on Windows.
- Fixed subagents spawned via model-role aliases incorrectly falling back to the `default` role's retry chain instead of their own configured role chain.
- Fixed Linux/X11 clipboard reads failing when `xclip` is missing but `xsel` is available.
- Hardened Linux Chromium executable detection to filter out non-executable files, invalid wrappers, and candidates that hang during version probes.
- Fixed Bash command preview crashes caused by malformed tool arguments containing non-string environment values.
- Fixed UI rendering in the model browser and model hub where `nerd`-preset role chips would overlap and obscure the first character of labels.
- Fixed Codex web search sending incompatible request shapes to certain models, which caused the hosted `web_search` tool to ignore them.
- Fixed resumed or rebuilt sessions incorrectly applying stale rewind reports from previous checkpoint cycles to new checkpoints.
- Fixed the `read` tool incorrectly parsing semicolon-delimited internal URLs (such as batched `skill://` resources) as a single invalid resource.
- Fixed `pi.getAllTools()` returning bare strings instead of `ToolInfo[]` objects, restoring compatibility with extensions built against the upstream contract.
- Fixed legacy extensions failing to load in compiled binaries when resolving bundled dependencies via dynamic `createRequire` factories.
- Fixed Wayland window activation and native input handling by correctly reporting them as unavailable rather than attempting unsupported foreground-delivery paths.
- Fixed live execution progress being hidden in the conversation view after approving a plan in the fullscreen Plan Review.
- Fixed `omp -r` failing to discover sessions created under the temporary hashed project-directory scheme by adding a one-way migration back to legacy path-based names.
- Prevented the `read` tool from advertising or resolving `memory://` URIs when the memory backend is disabled.
- Fixed the Shift-Tab thinking mode UI rendering the `off` state as a blank label, which made it appear that reasoning could not be disabled.
- Fixed parsing of POSIX `$EDITOR` commands that contain quoted arguments or executable paths with spaces.
- Fixed persisted Agent Hub rows losing the explicit caller model role when a subagent used a model override, preserving role provenance across restarts.
- Fixed unobserved promise rejections in browser helpers (such as `tab.waitForResponse()`) causing tab workers to hang or crash.

## [17.2.9] - 2026-08-05

### Breaking Changes

- Renamed `compareVersions` to `compareChangelogEntries` in `@oh-my-pi/pi-coding-agent/utils/changelog`. The function signature and behavior are unchanged; update imports to use the new name.

### Added

- Added automatic detection of common Ungoogled Chromium Linux installations for the browser tool.

### Changed

- Restored the legacy project-scoped session directory naming scheme and removed its automatic migration ([#7646](https://github.com/can1357/oh-my-pi/issues/7646)).
- Routed Bun install-cache pruning in `update-cli` through the shared `compareVersions` utility (`@oh-my-pi/pi-utils`), removing a duplicate local comparator that rounded large numeric version identifiers via `Number`.

### Fixed

- Retried concurrent-request caps with a short backoff without deleting valid Copilot credentials or rotating through sibling accounts.
- Fixed the default `textVerbosity` setting being forwarded to OpenAI Codex requests unless the user explicitly configures it, preserving Codex's native response-control defaults. ([#4949](https://github.com/can1357/oh-my-pi/issues/4949))
- Reduced streaming CPU usage by coalescing the cumulative `message_update` deltas of a turn at the event-controller dispatch boundary: at most one streaming-state rebuild runs per ~33ms window instead of one per token, cutting the per-token handler work that dominated the CPU profile of streaming sessions (especially at high token rates) while preserving per-delta speech output. Subscriber dispatch is serialized so a rapid stream tail (`message_update` → `message_end` → `agent_end`) cannot overtake the coalesced flush. ([#7443](https://github.com/can1357/oh-my-pi/issues/7443))
- Fixed translated MCP importers (Claude Code, Cursor, Gemini CLI, Windsurf, VS Code) silently dropping a server's `enabled: false` flag, so a server disabled at the source config stayed mounted; the flag is now propagated and honored like Codex, OpenCode, and native `mcp.json`. These importers now also load project entries before same-named user entries (matching native/Codex) so a project `enabled: false` suppresses a same-named user server ([#7652](https://github.com/can1357/oh-my-pi/issues/7652)).
- Removed the per-call `model` override from the eval `agent()` helper (all runtimes), completing the earlier task-tool removal (`9f8aa87dbf`). Subagents always use their selected agent's frontmatter model and settings; a legacy `model` argument is silently ignored, so an explicit `model: "default"` can no longer route children onto the parent session model ([#6438](https://github.com/can1357/oh-my-pi/issues/6438)).
- Fixed legacy Pi extension validation rejecting plugins such as `remote-pi` that import the package-root `convertToPng` image helper. ([#7610](https://github.com/can1357/oh-my-pi/issues/7610))
- Fixed the legacy session-directory migration silently deleting a live session's transcript when its filename collided with an existing entry in the destination: colliding entries are now preserved in place, the legacy directory is only removed when empty, and collisions/migration failures are logged ([#7593](https://github.com/can1357/oh-my-pi/issues/7593)).
- Fixed `PUPPETEER_EXECUTABLE_PATH` being ignored when a system Chrome installation was detected, preventing Windows users from selecting a compatible headless browser for the shared browser daemon ([#7601](https://github.com/can1357/oh-my-pi/issues/7601)).
- Fixed `openai-models-list` discovery ignoring server-advertised input modalities, so custom virtual tier IDs absent from the bundled catalog showed `images: no` even when the `/v1/models` response reported `input: ["text","image"]` ([#7583](https://github.com/can1357/oh-my-pi/issues/7583)).
- Exposed exact source line counts in read results when selector-based reads reach EOF, allowing protocol bridges to distinguish a returned slice from the complete file ([#7590](https://github.com/can1357/oh-my-pi/issues/7590)).
- Fixed `grep`/`glob` silently collapsing a semicolon-delimited `path` list to one literal path when the joined string was too long for the OS to name (`ENAMETOOLONG`) — a list of bare filenames past `NAME_MAX` or absolute paths past `PATH_MAX` failed with `Path not found: <whole list>` even though every entry existed. The multipath probe now treats `ENAMETOOLONG` as a definitively non-existent single path so the split proceeds, and `glob` surfaces a clean `Path not found` instead of leaking the raw errno ([#7597](https://github.com/can1357/oh-my-pi/issues/7597)).
- Fixed `--mode json` (and text) print mode truncating a large final record (e.g. a multi-MB `agent_end`) when the process exited before stdout drained, while still exiting 0. Per-event writes are now serialized on their own completion callbacks and shutdown blocks on the last one, so the terminal record is delivered in full ([#7635](https://github.com/can1357/oh-my-pi/issues/7635)).
- Fixed text print mode treating buffered partial responses as replay-unsafe, allowing transient mid-stream connection failures to retry without exposing duplicated output ([#7625](https://github.com/can1357/oh-my-pi/issues/7625)).
- Fixed Hindsight `autoRecall` intermittently not reaching the model: two recall paths shared the `hasRecalledForFirstTurn` flag, and the `agent_start` event path could consume it first and inject only via an unawaited background prompt rebuild that a fast turn outran. `beforeAgentStartPrompt` (awaited before the turn builds) is now the sole injection path ([#7568](https://github.com/can1357/oh-my-pi/issues/7568)).
- Fixed `read memory://<id>` returning a confusing "Unknown memory namespace" error under `memory.backend=hindsight` (Hindsight stores memories server-side and has no `memory://` addressing); the handler now returns a corrective pointer to `recall`/`reflect` so a stray read — steered by the shared `recall` tool description — self-corrects in one turn ([#7587](https://github.com/can1357/oh-my-pi/issues/7587)).
- Fixed extension/custom/hook tool wrappers stripping schema methods off `parameters`: `applyToolProxy` bound every callable property, and binding a schema (a plain function carrying `toJsonSchema`/`assert`) dropped those properties, breaking wire-schema detection and crashing the status-line token estimator with `JSON.stringify(schema) === undefined`. Prototype methods are still bound; own data properties and schema callables now pass through untouched.
- Fixed bug where `agent()` calls in eval cells ignored turn cancellation and continued running indefinitely
- Fixed the built-in `tail` printing `tail: Broken pipe` and failing when a downstream pipeline reader exited early (e.g. `tail -c N file.jsonl | jq …` with jq aborting on a parse error); it now exits silently with 141 (128+SIGPIPE) like a real tail, in every output path including `--follow`.
- Fixed the in-process ps shell builtin rejecting common procps/BSD format specifiers (`ps -o tpgid,...` failed with `unknown output format specifier`); added `tpgid`, `pri`, `flags`, real/effective user and group columns, `wchan`, fault counters, `sz`, and the STAT `+` foreground flag.
- Fixed Herdr rejecting the macOS development launcher because its foreground process was reported as `bun` instead of `omp`.
- Completed usage-aware model fallback across startup, queued turns, same-turn tool continuations, ACP/TUI confirmation cancellation, eligible account reselection, cooldown restoration, and isolated subagent settings so low-usage handoffs remain lossless and cannot consume cancelled queued work.
- Fixed Agent Hub opening and selection becoming O(all rows) on large rosters: row rendering is now lazy around the selected viewport, and observer lookup is O(1) by id instead of copy-sorting every session per row.
- Fixed the bash interceptor blocking `grep`/`cat`/`find` used as a downstream pipeline stage (e.g. `printf 'x\n' | grep x`); a stage consuming piped stdin cannot be replaced by a path-based dedicated tool, so it is no longer matched, while standalone and first-stage searches stay intercepted ([#7496](https://github.com/can1357/oh-my-pi/issues/7496)).
- Fixed floating rejections from cmux browser guest JavaScript terminating the main process and every active session; attributable rejections now fail the browser run as tool errors while unrelated process rejections retain the fatal path ([#7365](https://github.com/can1357/oh-my-pi/issues/7365)).
- Fixed the Windows bash tool silently taking down the whole omp process when a command blocked until its timeout: cancelling a timed-out run walked the spawned child's descendant tree from raw `th32ParentProcessID` links, and a recycled pid matching the harness's stale recorded parent pid could enumerate omp as a false descendant and `TerminateProcess` it, killing the session with no `session_exit` record. Run-cancellation sweeps now refuse to signal the harness or any process collected beneath it, while still reaping the timed-out target when it owns a recycled ancestor pid ([#7452](https://github.com/can1357/oh-my-pi/issues/7452)).
- Fixed the unexpected-stop guard (`features.unexpectedStopDetection`) never firing for thinking-only stops: `isUnexpectedStopCandidate` only counted non-whitespace `text` blocks, so a `stopReason: "stop"` turn whose sole content was a signed `thinking` block (a trapped response or a truncated reasoning fragment from reasoning models) bypassed classification and silently ended the turn mid-task. Such stops are now candidates and are classified on their thinking text ([#7499](https://github.com/can1357/oh-my-pi/issues/7499)).
- Fixed Task cancellation hanging forever when a child ignored abort or stalled during cleanup ([#7483](https://github.com/can1357/oh-my-pi/issues/7483)).
- Fixed LSP diagnostics being dropped when servers normalize file URI percent-encoding or Windows path casing.
- Fixed WSL sessions missing Agent Skills stored in the Windows host profile's `.agents/skills` directory. ([#3779](https://github.com/can1357/oh-my-pi/issues/3779))
- Fixed `omp setup python` to validate the same configured or discovered interpreter used by the Python eval runtime.
- Fixed self-update misclassifying glibc Linux hosts with an installed musl loader as musl hosts, which could download an unusable musl binary instead of the glibc release.
- Fixed a crash where opening the Agent Hub after a resume and moving the selection triggered an unbounded `ExtensionExitError` unhandled-rejection storm and exit 129. The postmortem module bound the native hard-exit at first evaluation; when the bundler deferred that evaluation into a `withHostGuard` window it froze the guard's throwing replacement, poisoning every later signal/fatal exit. The native exit is now resolved per call, and the guard stamps its replacement with the native primitive it shadows so mid-guard signals still exit ([#7393](https://github.com/can1357/oh-my-pi/issues/7393)).

## [17.2.8] - 2026-08-04

### Changed

- Upgraded the bundled omptype schema engine: intersection and pipe operators, bigint and RegExp literals in the string DSL, Standard Schema V1 interop, JSON Schema import via fromJsonSchema(), and richer union/collection error reporting.

## [17.2.7] - 2026-08-03

### Changed

- Replaced arktype with @oh-my-pi/omptype for tool parameter and config schemas, significantly improving startup performance with ~100x faster schema construction. Config schema errors are now reported via OmpErrors using the same path/problem structure.

### Fixed

- Fixed an issue where custom, extension, or hook tool wrappers stripped schema methods off parameters, causing wire-schema detection failures and status-line token estimator crashes.
- Fixed a bug where agent() calls in evaluation cells ignored turn cancellation and continued running indefinitely.
- Fixed the built-in tail command to exit silently with code 141 (SIGPIPE) instead of failing with a "Broken pipe" error when a downstream pipeline reader exits early.
- Fixed the in-process ps shell builtin to support common procps/BSD format specifiers, including tpgid, pri, flags, real/effective user/group columns, wchan, fault counters, sz, and the STAT + foreground flag.
- Fixed install.sh falsely reporting success on musl-based systems (such as Alpine Linux) when the binary fails to start; the installer now smoke-tests the binary, exits non-zero on failure, and provides remediation steps.
- Fixed Codex config.toml discovery incorrectly importing MCP servers that are configured with enabled = false.
- Fixed bash.patterns allow rules rejecting valid commands when quoted arguments contained shell metacharacters (such as Cargo benchmark regex filters).

## [17.2.6] - 2026-08-03

### Added

- Added the `/reset` slash command to reset the conversation context in place: it drops the live messages, queued turns, and pending tool calls (and cancels the turn's async jobs, post-prompt continuations, and checkpoint/plan runtime state) while keeping the session id, title, cwd, model, and on-disk transcript. It records a durable reset boundary so the live transcript stays cleared across rebuilds (theme change, focus attach, `/shake`, resume) instead of resurrecting the pre-reset messages, while the full pre-reset history stays on disk ([#3580](https://github.com/can1357/oh-my-pi/issues/3580)).

### Fixed

- Fixed extension slash commands appearing as user prompts after being handled locally.
- Preserved explicit session titles when branching from an earlier conversation turn.
- Fixed an issue where unhandled JavaScript rejections in the browser guest could crash the main process and active sessions, converting them into tool errors instead.
- Fixed a critical issue on Windows where cancelling a timed-out bash tool command could mistakenly terminate the main process due to PID recycling.
- Fixed an issue where supervised processes reaching a terminal state failed to notify their launching session, requiring polling; the broker now actively notifies the session upon process completion.
- Fixed crashes on macOS when using PCRE2-only grep patterns with Bun by defaulting to the interpreted PCRE2 engine instead of JIT, and introduced the `OMP_PCRE2_JIT` environment variable to manually control JIT compilation.
- Fixed issues with `/btw` branch promotion where branches could park behind active turns, cut from outdated session leaves, or leave rejected branch keys indistinguishable from composer input.
- Fixed database bloat by ensuring archived main and nested session rows are properly cleaned up from `stats.db` during garbage collection.
- Fixed startup hanging during local model discovery when a timed-out transport left its request pending, which blocked the CLI before OAuth login could finish ([#7482](https://github.com/can1357/oh-my-pi/issues/7482)).

## [17.2.5] - 2026-08-03

### Breaking Changes

- Replaced the computer tool's coordinate-batch schema with persistent JavaScript runs, and removed computer.backend and model-specific controller switching.
- Changed the edit tool's replace mode from a multi-edit batch schema to a single-edit schema ({ path, old_string, new_string, replace_all? }).

### Added

- Added a relay browser mode to drive local Chrome tabs via the OMP Browser Relay extension, supporting automatic daemon startup and tab grouping.
- Added a scriptable desktop session featuring window-targeted capture and input, native accessibility trees, clipboard access, and streamed screenshots.
- Added broker-shared language servers (controlled by the lsp.shared setting) to multiplex LSP servers across multiple instances in a project, reducing cold-start times and resource usage.
- Added optional timeoutMs to discovery configuration in provider options to configure custom HTTP probe timeouts for llama.cpp, Ollama, and OpenAI-compatible endpoints.
- Added a cross-platform, in-process ps shell builtin with custom columns, sorting, and process metrics.
- Added the --service-tier flag to override the OpenAI service tier for a session.
- Added a configurable per-request web search timeout via providers.webSearchTimeoutSeconds.
- Added turn-aware /tree navigation shortcuts (Alt+Up/Alt+Down, Home/End, PageUp/PageDown) to traverse user and assistant turns.
- Added display.hideToolActivity and a Ctrl+Shift+O shortcut to toggle the visibility of model-initiated tool calls and results.

### Changed

- Exposed the script-driven computer schema to all models, including those with provider-native Computer Use support.
- Reduced omp --help cold-start latency and memory usage by rendering lightweight command metadata.

### Fixed

- Fixed durability of session transcripts to prevent data loss on process crashes.
- Fixed a bug on Windows where a timed-out bash command could terminate the main omp process.
- Fixed headless runs hanging or leaving background workers alive after completion.
- Fixed a crash when opening the Agent Hub after resuming a session.
- Fixed /mcp reauth environment variable expansion and token validation.
- Fixed fuzzy replace-all edits re-matching replacement text indefinitely, which could freeze the TUI.
- Fixed inspect_image ignoring configured thinking effort for vision models.
- Fixed compiled binaries dropping certain extensions with complex CommonJS/ESM dependency graphs.
- Fixed template argument substitution executing recursive placeholder expansion when positional arguments contain literal $@ or $ARGUMENTS tokens.
- Fixed project-scoped session directories using leading-hyphen names and collapsing distinct paths.
- Fixed manual /shake leaving the context budget anchored to stale pre-shake token counts.
- Fixed Mnemopi scoped recall reporting "No relevant memories found" when individual targets fail internally.
- Fixed skill:// resolution ignoring custom directories when a same-named skill exists in a default path.
- Fixed image paste failing on Wayland-only Linux sessions.
- Fixed prewalk switching to the fast model during read-only investigations.
- Fixed self-update misclassifying glibc Linux hosts with an installed musl loader as musl hosts.
- Fixed omp setup python to validate the correct interpreter used by the Python eval runtime.
- Fixed the terminal-tab title dropping to idle while an unsuppressed async job was still running.
- Fixed redirected stdin being ignored when Bun reports a pipe with an undefined isTTY.
- Fixed a literal API key configured via /login being hijacked on Windows by case-differing system environment variables.
- Fixed Esc during a streaming /loop iteration pausing the loop instead of aborting the current turn.
- Fixed heavily branched conversation trees shifting linear continuations into disconnected columns.
- Fixed plugin installation validation failures for legacy compatibility shims.
- Removed hard-coded references to disabled or absent agents in system and tool prompts.

## [17.2.4] - 2026-08-01

### Added

- Added `requestIdFormat` (`"string"` | `"number"`, default `"number"`) to MCP server config, honored by the stdio, HTTP, and SSE transports. JSON-RPC 2.0 permits both id shapes, but Apple's `xcrun mcpbridge` decodes `id` as an integer only and silently drops string ids (`mcpbridge.DecodeError Code=1`), hanging every request until it times out. The option is OMP-specific, so set it in an OMP-owned config (`.omp/mcp.json`, `~/.omp/agent/mcp.json`, a project `mcp.json`/`.mcp.json`, or an OMP plugin); servers imported from another tool's config ignore it ([#7053](https://github.com/can1357/oh-my-pi/issues/7053)).
- Fixed Anthropic web search sending unsupported temperature parameters to sampling-restricted Claude models ([#7195](https://github.com/can1357/oh-my-pi/pull/7195) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed mid-turn steering/peer-interrupt tool skips rendering as errors (red ✘, red border/text) in the TUI; pending and in-flight interrupt placeholders now render as neutral info cards while preserving whether `tool.execute` started ([#7199](https://github.com/can1357/oh-my-pi/issues/7199)).
- Added `Shift+Up` as a second default for the message dequeue, so the shortcut is reachable in macOS Terminal.app where Option is consumed for character composition.
- Added in-process `pgrep`, `pkill`, `pidwait`, and `top` shell builtins with cross-platform process discovery, BSD/procps-style filters, pidfile handling, signal selection, waiting, and snapshots.

### Changed

- Headless hosts (print/RPC/ACP/eval/SDK) now use a 1s SQLite `busy_timeout` for the session-critical databases (agent.db, history.db, stats.db), so lock contention no longer freezes the protocol loop for the full interactive 5s timeout; interactive hosts keep the 5s timeout. The interactive-host flag is now declared before settings load so the first database opens see the correct timeout.
- The model picker (`/switch`, alt+p) no longer blocks models whose context window is smaller than the live session: over-context rows stay grayed but selectable, and picking one compacts with the current model first, then switches. A cancelled or failed compaction keeps the current model.
- MCP JSON-RPC request ids now default to per-connection sequential integers instead of snowflake strings, matching the wider MCP ecosystem and making integer-only decoders like Apple's `xcrun mcpbridge` work without configuration; set `requestIdFormat: "string"` per server to restore collision-resistant string ids ([#7053](https://github.com/can1357/oh-my-pi/issues/7053)).
- `secret-placeholder.key` now resolves under XDG state (`$XDG_STATE_HOME/omp/secret-placeholder.key`) instead of the agent config directory, so it follows the same XDG layout as other state files.
- Daemon runtime directories (`run/daemons/<hash>`) and provider in-flight tracking (`run/provider-inflight`) now resolve under XDG state (`$XDG_STATE_HOME/omp/run/`) instead of the config root, keeping ephemeral runtime state out of `~/.config`.
- `marketplaces.json` now resolves under XDG data (`$XDG_DATA_HOME/omp/marketplaces.json`) instead of the config root, aligning with the XDG data category for user-scoped registry files.
- Existing XDG installs keep their placeholder key and marketplace registry: the legacy `~/.omp/agent/secret-placeholder.key` and `~/.omp/marketplaces.json` are copied to their XDG locations on first resolution.

### Fixed

- Fixed sessions without a granted `write` tool hiding discoverable and MCP tools behind the unusable `xd://` transport; those sessions now disable device mounting and expose the tools directly without gaining write access.
- Fixed collab guest prompts being sent to models as unframed developer context, so guest messages now retain their transcript attribution while reaching the model as prioritized user interjections ([#7288](https://github.com/can1357/oh-my-pi/issues/7288)).
- Fixed `/memory stats` and `/memory diagnose` showing "Memory stats is not available for the off backend" when memory is off, in both the TUI and ACP/RPC slash-command handlers; the off backend now says memory is off directly instead of naming itself as an unsupported backend ([#7251](https://github.com/can1357/oh-my-pi/pull/7251) by [@KennethHoff](https://github.com/KennethHoff)).
- Fixed `/reload-plugins` retaining stale context-file contents and activation state in the current system prompt ([#7258](https://github.com/can1357/oh-my-pi/issues/7258)).
- Fixed compiled binaries failing to import nested wildcard export subpaths such as `@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account`. Node matches `*` in an `exports` pattern across `/`, but the bundled registry enumerated only the top level and skipped any key containing a slash, so such an import resolved from source and died under bunfs — reproducible on the published 17.2.1 binary.
- Fixed concurrent session appends during `/move` recreating an orphaned `.jsonl` fragment in the old session directory ([#7270](https://github.com/can1357/oh-my-pi/issues/7270)).
- Fixed interactive launches hanging silently when a host project or its `.env` sets `NODE_ENV=test` or `BUN_ENV=test` ([#7261](https://github.com/can1357/oh-my-pi/issues/7261)).
- Fixed a subagent killed from the Agent Hub (`x`) reappearing as a `parked` row after closing and reopening the hub in a local session; the kill now leaves the ref registered as terminal `aborted` instead of unregistering it, so the persisted-subagent rescan no longer re-adopts the surviving transcript ([#7250](https://github.com/can1357/oh-my-pi/issues/7250)).
- Fixed manual and automatic Codex compaction dropping the configured OpenAI WebSocket preference ([#7198](https://github.com/can1357/oh-my-pi/issues/7198)).
- Fixed two remaining tool-card double renders: a superseded assistant turn no longer leaves its never-run cards above the re-run's fresh cards (a TTSR rewind retracts them immediately; an auto-retry removes the synthetic-settled failure cards when it supersedes the turn — while a genuinely terminal failure keeps its card visible), and a successful read whose persisted result wins a transcript-rebuild race no longer creates a fallback read group when its delayed live completion arrives ([#6879](https://github.com/can1357/oh-my-pi/issues/6879)).
- Fixed a tool card rendering twice when the provider rewrites a streamed tool call's id mid-stream — GitHub Copilot's `call_id|id` transport, or any stream that delivers the tool name/arguments before the id — so the block appears first with an empty or partial id and is populated in a later delta. The transcript keyed the live card by that mutable id, so the changed id spawned a second card: the old-id card orphaned as a blue pending preview while the new-id card took the result. Streamed tool cards are now re-keyed in place when their id changes, using the block's position in the streaming message as a stable identity ([#6879](https://github.com/can1357/oh-my-pi/issues/6879)).
- Withheld advisor nits and concerns while the primary turn is explicitly marked in progress, while still allowing blockers for unrecoverable active side effects.
- Preserved explicit `-e`/`--extension` and `--hook` packages under
  `--no-extensions` while excluding ambient extension factories and sibling
  capabilities from settings or installed OMP packages.
- Fixed explicit `thinking` metadata in `models.yml` custom definitions and `modelOverrides` being replaced by canonical catalog policy during model rebuilding. ([#7307](https://github.com/can1357/oh-my-pi/issues/7307))
- Fixed the auto-titler installing a model's whole answer as the session title when the tiny title model ignored the titling task and answered the first user message instead. `normalizeGeneratedTitle` now rejects overlong output (>80 chars or >12 words) so the caller defers titling to the next user turn rather than accepting a full sentence ([#7303](https://github.com/can1357/oh-my-pi/issues/7303)).
- Fixed the in-process `kill` builtin to validate signals, preserve negative PID operands, signal every process in pipeline jobs, continue after bad targets, and refuse non-probe signals aimed at the host process or process group.

## [17.2.3] - 2026-08-01

### Changed

- Tightened the system prompt notation: the legend now defines `⟺`, `≠`, `∉`/`∌`, and operator binding order; replaced undefined symbols (`⊭`, `≢`) in prompt bodies; removed delegation guidance duplicated between the eager-tasks preamble and the delegation gates.

### Fixed

- Fixed headless browser launch storms and orphaned Chromium process trees: omp processes now attach to one project-shared Chromium owned by the daemon broker (tabs per session; Chrome dies with the last omp client in the project), concurrent browser opens in one process share a single launch, and concurrent daemon `start` requests for one name can no longer spawn duplicate untracked processes.
- Fixed Bash auto-background leaving a live `Bun.sleep` threshold timer scheduled after a command completes (or abort/steering wins) first, which could keep the event loop alive and delay SDK/headless shutdown until the threshold expired ([#7235](https://github.com/can1357/oh-my-pi/issues/7235)).
- Fixed ephemeral side turns and native compaction bypassing an explicit or fork-inherited prompt cache key ([#7218](https://github.com/can1357/oh-my-pi/issues/7218)).
- Fixed the live Ask dialog crashing the whole session with a `replaceTabs` TypeError when a question reached `AskDialogComponent` without a string `question` field; questions are now normalized at dialog entry, mirroring the transcript renderer ([#7211](https://github.com/can1357/oh-my-pi/issues/7211)).
- Fixed Codex web search collapsing backend errors to `Codex error (): Unknown error`; the SSE error parser now preserves the backend code and message from top-level, nested `error`, and `response.error` envelopes ([#7200](https://github.com/can1357/oh-my-pi/issues/7200)).

## [17.2.2] - 2026-07-31

### Added

- Added an app.live.toggle keybinding (default Ctrl+L) to start or stop live voice mode.
- Added ctx.invokeTool(params, options?) to extension contexts, allowing wrappers to run native tools while inheriting context, abort signals, and progress updates.

### Changed

- Moved the display-reset default keybinding (app.display.reset) from Ctrl+L to Alt+L to accommodate the new live-mode toggle.
- Updated the hashline edit tool, streaming preview, and plan-mode guidance to support the unified PUT/CUT grammar, .= ranges, and named registers.
- Improved startup performance by moving subagent model-registry refresh and session-file opening off the launch critical path.
- Optimized session file writing performance by batching same-turn file-session appends.
- Rewrote the Codex saved-reset auto-redeem algorithm to be pool-wide, window-exact, and expiry-aware, ensuring banked resets are automatically and reliably redeemed across multi-account setups before they expire.

### Fixed

- Fixed a crash in Kitty terminals when rendering non-PNG tool-result images if PNG conversion fails.
- Fixed subagent evaluation resets (reset: true) wiping the shared kernel inherited from the parent session; resets from non-exclusive owners now fork into a private per-owner kernel.
- Fixed the copy selector and ask dialog rendering raw key IDs instead of human-readable keybinding labels.
- Fixed CLI positional initial messages bypassing automatic session-title generation.
- Fixed the environment-variable reference omitting Kitty Unicode placeholder controls and tmux placement caveats.
- Fixed extension validation failures during omp plugin install for extensions importing compact from @earendil-works/pi-coding-agent by adding the missing re-export.
- Fixed Bash interceptor rules to inspect unquoted/unescaped compound command fragments (e.g., &&, ||, ;, |, &, and newlines) instead of only matching the complete command input.
- Fixed ExtensionContext.cwd staying pinned to the initial session directory; it now dynamically tracks the active session's current working directory.
- Fixed the web-search provider picker description for xAI/Grok to clarify that it supports SuperGrok/X Premium+ OAuth sign-ins.
- Fixed /reload-plugins failing to reconnect MCP servers or refresh MCP tool and prompt-command registries.
- Enforced the centralized artifact spill threshold on oversized read results, persisting them as recoverable session artifacts.
- Fixed DuckDuckGo web search under-returning results above the first-page limit by automatically submitting continuation forms.
- Fixed DuckDuckGo web search ignoring after: and before: date bounds by correctly parsing and filtering result timestamps.
- Fixed env-driven OTLP trace export ignoring OTEL_RESOURCE_ATTRIBUTES.
- Fixed a fresh session with deferred MCP discovery injecting the newly mounted xd:// tool catalog twice into the first model request.
- Fixed the bash tool failing with EACCES permission errors on multi-user machines by scoping the snapshot directory per user ID.
- Fixed LSP write batching replaying stale whole-file snapshots over newer external changes made before the batch flushed.
- Fixed ctx.ui.editor() in ACP mode always resolving to undefined by routing it through the elicitation bridge.
- Fixed omp commit failing to resolve extension-provided models in both agentic and legacy pipelines.
- Fixed RPC hosts receiving no subagent lifecycle or progress frames when an IRC message revives an idle or parked keep-alive subagent.
- Fixed copied fenced-code body rows in assistant messages retaining component and container margins.
- Fixed mid-turn auto-compaction repeating dead-end rescue work and warnings at every tool boundary within a single oversized turn.
- Fixed automatic terminal appearance changes clearing native scrollback and snapping readers away from their current scroll position.
- Fixed exact-match edits failing on files containing credential-shaped tokens when secrets.enabled is active by using reversible placeholders instead of irreversible redactions.
- Fixed context usage collapsing to the latest response size for Cursor models that omit prompt-token usage.
- Fixed the browser tool crashing with EBUSY errors on Windows when a headless Chromium profile is locked during cleanup.
- Fixed the Python RPC client dropping context, compaction, OAuth URL, and terminal-settlement fields.
- Fixed the browser tool ignoring the url parameter when opening a new tab on an attached browser.
- Fixed browser automation disrupting attached browsers by adopting the active foreground tab and avoiding raising new tabs during screenshots.

## [17.2.1] - 2026-07-30

### Added

- Added `--from-claude` and `--from-codex` session imports, also available from `/resume @claude` and `/resume @codex`.
- Added an opt-in OMP-native software-security workflow (`security.enabled`, default off) with immutable scan plans, exact-account Codex subscription affinity, native task-worker review, canonical findings/coverage/SARIF publication, project-scoped history, explicit dispositions, producer-differential comparison, and the read-only `security://` resource namespace. Generic SARIF and official Codex Security bundles normalize into the same OMP-owned store.
- Added explicit Codex Security cloud operations to the opt-in security workflow: list and start account-pinned cloud scans, inspect their progress, and import current findings into OMP's canonical store and `security://` namespace without changing the native scan engine or spoofing official runtime attribution.

### Changed

- Reserved `security://` from RPC host URI shadowing so vendor adapters cannot replace OMP's canonical security-analysis namespace.

### Fixed

- Fixed remote or LAN local-engine endpoints being ignored during model discovery: the llama.cpp and Ollama probes used timeouts tuned for loopback, so a host reached over the network could exceed them and return no models, while changing `OLLAMA_BASE_URL`/`OLLAMA_HOST` could keep reusing a fresh cache from the previous endpoint. Non-loopback hosts now get a generous discovery timeout, and Ollama cache rows are scoped to the normalized endpoint ([#7087](https://github.com/can1357/oh-my-pi/issues/7087)).
- Fixed `omp install` failing extension validation for pi extensions that import `createEditTool` or `createWriteTool` (e.g. gentle-pi) — the legacy `@oh-my-pi/pi-coding-agent` shim exported the read/bash/grep/find/ls tool factories but omitted the edit and write ones, so a named import threw Bun's static "Export named X not found" error. Added `createEditTool`/`createEditToolDefinition` and `createWriteTool`/`createWriteToolDefinition` to match the upstream pi surface ([#7094](https://github.com/can1357/oh-my-pi/issues/7094)).
- Fixed Python eval's loopback tool bridge being routed through macOS system HTTP proxies, which caused `parallel()` tool reads to fail with `ConnectionRefusedError` after a local proxy stopped.

Older entries are archived in [packages\coding-agent\CHANGELOG.md@66783f3c68ba](https://github.com/can1357/oh-my-pi/blob/66783f3c68ba682828e684c33070fa2c905a55a4/packages\coding-agent\CHANGELOG.md).
Older entries are archived in [packages/coding-agent/CHANGELOG.md@48b07e000c63](https://github.com/can1357/oh-my-pi/blob/48b07e000c630f9f071eec6ad4d5580a898bb8dd/packages/coding-agent/CHANGELOG.md).
Older entries are archived in [packages/coding-agent/CHANGELOG.md@4c6407864c6e](https://github.com/can1357/oh-my-pi/blob/4c6407864c6e2b66d3d1e7852beab736058abb0f/packages/coding-agent/CHANGELOG.md).
Older entries are archived in [packages/coding-agent/CHANGELOG.md@da359efe2858](https://github.com/can1357/oh-my-pi/blob/da359efe2858f68baa4ae290574c7c4c9c8da3c3/packages/coding-agent/CHANGELOG.md).
Older entries are archived in [packages/coding-agent/CHANGELOG.md@4a170f8873d5](https://github.com/can1357/oh-my-pi/blob/4a170f8873d5280780c4057e6b2a5a45cfcf6f39/packages/coding-agent/CHANGELOG.md).
Older entries are archived in [packages/coding-agent/CHANGELOG.md@d94ea97cb492](https://github.com/can1357/oh-my-pi/blob/d94ea97cb492de52e2a49a0401eb48a6beaa60f2/packages/coding-agent/CHANGELOG.md).
Older entries are archived in [packages/coding-agent/CHANGELOG.md@3cc89b92a410](https://github.com/can1357/oh-my-pi/blob/3cc89b92a4109d55e9c4a1f2a741041e05efa578/packages/coding-agent/CHANGELOG.md).
