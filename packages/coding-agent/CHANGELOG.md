# Changelog

## [Unreleased]

### Added

- Added optional `hindsight.scopeTags` so deterministic memory scope tags resolve retain, recall/reflect, and exact `observation_scopes` together; tagged mental models now require a full tag subset to become visible.
- Added optional `hindsight.retainStrategy` (and `HINDSIGHT_RETAIN_STRATEGY`) to select a named Hindsight extraction strategy on retain; unset omits the field so the bank default applies.
- Added `hindsight.retainUpdateMode` (`replace` | `append`, default `replace`) so full-session retain can append only newly accumulated turns to the same session document.

### Changed

- Hindsight now retains any remaining below-cadence session tail on clean close (`AgentSession.dispose` / session-memory teardown), independent of `retainUpdateMode`.
- Hindsight now retains a below-cadence tail when leaving a conversation through `/new`, `/clear`, `/resume`, `/tree`, fork, or branch, and when bank routing rebuilds mid-session.

### Fixed

- Fixed Hindsight subagent retains using a stale extraction strategy after a live bank-scope rebuild.
- Hindsight leave-path retain now waits for delayed backend startup before treating a missing live state as having nothing pending.
- Fixed Hindsight subagent memories queued during a live bank change from being written to the new bank.
- Fixed Hindsight subagent reflect calls in flight during a live bank change from being sent to the new bank.
- Fixed Hindsight delayed startup skipping a below-cadence post-switch turn after `/new`, `/clear`, `/resume`, or `/tree`.
- Hindsight no longer duplicates a retained tail after `/fresh` or a same-file reload.
- Hindsight close retain now waits through the configured retain timeout during dispose instead of the 5s event-drain deadline.
- Hindsight close retain now gets a full retain-timeout budget after any in-flight cadence retain settles, instead of sharing one deadline with queued work.
- Hindsight close drain now budgets bank creation plus retain so a first-use `createBank` cannot starve the close retain.
- Hindsight close drain now budgets a tool-retain batch plus the session retain so a slow `retainBatch` cannot starve the close tail.
- Hindsight delayed startup now keeps a `/tree` ask re-answer as a pending tail instead of treating the later assistant reply as loaded history.
- Hindsight `/clear` now retains post-reset turns under a new document instead of replacing the drained conversation.
- Hindsight delayed startup now derives loaded history when enabling mid-session instead of treating an off-backend zero as already retained activity.
- Hindsight delayed startup now restores the loaded-message baseline when a `/resume` rolls back, so idle close does not re-retain the original transcript.
- Hindsight `/clear` now reconstructs the post-reset document identity from the persisted reset boundary, and branch/fork after `/clear` no longer retain into the source document.
- Hindsight delayed startup now drops construction baselines when the backend is torn down, so re-enabling does not duplicate already drained history.
- Hindsight now resets retain cadence after `branch` and `/btw` so a shorter branch cannot inherit the source session's last retained turn.
- Hindsight `/tree` now resyncs the post-clear document overlay so a pre-reset leaf cannot overwrite the drained post-clear document.
- Hindsight now resets retain cadence when `/tree` changes the post-clear document overlay, so a shorter pre-reset branch cannot inherit the source last retained turn.
- Fixed Hindsight live retainStrategy refresh from adopting unrelated endpoint, token, or timeout settings that never rebuilt the client.

