# Changelog

## [Unreleased]

### Fixed

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
## [18.1.14] - 2026-09-07

### Fixed

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

## [18.1.13] - 2026-09-07

### Fixed

- Fixed GPT-6 Astra requiring `/extended-context` for its full context window: it now keeps the documented 1.05M-token window with the setting on or off, and explicit per-model `contextWindow` overrides still win.

## [18.1.12] - 2026-09-06

- Fixed edit and write results to report the formatted bytes actually committed by LSP writethrough.

### Changed

- Ranged reads of text without bracket characters skip unnecessary lexical context scanning.
- Muse Code sessions send a compact hashline edit description (~3 KB less per request); all other models keep the full prompt.

### Fixed

	- Fixed GPT-6 Astra extended-context support and preserved maximum context windows reported by OpenAI Codex discovery ([#10980](https://github.com/can1357/oh-my-pi/pull/10980) by [@H4vC](https://github.com/H4vC)).
- Subagent `yield` no longer rejects a valid `data` payload because a non-strict OpenAI-compatible backend filled the optional `error` field with `""`; previously the worker retried the identical call until the invalid-yield cap and the parent received nothing.
- Fixed fullscreen `/copy` outlining only a lazily created grouped Read card, so Enter copies the assistant yield instead of tool output.
- `memory://` now resolves against the session that issued it: a caller's own memory backend answers `memory://<id>`, so co-located sessions no longer read each other's memory rows, and a caller whose session is no longer live fails closed instead of being answered by a peer. Prompt completion binds to the same caller, so `memory://<memory-id>` stays on offer while a subagent shares the working directory. Advisors retain their owning session's memory access even without a session file.
- Fullscreen `/copy` now opens on the recent tail of the branch instead of replaying the whole session, so it appears immediately and steps without lag on long sessions (`a` loads the earlier turns). Both it and the esc-esc rewind selector also cache each transcript row set instead of re-stripping it every frame.
- Fixed the fullscreen `/copy` and esc-esc rewind selectors repainting the whole frame for a wheel notch that cannot move the viewport; because both open scrolled to the newest turn, wheeling down there made the frame twitch.

## [18.1.11] - 2026-09-05

### Added

- Added the `retry.waitForUsageReset` setting: when a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), the session sleeps until the reset instead of failing fast past `retry.maxDelayMs`.
- Added opt-in `bash.allowCompoundCommands` approval for conservative literal `&&` chains, with ordered per-segment rules and normal bash policy fallback for unmatched segments. The opt-in requires a positively classified POSIX-quoting shell; incompatible and unknown shells retain legacy approval. Whole-chain denies take precedence over earlier prompts.

### Fixed

- Fixed `todo` and other tools called through eval rejecting optional `None`/`null` arguments that direct tool calls accept.
- Report oversized selected lines that cannot fit after read context, with a working raw recovery selector instead of a looping continuation hint ([#10775](https://github.com/can1357/oh-my-pi/issues/10775)).
- Fixed WorkPool child sessions crashing during startup while constructing their incremental `yield` tool schema.
- Commit summaries written in Vietnamese, Korean, and other accented scripts are no longer rejected for exceeding the length limit, and keep their accents as typed.

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

[Showing lines 1-300 of 1988. Use :301 to continue]