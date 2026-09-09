# Changelog

## [Unreleased]

### Added

- Added opt-in interactive collab auto-hosting with configurable relay safety and write-link file output. Project `.omp/config.yml` may enable hosting for that cwd.

### Fixed

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