- Fixed `/settings` leaving the project-effective appearance after adopting a theme or status-line edit while previewing another scope.
- Fixed `/settings` keeping the previous scope's theme after Alt+S onto an unloadable Dark/Light mapping.
- Fixed `/settings` leaving a hovered theme after canceling an unloadable Dark/Light Theme submenu.
- Fixed `/settings` previewing project glyphs and color-blind colors while browsing a different scope.
- Fixed `/settings` dropping custom status-line segment options when closing the overlay.
- Fixed `/settings` leaving a stale live theme or status preview after adopting a search-mode appearance submenu edit.
- Fixed project saves leaving live browser and computer tools on the rejected local value after adopting a newer disk edit.
- Fixed project-cleared provider request limits leaking `null` tombstones through `Settings.get()` and `omp config get --json`.
- Fixed project saves leaving the live advisor status-line indicator stale after adopting an `advisor.enabled` disk edit.
- Fixed conversation-flow setting signals reapplying queue modes onto unrelated Settings clones.
- Fixed `SettingsManager.create()` missing a loaded instance when `cwd` or `agentDir` is relative.
- Fixed persisted queue-mode changes restoring unrelated live-only conversation modes.
- Fixed shadowed global queue-mode writes resetting the live session back to the project override.
- Fixed `/settings` leaving a scoped theme preview after close when the effective theme name cannot load.
- Fixed `/settings` trapping Tab and Alt+S after an adopted disk edit hid an open text editor.
- Fixed project saves leaving already-rendered OSC 8 links on a rejected `tui.hyperlinks` value.
- Fixed `/settings` discarding an in-progress global editor after adopting a project disk edit.
- Fixed `/settings` discarding in-progress editors after adopting an unrelated disk edit.
- Fixed `/settings` keeping a stale multi-select submenu after adopting a newer disk edit.
- Fixed `/settings` resetting an open multi-select cursor after an ordinary project save.
- Fixed project inherit treating the native `.omp/config.yml` as a non-native source when cwd is relative.
- Fixed `/settings` silently writing project-shadowed edits to the global profile by adding explicit project/global scopes and project override inheritance. ([#8208](https://github.com/can1357/oh-my-pi/issues/8208))
- Fixed `/settings` project-scope record edits copying inherited keys, inheriting only a subset of migrated aliases, skipping the initial appearance preview, and re-persisting queue-mode choices globally.
- Fixed `/settings` rendering unsanitized repository names in the project-scope title.
- Fixed `/settings` leaving a scoped status-line preview after close, and project saves overwriting newer same-key disk edits without firing adopted-change hooks.
- Fixed project saves keeping a rejected local model-role override or blaming `.omp/config.yml` after adopting a newer on-disk role or inherited `shellPath`.
- Fixed project inherit leaving a legacy flat `theme` override, and project saves treating an alias-backed clear as unconflicted when a newer legacy alias landed on disk.
- Fixed project inherit leaving a quoted-dotted `features.unexpectedStopDetection` alias, and skipped project queue-mode saves leaving the live session on the rejected local value.
- Fixed skipped project thinking and memory saves leaving the live session on the rejected local value.
- Fixed project inherit leaving mnemosyne, hindsight, and Exa aliases, and skipped autocompleteMaxVisible saves leaving the editor on the rejected local value.
- Fixed project saves discarding a second same-key edit when a sibling disk edit landed during debounce.
- Fixed overlapping project saves leaving live session state on an adopted disk value after a later same-key edit persisted.
- Fixed project saves leaving live git-status TUI state on the rejected local value after adopting a newer disk edit.
- Fixed overlapping project saves dropping a later edit after the in-flight save rejected.
- Fixed `/settings` copying an unchanged inherited credential into `.omp/config.yml`.
- Fixed `/settings` scoped status-line previews omitting segment options from the selected layer.
- Fixed project saves leaving live session/editor state, original runtime model roles, or a stale project-config flag after adopting a sibling disk edit, role clear, or deleted `.omp/config.yml`.
- Fixed project saves resetting a temporary `/thinking` level when adopting an unrelated session-runtime sibling edit.
- Fixed project edits to a renamed native object dropping sibling legacy fields.
- Fixed project inherit of one renamed native field dropping sibling legacy fields.
- Fixed adopted project settings reapplying live session state across Settings clones, and `/settings` keeping stale row snapshots after a skipped project save.
- Fixed project saves leaving live sampling parameters on the rejected local value after adopting a newer disk edit.
- Fixed project saves leaving live omit-thinking and auto-compact session state on the rejected local value after adopting a newer disk edit.
- Fixed project saves leaving the live auto-compact status indicator stale after adopting a `compaction.methodOrder` disk edit.
- Fixed project saves leaving live web-search eligibility, tool-activity visibility, remaining display toggles, MCP notification subscriptions, composer shape, spelling, and TUI tightness/scrollback/mermaid state on the rejected local value after adopting a newer disk edit.
- Fixed `/settings` shadowed global theme submenu commits snapping the live theme back to the project-effective mapping.
- Fixed project saves leaving live status-line cached settings on the rejected local value after adopting a newer disk edit.
- Fixed `/settings` shadowed global edits reapplying live session state when the effective value did not change.
- Fixed project inherit of `task.isolation.enabled` leaving a leftover `task.isolation.mode` alias after the isolation split.
- Added `--agent <name>` to start a root session from a discovered agent definition (user `~/.omp/agent/agents`, project `.omp/agents`, extension, or bundled). The agent's tools, thinking level, model, body, and autoload skills apply unless `--tools` / `--thinking` / `--model` / `--system-prompt` override them. Unknown names fail with a usage error listing available agents.
- Added `--agent-cwd <path>` to resolve a named root agent from a role-definition project while keeping `--cwd` as the execution directory, and added `hide: true` agent frontmatter so explicitly named automation roles remain root-launchable without appearing in ambient task or `/agents` rosters.
- Resume and fork now restore a session's original `--agent` identity from the session header. A conflicting `--agent` is refused, and a persisted privileged role that is missing from discovery fails closed.
- Root `--agent` sessions now evaluate `agents` frontmatter rule scoping against the launched definition name, including restore from the session header.


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
- Added opt-in interactive collab auto-hosting with configurable relay safety and write-link file output. Project `.omp/config.yml` may enable hosting for that cwd.


- Delayed collab auto-hosting until interactive startup reconciliation, setup, and the initial transcript are ready.
- Made `/collab stop` cancel an in-flight host handshake instead of reporting that hosting has not started.
- Stopped collab auto-hosting on interactive shutdown, including in-flight host handshakes.
- Treated a collab host that dropped during write-link publication as a failed start instead of reporting a live session.
- Sanitized collab auto-start and write-link errors so they no longer leak home paths or inject raw layout characters into the transcript.
- Avoided deleting a collab write-link file that this start never published, including a destination replaced after publication.
- Stopped an already-attached collab host immediately on `/collab stop` and shutdown instead of waiting out write-link publication.
- Stopped collab hosting on signal teardown before waiting for draft persistence.
- Rejected collab auto-start and write-link paths from config overlays, including dotenv-injected `PI_CONFIG_FILES`.
- Ignored overlay-sourced collab relay and web URLs during auto-start so a config overlay cannot retarget a trusted host.
- Rejected collab auto-start from a global config.yml whose agent or config directory was redirected by a project dotenv.
- Honored project and overlay `collab.autoStart: false` over a trusted global enablement.
- Honored a project `collab.autoStart: false` even when a higher overlay tried to re-enable hosting.
- Honored a lower-precedence overlay `collab.autoStart: false` even when a later overlay tried to re-enable hosting.
- Refused to attach a collab host that closed fatally before start completed.
- Made `/collab stop` abort a contended write-link lock wait instead of blocking through lock retries.
- Distrusted collab auto-start when a project dotenv overwrites an empty launcher `PI_CODING_AGENT_DIR` or `PI_CONFIG_DIR`.
- Shortened collab and MCP status home paths even when the home directory contains spaces.
- Detected Bun pre-dotenv `NODE_ENV` when judging project dotenv ownership of collab auto-start directories.
- Rejected collab auto-start from a profile selected by a project dotenv `OMP_PROFILE` or `PI_PROFILE`.
- Trusted collab auto-start from a parent `OMP_PROFILE` even when project dotenv set the ignored `PI_PROFILE` fallback.
- Rejected collab auto-start when a project dotenv `PI_PROFILE` was mirrored into `OMP_PROFILE` by profile activation.
- Stopped collab hosting on interactive shutdown before awaiting live-mode teardown.
- Rejected collab auto-start from a project dotenv key that only matches `PI_CODING_AGENT_DIR` or `PI_CONFIG_DIR` by Windows case-fold.
- Closed the collab relay socket when host start is cancelled after the handshake opens.
- Distrusted collab auto-start when a project dotenv uses Bun-decoded escaped newlines in `PI_CODING_AGENT_DIR`.
- Distrusted collab auto-start when a project dotenv uses Bun `${NAME:-default}` expansion or quoted multiline values in `PI_CODING_AGENT_DIR`.
- Distrusted collab auto-start when a project dotenv quoted multiline `PI_CODING_AGENT_DIR` keeps trailing whitespace on the first line.
- Trusted collab auto-start from a profile selected by `--profile`, including `--profile default`, even when a project dotenv also declared `OMP_PROFILE` or `PI_PROFILE`.
- Distrusted collab auto-start when a project dotenv closes a quoted agent or config directory after an even-length backslash run.
- Trusted collab auto-start from an argv-selected named profile even when a project dotenv declared `PI_CODING_AGENT_DIR`.
- Trusted collab auto-start from a parent-env named profile even when a project dotenv declared `PI_CODING_AGENT_DIR`.
- Honored a lower project `collab.autoStart: false` even when a later project file tried to re-enable hosting.
- Distrusted collab auto-start when a project dotenv reassigns an agent or config directory with a later differently-cased key.
- Distrusted collab auto-start when a project dotenv uses an unspaced `#` comment after an unquoted agent directory.

## [18.1.16] - 2026-09-09

### Added

- `/rename` without a title now generates a session name from recent conversation using the configured tiny model.
- Added opt-in experimental notes-backed context windows with persistent branch-local notes, searchable original session history, retained latest user requests, and a model-callable rollover tool, including in Code Mode.
- `/loop` accepts `--until '<cmd>'` / `--while '<cmd>'` to gate each iteration on a shell command's exit status, so a loop can stop on real project state instead of only a count or duration. ([#10858](https://github.com/can1357/oh-my-pi/pull/10858) by [@andyhite](https://github.com/andyhite))

### Fixed

- Read error and preview rendering now sanitizes tabs and Windows-style CRLF (e.g. ssh host-key failures, tab-indented fetched content) so raw output can no longer tear the result frame.
- Unset `tiny` model roles now honor the configured `@smol` fallback in direct execution and the `/models` Roles view ([#11311](https://github.com/can1357/oh-my-pi/issues/11311)).
- Extension Control Center (`/extensions`) search now accepts `j` and `k`, so extensions like `jira`/`json` are searchable; bare `j`/`k` no longer move the list selection (use arrow keys or the configured `tui.select.up`/`down`) ([#11350](https://github.com/can1357/oh-my-pi/issues/11350)).
- Codex turns interrupted before terminal completion now auto-continue after resolved tool calls instead of stopping ([#11349](https://github.com/can1357/oh-my-pi/issues/11349)).
- Fixed the status line's `pi` brand/working segment double-padding the first separator, so every gap around a separator is a single space ([#11103](https://github.com/can1357/oh-my-pi/issues/11103)).
- `/handoff` no longer leaves the TUI in a running state when completion races with delayed session events ([#11263](https://github.com/can1357/oh-my-pi/issues/11263)).
- Fixed legacy Pi extensions failing to load when calling `ctx.isProjectTrusted()` in an event handler; the extension context now exposes it (always `true`, since OMP applies no project-trust gating) ([#7955](https://github.com/can1357/oh-my-pi/issues/7955)).
- Fixed Ctrl+Z jobs exiting successfully after `fg` instead of restarting the TUI because terminal teardown left Bun without a referenced event-loop handle while waiting for `SIGCONT` ([#8585](https://github.com/can1357/oh-my-pi/issues/8585)).
- Extensions loaded by the npm CLI now apply settings overrides to the active session, so generated agents and model choices remain isolated between sessions ([#11047](https://github.com/can1357/oh-my-pi/pull/11047) by [@mgpai22](https://github.com/mgpai22)).
- Live task dispatch now reloads added, changed, removed, and deleted project task and retry settings before resolving subagents ([#11191](https://github.com/can1357/oh-my-pi/issues/11191)).
- Reset `/loop` iterations combined with `--while` / `--until` no longer keep submitting without resetting when vibe mode is enabled while the condition command is still running; the loop now disables itself instead ([#10858](https://github.com/can1357/oh-my-pi/pull/10858)).

## [18.1.15] - 2026-09-08

### Added

- Added the `retry.waitForUsageReset` setting: when a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), the session sleeps until the reset instead of failing fast past `retry.maxDelayMs`.
- Added `advisor.maxNotesPerUpdate` setting and `WATCHDOG.yml` configuration (default `4`): allows reasoning verifiers to batch findings in a single review update without being rate-limited.
- Headless browser tabs now freeze when a turn settles so idle animated/WebGL pages stop burning CPU/GPU, resuming automatically on next use; tabs idle past `browser.idleCloseSec` (default 30 minutes) are closed. `persist: true` on `browser.open` opts a tab out of both ([#8246](https://github.com/can1357/oh-my-pi/issues/8246) by [@H4vC](https://github.com/H4vC)).

### Changed

- When enabled (`task.showResolvedModelBadge`), subagent model badges show the thinking-level icon, model name, and attached-advisor eye before the agent name in task, eval, job, and HUD rows.

### Fixed

- Task descriptions containing tabs no longer misalign or overflow task rows; tabs are expanded before measuring and rendering.
- GitHub Copilot model-policy 403s (plan, model policy, org restriction) no longer delete stored credentials, so the provider stays listed in `/model` after a per-model access denial instead of disappearing until the next `/login` ([#11280](https://github.com/can1357/oh-my-pi/pull/11280) by [@H4vC](https://github.com/H4vC)).
- Bash results no longer replace a failing command's output with the shell minimizer's lossy summary when the original capture cannot be persisted as an artifact; the raw diagnostics are kept so a failure stays actionable ([#11081](https://github.com/can1357/oh-my-pi/issues/11081)).
- Fixed worker subprocesses failing to declare themselves as worker hosts before dispatching selectors, which prevented nested thread worker spawns during `/usage` stats sync on multi-core systems.
- Fixed `/usage` displaying a misleading generic database read failure when activity loading fails; the error detail is now sanitized, collapsed to a single line with shortened paths, and surfaced in the dashboard.
- Advisor notes now report rate limiting accurately, blockers always interrupt even after a lower-severity note in the same update, and deferred notes flush when the primary run completes, including after advisor quota exhaustion ([#11062](https://github.com/can1357/oh-my-pi/issues/11062)).
- Fixed the built-in clangd registration omitting CUDA source and header files (`.cu` and `.cuh`) ([#10782](https://github.com/can1357/oh-my-pi/pull/10782) by [@alphastorm](https://github.com/alphastorm)).
- Fixed `ast_grep` skipping CUDA headers and ignoring an explicit `lang` override for ambiguous file extensions ([#10782](https://github.com/can1357/oh-my-pi/pull/10782) by [@alphastorm](https://github.com/alphastorm)).
- Python cells are no longer replayed automatically after a kernel crash, preventing duplicate side effects; the next call starts a fresh kernel.
- Session rewrites preserve open-reader snapshots and replacement identity when a rename needs an EPERM fallback.
- Fixed WorkPool children retaining a stale Gemini-formatted `yield` declaration when pooled items were installed or cleared.

## [18.1.14] - 2026-09-07

### Fixed

- `omp update` now refuses to overwrite shebang scripts or non-OMP executables behind foreign symlinks and reports the physical binary path it verified ([#11152](https://github.com/can1357/oh-my-pi/issues/11152)).
- The startup update notice counts every change in a release: bullets written above a `###` heading now count under `Other`, and `+`/`*` markers and lightly indented bullets count like `-`.
- Fixed Codex Astra retaining its larger window after disabling Extended Context, including cached models; explicit model overrides still take precedence.
- Fixed explicit Codex context-window overrides widening past the server-honored maximum; they now clamp to the documented ceiling like upstream Codex ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Fixed Astra's extended window over-advertising input by 128K; it now uses the documented 922K input cap inside the 1.05M total context ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Bills Astra API requests above 272K input at the documented 2x input / 1.5x output long-context tier; the Codex subscription route stays exempt with free cache writes ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Fixed Extended Context silently enabling without a settings source (SDK embedding, early boot); it now matches the off default until opted in ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Fixed `/copy` link captions showing Markdown delimiters for formatted labels and splitting across two rows for multiline labels ([#11086](https://github.com/can1357/oh-my-pi/pull/11086) by [@mustafaabidali](https://github.com/mustafaabidali)).
- Fixed Ask custom answers requiring another submission after paste or remaining on the same multi-select question; pending clipboard text is preserved before submission, and single-question multi-select answers still go through review ([#11099](https://github.com/can1357/oh-my-pi/pull/11099) by [@camjac251](https://github.com/camjac251)).
- The startup update notice no longer counts standalone `* * *` and `- - -` separator lines as changes.
- Fixed `/loop` replacing the repeating prompt with a mid-turn interjection; steering while the agent runs is now one-off, and only an idle submission becomes the new loop body ([#11159](https://github.com/can1357/oh-my-pi/pull/11159) by [@H4vC](https://github.com/H4vC)).
- Fixed `--plugin-dir` and omp-installed plugin agents no longer being discovered when the foreign `claude-plugins` source is disabled; user-scope plugin agent roots are now gated by origin like their skills ([#11151](https://github.com/can1357/oh-my-pi/issues/11151)).

## [18.1.13] - 2026-09-07

### Fixed

- Fixed GPT-6 Astra requiring `/extended-context` for its full context window: it now keeps the documented 1.05M-token window with the setting on or off, and explicit per-model `contextWindow` overrides still win.

## [18.1.12] - 2026-09-06

- Fixed edit and write results to report the formatted bytes actually committed by LSP writethrough.

### Changed

- Ranged reads of text without bracket characters skip unnecessary lexical context scanning.
- Muse Code sessions send a compact hashline edit description (~3 KB less per request); all other models keep the full prompt.
- Transcript usage row now shows the prompt-to-yield time as a bare delta, keeping the clock icon for time to first token only.

### Fixed

	- Fixed GPT-6 Astra extended-context support and preserved maximum context windows reported by OpenAI Codex discovery ([#10980](https://github.com/can1357/oh-my-pi/pull/10980) by [@H4vC](https://github.com/H4vC)).
- Subagent `yield` no longer rejects a valid `data` payload because a non-strict OpenAI-compatible backend filled the optional `error` field with `""`; previously the worker retried the identical call until the invalid-yield cap and the parent received nothing.
- Fixed fullscreen `/copy` outlining only a lazily created grouped Read card, so Enter copies the assistant yield instead of tool output.
- `memory://` now resolves against the session that issued it: a caller's own memory backend answers `memory://<id>`, so co-located sessions no longer read each other's memory rows, and a caller whose session is no longer live fails closed instead of being answered by a peer. Prompt completion binds to the same caller, so `memory://<memory-id>` stays on offer while a subagent shares the working directory. Advisors retain their owning session's memory access even without a session file.
- Fullscreen `/copy` now opens on the recent tail of the branch instead of replaying the whole session, so it appears immediately and steps without lag on long sessions (`a` loads the earlier turns). Both it and the esc-esc rewind selector also cache each transcript row set instead of re-stripping it every frame.
- Fixed the fullscreen `/copy` and esc-esc rewind selectors repainting the whole frame for a wheel notch that cannot move the viewport; because both open scrolled to the newest turn, wheeling down there made the frame twitch.
- The default `omp commit` agent now uses its displayed COMMIT model and honors `--model` instead of silently running on SMOL ([#10991](https://github.com/can1357/oh-my-pi/issues/10991)).
- Fixed JavaScript `eval` `completion()`/`agent()` handles so the documented immediate-handle pattern works: `h.wait()`, `h.status()`, and the other handle methods now work on the un-awaited factory result ([#10986](https://github.com/can1357/oh-my-pi/issues/10986)).

## [18.1.11] - 2026-09-05

### Added

- Added the `retry.waitForUsageReset` setting: when a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), the session sleeps until the reset instead of failing fast past `retry.maxDelayMs`.
- Added opt-in `bash.allowCompoundCommands` approval for conservative literal `&&` chains, with ordered per-segment rules and normal bash policy fallback for unmatched segments. The opt-in requires a positively classified POSIX-quoting shell; incompatible and unknown shells retain legacy approval. Whole-chain denies take precedence over earlier prompts.

### Fixed

- Idle compaction now starts or reschedules when its enabled state, threshold, or delay changes while a session is already idle ([#10242](https://github.com/can1357/oh-my-pi/issues/10242)).
- Fixed `todo` and other tools called through eval rejecting optional `None`/`null` arguments that direct tool calls accept.
- Report oversized selected lines that cannot fit after read context, with a working raw recovery selector instead of a looping continuation hint ([#10775](https://github.com/can1357/oh-my-pi/issues/10775)).
- Approved plan content is now inlined into approve-and-execute prompts instead of forcing the executor to re-read the durable plan file ([#10923](https://github.com/can1357/oh-my-pi/issues/10923)).
- Fixed WorkPool child sessions crashing during startup while constructing their incremental `yield` tool schema.
- Commit summaries written in Vietnamese, Korean, and other accented scripts are no longer rejected for exceeding the length limit, and keep their accents as typed.
- Tool-scoped TTSR rules now match finalized arguments reliably when providers stream short or throttled tool calls ([#10910](https://github.com/can1357/oh-my-pi/issues/10910)).
- Restored `getSupportedThinkingLevels` in the legacy `pi-ai` shim so extensions importing it from `@earendil-works/pi-ai` (e.g. `@companion-ai/feynman`) pass Bun's named-export check and load ([#10800](https://github.com/can1357/oh-my-pi/issues/10800)).

## [18.1.10] - 2026-09-04

### Changed

- Subagent `yield` now takes `data`/`error` directly instead of nesting them under a `result` wrapper.

### Fixed

- Fixed Codex V2 remote compaction rebuilding the request prefix differently from normal turns, restoring prompt-cache reuse ([#10786](https://github.com/can1357/oh-my-pi/issues/10786)).
- Restored mouse clicks, hover, and wheel scrolling in Plan Review.

## [18.1.9] - 2026-09-04

### Breaking Changes

- Browser and computer automation now use JavaScript/Python evaluation preludes with reusable tab and element handles, replacing the previous standalone tool schemas and object-shaped run APIs.
- Replaced the `inspect_image` tool and `/vision` controls with `read <image>?q=<question>` for image questions; text-only models now receive image metadata and guidance for using this selector.
- Renamed `inspect_image.timeoutMs` to `images.questionTimeoutMs`; existing settings are migrated automatically.

### Added

- Bash now extracts Kitty and Sixel terminal graphics as image results for foreground, failed, manual, and background executions.
- Markdown links to existing local files and resources are now clickable while preserving their displayed URLs.
- Added `/switch <model>` for session-only model changes, with the same model selectors and completions supported by `--model`; ACP `/model <model>` accepts these selectors as well.
- Added the `worktree.cleanSource` setting to reset and clean the original checkout when creating a worktree with `/wt`.
- Expanded the computer JavaScript/Python evaluation prelude with direct desktop, window, screenshot, accessibility, and element interaction helpers, while keeping `computer.run` available for multi-step scripts.

### Changed

- Agent delegation is now model-aware, allowing some models to favor focused inline work instead of spawning subagents.

### Fixed

- Fixed fallback authorization-code prompts remaining active after native OAuth callback completion.
- Fixed reciprocal idle subagents repeatedly waking one another indefinitely.
- Fixed `/wt` and `git worktree add` failing when the new worktree targeted the same commit as the clean source checkout.
- Fixed omp-installed marketplace plugins and `--plugin-dir` plugins losing their skills when the Claude plugin source was not separately enabled ([#10743](https://github.com/can1357/oh-my-pi/issues/10743)).
- Fixed session accent colors rendering as bright white in terminals without truecolor support, including Terminal.app ([#10759](https://github.com/can1357/oh-my-pi/issues/10759)).
- Rules with `enabled: false` frontmatter are now omitted during discovery, matching disabled skills ([#10769](https://github.com/can1357/oh-my-pi/issues/10769)).
- Fixed large MCP tool-result previews losing the relevant tail content when an oversized output line preceded it ([#10761](https://github.com/can1357/oh-my-pi/issues/10761)).
- Fixed `Ctrl+V` replacing CJK characters with `?` when pasting from XWayland clipboard owners on Wayland ([#10762](https://github.com/can1357/oh-my-pi/issues/10762)).
- Fixed byte-limited artifact reads reporting the displayed byte count instead of the actual read limit ([#10764](https://github.com/can1357/oh-my-pi/issues/10764)).
- Fixed read-tool truncation notices incorrectly reporting zero delivered lines or bytes when previewing a partial oversized line ([#10768](https://github.com/can1357/oh-my-pi/issues/10768)).
- Fixed Mnemopi removing explicitly retained or learned long-term memory after sessions longer than 24 hours by consolidating eligible working memory at session start ([#10770](https://github.com/can1357/oh-my-pi/issues/10770)).

### Removed

- Removed the librarian agent.

## [18.1.8] - 2026-09-03

### Fixed

- Improved background task results with structured output schemas: parsed results are now available through the `agent://<id>` resource, while large or invalid inline JSON is replaced with a reliable pointer to the complete result.
- Background task artifacts are retained long enough for follow-up turns to read them, including failed tasks that lack valid structured output, and are cleaned up without blocking shutdown or leaking resources.
- Fixed context compaction incorrectly accepting archived history that was larger because of opaque reasoning data, allowing the next compaction strategy to run instead.
- Fixed the Model Hub sidebar jumping to the top when provider refreshes rebuild the list; the focused model, or its nearest remaining entry, is now preserved.
- Fixed the `inspect_image` status hint showing the wrong model after switching between image-capable model roles.
- Fixed multi-minute TUI freezes during subagent activity and batch execution.

## [18.1.7] - 2026-09-03

### Breaking Changes

- Removed the Ruby and Julia eval backends and related interpreter configuration; eval now supports Python and JavaScript only.
- Removed the eval parallel() and pipeline() helpers. agent() and completion() now return handles immediately, and wait(handles) provides synchronization.
- Python eval tool calls are now asynchronous coroutines, matching JavaScript; use await tool.read({...}) and similar calls.

### Added

- Added asynchronous eval agent and completion handles with status, cancellation, messaging, waiting, and automatic result delivery for unwaited background work.
- Added eval workpools for queueing items onto the least context-loaded keep-alive subagent with configurable concurrency; the pool name is its async-job ID for `hub wait`, `.peek()` gives a non-consuming snapshot, per-item `{key, data|error}` yields finish batches incrementally, and `eval.workpool.freshAgents` opts into a new agent per item.
- Added support for defining eval tools in Python with @tool or JavaScript with tool(fn, schema), and exposing them to subagents through task, agent, and workpool calls. Configure availability with eval.tools.enabled.
- Added native Windows ARM64 binaries with architecture-aware installation and updates.
- Added an MLX backend for running local tiny models on Apple silicon. Configure providers.tinyModelDevice=mlx, or use PI_TINY_DEVICE=mlx or metal, to run title generation, memory tasks, and automatic thinking classification with MLX models, with an ONNX CPU fallback when Python is unavailable.
- Added Qwen3 1.7B as a local memory and thinking-classification model for the MLX backend.

### Changed

- Local tiny models for titles, memory, and automatic thinking classification now share on-demand workers across omp processes, reducing redundant resource usage; workers stop automatically after inactivity.
- PI_TINY_DEVICE=metal now selects the MLX backend on macOS.
- Updated agent reactions to trigger on the opening emoji instead of requiring a newline, consuming any following whitespace.

### Fixed

- Fixed transient provider retries incorrectly failing with an “Agent is already processing” error.
- Fixed user-scope marketplace plugins installed through omp losing their skills when the Claude plugin source was not separately enabled.
- Fixed hashline edits failing when targets included apply_patch markers, while rejecting ambiguous bracketed targets instead of editing the wrong path.
- Fixed bracketed hashline edit targets being reported as undefined to extension path allowlists.
- Fixed MCP tools discovered during startup disappearing after plan-mode approval or when leaving default-on plan mode.
- Fixed ACP clients receiving invalid file locations or updates for released terminals, preventing invalid worktree scans and terminal errors on Windows.

## [18.1.6] - 2026-09-03

### Breaking Changes

- Replaced the local session-title model choices with LFM2.5 230M, LFM2.5 350M, and Falcon H1 Tiny 90M.
- Reserved main and sub as built-in subagent definition names; custom agents can no longer use these names.

### Added

- Added agent reactions: a reply that opens with a lone emoji line shows the emoji as a badge on your message bubble instead of in the text; toggle the prompt invitation with the tui.reactions setting.
- Added video attachment and reading support through ffmpeg, including preview grids with metadata and timestamp/frame selectors such as :412 and :1h5m42s.
- Enhanced the model picker with intelligence indicators, catalog TPS estimates, provider-aware ranking, and provider-supplied badges and descriptions.
- Added detailed, non-summarized findings for scout agents through the report definition field, and subagent result relay so read-only agents can return data to their originating agent.
- Added agent-scoped rules using an agents frontmatter field with glob matching, including support for inspecting applicable rules with omp ttsr list and omp ttsr test --agent.
- Added non-interrupting extension messages through deliverAs: "aside" for pi.sendMessage and pi.sendUserMessage.
- Added copy and open controls for rendered blocks and links, including /copy link and the /open command.
- Added option-click cursor positioning in the prompt entry box.
- Added the configurable opencode display layout, with a corresponding first-run and upgrade setup option.
- Added the skillful prompt setting and /skillful command to control whether available skills are listed in the system prompt.
- Added Firecrawl as an optional providers.fetch backend for URL reading, configurable with FIRECRAWL_API_KEY and FIRECRAWL_BASE_URL.
- Added provider request metadata configuration for usage and cost attribution, including Amazon Bedrock request headers and User-Agent customization.
- Added the :-N read selector for reading the last N lines from files, directories, archives, artifacts, internal URLs, and web URLs, including combinations such as :raw:-60.
- Added an opt-in extension status-line segment for displaying custom statuses inline.
- Added injectV1: false to openai-models-list discovery for OpenAI-compatible gateways whose model endpoint is rooted at a versioned URL.
- Added provider-reported credits and routed-model counts to /session statistics.
- Added CLINE_API_KEY to the CLI environment help for native ClinePass subscription inference.
- Expanded Devin model selectors to support native CLI aliases, dotted upstream names, and dynamic effort-route identifiers.
- Standalone CLAUDE.md files in the project root and ancestor directories are now loaded as project context alongside AGENTS.md files.

### Changed

- Session history is now sorted by modification time, then creation time, then file path.
- Increased the maximum file snapshot size to 4 MB.
- Edit tools now provide streamed diff previews while applying changes.
- Approved plan content is included directly in agent history, reducing redundant reads.
- power.sleepPrevention now works on Linux and Windows. Its idle default keeps long-running sessions awake on those platforms; set it to off to restore the previous behavior.
- Unsupported-model errors no longer include incorrect retry instructions.

### Fixed

- Fixed local title models receiving unsupported online examples and failing with certain tokenizer templates.
- Fixed model picker search selection so it moves to the best matching result after results change.
- Fixed /new sometimes reviving the previous conversation in the current process or after a restart.
- Fixed raw text escaping in agent responses.
- Fixed structured subagent result previews being truncated incorrectly.
- Fixed /usage taking several seconds to become responsive on large statistics databases.
- Fixed the status line not appearing correctly in the first startup frame.
- Fixed shell builtins reporting broken-pipe errors when downstream commands exit early.
- Fixed provider-qualified model roles with dotted revisions resolving to the wrong provider or model.
- Fixed agent-scoped rules being lost when subagents are restored, and fixed rule:// URLs and rule inspection to consistently use the calling agent's applicable rules.
- Fixed extension and user asides being stranded, delivered to the wrong session, or incorrectly interrupting or restarting turns during session changes and image processing.
- Fixed parent steering messages arriving during a subagent's final result from preventing that result from being committed.
- Fixed messages typed while an edit or write tool was streaming from discarding the completed tool call and triggering unnecessary regeneration.

[Showing lines 1-300 of 1956. Use :301 to continue]