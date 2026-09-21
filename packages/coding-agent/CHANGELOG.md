# Changelog

## [Unreleased]

### Added

- Added `--agent <name>` to start a root session from a discovered agent definition (user `~/.omp/agent/agents`, project `.omp/agents`, extension, or bundled). The agent's tools, thinking level, model, body, and autoload skills apply unless `--tools` / `--thinking` / `--model` / `--system-prompt` override them. Unknown names fail with a usage error listing available agents.
- Added `--agent-cwd <path>` to resolve a named root agent from a role-definition project while keeping `--cwd` as the execution directory, and added `hide: true` agent frontmatter so explicitly named automation roles remain root-launchable without appearing in ambient task or `/agents` rosters.
- Resume and fork now restore a session's original `--agent` identity from the session header. A conflicting `--agent` is refused, and a persisted privileged role that is missing from discovery fails closed.
- Root `--agent` sessions now evaluate `agents` frontmatter rule scoping against the launched definition name, including restore from the session header.

## [18.2.7] - 2026-09-21

### Breaking Changes

- Image-generation overrides now use model selectors, and web-search CLI overrides use --model instead of --provider.
- Removed the bash tool's env parameter.
- Eval judge(state, questions) is now awaited and returns answers directly; JudgmentHandle and judgment support in wait() have been removed.

### Added

- Added `find` tool for semantic workspace searching, allowing agents to locate behaviors and symbols using natural language
- Added `find` CLI command for performing semantic workspace searches
- Added batch evaluation with judge_batch(states, questions) / judgeBatch(...), including bounded background execution, incremental result and status access, per-item failure reporting, and the ability to wait for or reattach to jobs across turns or after a reset.
- Added the jevify magic keyword to have the agent establish an evaluation rubric before classifying bulk items and inspect only items flagged by the judge.
- Added omp web-search as an alias for omp search.
- Added tui.titleSpinner configuration to select the terminal-title working-state spinner (braille, dots, or line).
- Added Handlebars-based system prompt templates through SYSTEM_TEMPLATE.md, --system-prompt-template, and the SDK, with access to live settings and tool data.
- Added configurable image, web, speech, dictation, judge, and memory model roles with ordered fallbacks, legacy backend-setting migration, and omp models --kind filtering.
- Added native OpenRouter image generation, model-selected web-plugin search, and live discovery of TypeSafe judge models.

### Changed

- Updated agent system prompts to prioritize the `find` tool over `grep` and `glob` for behavioral lookups
- Refined system prompt instructions for XML tag handling and agent persona
- Updated sloppy edit tool syntax to use plain text headers instead of XML tags
- Improved startup performance by validating provider-qualified model selectors against only the relevant provider catalog.
- Reduced launch time for npm and compiled builds by embedding the model catalog more efficiently.

### Fixed

- Fixed system prompt configuration validation so systemPromptTemplate and customSystemPrompt cannot conflict with a full systemPrompt replacement, including when values are empty.
- Added browser-relay support for listing eligible pages without attaching to or claiming them.
- Fixed Codex compatibility with the sloppy edit tool.
- Capped concurrent eval judge and completion requests to prevent large fan-outs from overwhelming judge and fallback models.
- Temporarily avoids retrying judgment requests with credentials that recently failed due to authorization or billing errors.
- Fixed image and speech fallback models disappearing after discovery and eliminated incorrect incompatibility warnings for providers without credentials.
- Fixed resume and continue flows to hide empty sessions.
- Fixed edit operations that could loop after empty insertions or fail on Unicode no-op and overlapping duplicate matches.
- Fixed live subagent messages being delayed by agent discovery and roster discovery looping on dot-named transcripts.
- Fixed llama.cpp discovery and routing for PrismML Bonsai 2 27B GGUF models, including support for cached models and the Qwen 3.8 thinking-level ladder.

## [18.2.6] - 2026-09-18

### Fixed

- Fixed clipboard paste stalling on an empty clipboard; image and text clipboard reads now run concurrently so the empty-clipboard status surfaces after the slower read instead of the sum of both.
- Fixed memory recall blocks carrying a minute-resolution `Current time` stamp that dirtied the cached system prompt on every refresh; recall rows already carry dates, so the stamp is removed.
- Fixed `omp auth-broker token` and `omp auth-gateway token` exiting silently without creating a token on Windows when no token file exists yet; token and config reads now use `node:fs` instead of `Bun.file`.

## [18.2.5] - 2026-09-17

### Breaking Changes

- Moved terminal UI modules—including themes, tool renderers, chat, overlay, status-line, composer, setup wizard, and Git/PS/debug apps—to `@oh-my-pi/pi-tui`. The corresponding `@oh-my-pi/pi-coding-agent` subpaths no longer exist; names re-exported from the package root remain unchanged.

### Added

- Added `omp stream` for livestreaming terminal sessions at `live.omp.sh/<your Stencil username>`, with viewer chat, pane-per-session display for sessions in the same directory, screen redaction, and configurable `stream.serverUrl` and `stream.redactPatterns` settings. Use `--server` to override the stream server, `--title` to set a title, and `--no-tui` to retain the line-based log interface.
- Added Stencil account support to `/login`. `omp stream` uses a signed-in Stencil account or `STENCIL_API_KEY` for channel ownership and authentication. Sensitive environment, dotenv, `secrets.yml`, credential-shaped, and configured pattern-matching values are redacted before screen data is transmitted.
- Added faster keyless web search fallback by prioritizing the default keyless Parallel provider ahead of Perplexity.

### Changed

- Improved parent IRC message prompts to make interruption handling more reliable.
- Improved subagent task labels and plan filenames to use concise, action-oriented descriptions.
- Updated CLI byte sizes to use decimal KB units and made duration displays coarser and easier to read.

### Fixed

- Fixed `edit` auto-repair waiting up to 60 seconds when the `smol` model does not respond; it now times out after 20 seconds and reports repair start and timeout details.
- Fixed subagents leaving queued parent messages behind after tool interruptions.
- Fixed a subagent burning its whole run on `yield` calls that never finish it: an incremental-only `yield` turn no longer bypasses the request budget, and the forced final `yield` ends the run ([#12351](https://github.com/can1357/oh-my-pi/pull/12351) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed `browser.open({ app: { relay: true } })` waiting for the full tool timeout when no relay extension is installed or reachable; it now fails promptly with an actionable error while preserving the wait for a connected extension to recover.
- Fixed `edit` handling of ellipsis markers, inline closing tags, copy-ready corrections, and retries, including cases that could insert literal markers, misreport matches, omit the file target, or panic.
- Enabled `edit.enforceSeenLines` by default to reject hashline edits anchored to content that was not displayed, and prevented stale-tag recovery from applying edits to a structurally different duplicate construct ([#12369](https://github.com/can1357/oh-my-pi/pull/12369) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed startup failures when the plugins directory or its manifest cannot be read; inaccessible plugin roots are now skipped with a warning.
- Fixed generation token-rate displays for subagents and restored the main session's reading after switching focus.
- Fixed subagent HUD labels and plan filenames being populated with example prompt text on smaller models.
- Improved shell, file, session, and persistence operations to avoid unnecessary repeated work, improving responsiveness and resource usage.

## [18.2.4] - 2026-09-17

### Added

- Added an optional live generation speed readout via `composer.tokenRate`, showing smoothed tokens-per-second output in the working row and keeping the rate visible between turns.
- Added TypeSafe provider support through `/login typesafe` or `TYPESAFE_API_KEY`. TypeSafe can power thinking-level detection, unexpected-stop detection, and AI-assisted git staging with calibrated judgment probabilities; configure `providers.judgmentProvider` as `auto`, `typesafe`, or `llm` to select the judgment backend.
- Added the `judge(state, questions)` evaluation helper for Python and JavaScript cell code, supporting typed choice, boolean, and score judgments. It returns a handle whose `.wait()` method provides answers and probabilities, using TypeSafe when configured and available or a fallback chat model otherwise.

### Changed

- Unified thinking-level detection, unexpected-stop detection, and AI-assisted staging around a shared judgment system with automatic fallback across configured models when TypeSafe is unavailable or cannot complete a request. AI-assisted staging now evaluates files as a single batched judgment while preserving one yes/no decision per file.

## [18.2.3] - 2026-09-17

### Breaking Changes

- Config-backed headers now resolve asynchronously through `ModelRegistry.getProviderHeaders()` or `resolveModelHeaders()`; removed the synchronous `config/model-config-values` module.
- Removed the unused `ConfigFile.getMtimeMsAsync()`, `tryLoadAsync()`, `loadAsync()`, and `loadOrDefaultAsync()` methods.
- Custom SQL session clients must support transactions for atomic renames.

### Added

- Type `^` to tag a model for delegation, with atomic display-name chips and session-persisted `m1`, `m2`, … agents available to task and eval.
- Provider login and setup support masked secret prompts; RPC rejects secret prompts rather than requesting ordinary input.

### Changed

- Shell-backed API keys and headers resolve asynchronously without freezing terminal input or running during catalog construction.

### Fixed

- macOS process discovery now retains the complete PID list when locating executables and descendants. ([#12290](https://github.com/can1357/oh-my-pi/pull/12290) by [@iliaal](https://github.com/iliaal))
- Reduced snapshot-recording stalls when a session retains large file histories. ([#12279](https://github.com/can1357/oh-my-pi/pull/12279) by [@iliaal](https://github.com/iliaal))
- Cancelled background jobs remain tracked until execution finishes, so cleanup cannot report completion prematurely after retention expires. ([#12278](https://github.com/can1357/oh-my-pi/pull/12278) by [@iliaal](https://github.com/iliaal))
- Fixed localized edits rewriting unrelated bytes in files with invalid UTF-8; these edits now fail without modifying the file. ([#12277](https://github.com/can1357/oh-my-pi/pull/12277) by [@iliaal](https://github.com/iliaal))
- Fixed sloppy edits crashing with a char-boundary panic instead of reporting a match error when the file contains multibyte (e.g. CJK) text.
- Fixed retry timing reliability in agent sessions by ensuring sleep durations are monotonic
- Fixed data stability issues when processing streamed lines
- Resolved same-path move failures in indexed session storage
- Restricted and revived subagents retain parent-loaded extension hooks without enabling extension-contributed tools.
- Revived subagents honor the owning session's extension-discovery restrictions.
- Secret login answers stay hidden in later prompts and cannot be recovered through undo or yank.
- SQL session renames preserve data on same-path moves, missing sources, and failed overwrites.
- MySQL session writes no longer use deprecated upsert value references.
- MCP SSE requests honor one response deadline and report timeouts correctly without replaying accepted tool calls.
- Legacy extension package-import patterns follow native prefix precedence.
- Bundled extensions observe theme initialization and changes through the existing live `theme` export.
- Configured discovery models retain request-time credentials after offline cache reloads and failed refreshes.
- Runtime API-key overrides retain precedence over configured credentials.
- Element handles returned by `tab.waitForSelector`, `tab.$`, and related selector helpers can now be passed as arguments to `tab.evaluate` inside `tab.run` instead of failing with "JSHandles can be evaluated only in the context they were created".

## [18.2.2] - 2026-09-16

### Added

- Expanded built-in secret obfuscation to detect credentials in connection URLs regardless of environment-variable name, including PostgreSQL, MongoDB, MySQL, Redis, AMQP, and other supported schemes.
- Expanded built-in secret obfuscation to cover AWS access keys, Google API keys, Slack, npm, Stripe secret/restricted keys and webhook secrets, Hugging Face and SendGrid tokens, JWTs, Bearer tokens, and PEM private keys.
- Added the `tui.titleSpinner` setting to choose the terminal-title working-state animation (`braille`, `dots`, `line`, or `pulse`), alongside the existing `tui.titleState` toggle.

### Changed

- Session-stop hooks that block with a reason now keep the session running until they allow it or the user interrupts; explicit aborts are no longer restarted by a stop hook.
- Corrupt agent and prompt-history databases are now backed up before fresh stores are created, allowing startup to continue; credentials may need to be entered again.
- Agent and history database startup errors now identify the affected database file.
- Terminal-title spinner animations now work on native Windows; WSL retains the static separator to avoid unnecessary CPU usage.
- Explicit model refreshes now re-evaluate command-backed API keys and headers, allowing rotated credentials to take effect without restarting.
- Background job entries are removed shortly after their results are consumed or recovered, while unconsumed jobs remain available for inspection.

### Fixed

- Fixed the transcript collapsing into a compact no-spacing layout whenever the prompt, todo HUD, or other below-transcript chrome grew a few rows; the live tail now scrolls off the top instead.
- Fixed transcript layout and rebuilding issues that could collapse blank rows, leave tool calls displayed on one line, or show stale fragments after navigation, display changes, or compaction ([#12177](https://github.com/can1357/oh-my-pi/pull/12177) by [@shivamklr](https://github.com/shivamklr)).
- Fixed the `security-reviewer` agent so valid findings with anchors and remediation details are accepted.
- Stopping a subagent from Agent Hub now settles and reports its parent background job instead of leaving `hub wait` blocked indefinitely.
- Fixed prewalk handoff detection after edits or writes dispatched through Code Mode eval cells.
- Reduced main-thread stalls while streaming large edits by deferring AST-based matching until the edit is complete.
- Corrected the `/handoff` description so it accurately reflects that the command creates a handoff document and compacts the current session.
- Deferred misleading cold-cache `retry.fallbackChains` warnings until provider discovery completes.
- Fixed `--prewalk-into @default` so an explicitly selected startup model does not replace the configured default role, including ordered fallbacks and discovery-backed candidates.
- A corrupted or externally modified session file no longer leaves the session impossible to close; a subsequent Ctrl+C exits without rewriting the session log.
- Fixed silent MCP requests being terminated by an undeclared idle timeout; closing a legacy SSE connection now also cancels pending requests and notifications.
- Fixed browser reuse for Chromium installed behind Linux wrapper scripts and prevented duplicate launches when a profile is locked ([#12236](https://github.com/can1357/oh-my-pi/pull/12236) by [@shivamklr](https://github.com/shivamklr)).

## [18.2.1] - 2026-09-15

### Breaking Changes

- Renamed the `/drop` slash command to `/delete` so that "drop" is no longer overloaded between deleting the session and dropping a goal (`/goal drop`).
- Read tool results no longer duplicate the body in `details.truncation.content`; use result `content` or `details.displayContent` instead. ([#11255](https://github.com/can1357/oh-my-pi/pull/11255) by [@jiwangyihao](https://github.com/jiwangyihao))
- Removed the `DEL`, `DEL.BLK`, `COPY`, and `COPY.BLK` hashline edit operations. Use `CUT` / `CUT.BLK` for deletion; removed content remains available to `PASTE`.
- Changed tab.screenshot() to no longer accept a per-call save path; it now saves screenshots under browser.screenshotDir (or the OS temp directory if unset) and returns the saved path.

### Added

- Added keyless Parallel web search when the provider is explicitly selected ([#9770](https://github.com/can1357/oh-my-pi/pull/9770) by [@georgeatparallel](https://github.com/georgeatparallel)).
- Sloppy edits support `<SM:AFTER>` to insert new lines after an anchor without repeating or replacing it.
- Fixed eligible full OpenAI Responses request-body timeouts by retrying once after conservative local tool-result elision, while preserving assistant/user history, unsafe partial output, and existing stateful retries ([#11878](https://github.com/can1357/oh-my-pi/pull/11878) by [@hellofrommorgan](https://github.com/hellofrommorgan)).
- User append instructions (`APPEND_SYSTEM.md`, `--append-system-prompt`) now render under their own `## User Instructions` heading whenever generated blocks precede them, instead of trailing the `## MCP Server Instructions` section and reading as server-supplied, unverified content ([#11832](https://github.com/can1357/oh-my-pi/pull/11832) by [@iacore](https://github.com/iacore)).
- Prewalk now arms for a hand-off target served by a `models.yml` `discovery:` provider (e.g. `openai-models-list`): `buildSessionOptions` runs a cache-aware refresh for the provider named by the selector and retries, instead of disabling prewalk with a `Model "…" not found` warning for ids `omp models` lists ([#11820](https://github.com/can1357/oh-my-pi/issues/11820)).
- Non-throwing tool failures now retain their error status through extension result rewrites and eval-defined subagent tools ([#11585](https://github.com/can1357/oh-my-pi/issues/11585)).
- Session rewrites now refuse to replace a file changed by another process, preserving durable turns from concurrent terminals ([#11496](https://github.com/can1357/oh-my-pi/issues/11496)).
- Goal mode now idles after repeated continuations return identical tool evidence instead of re-waking indefinitely ([#11819](https://github.com/can1357/oh-my-pi/issues/11819)).
- Cycling models with Ctrl+P no longer injects a spurious tool-roster notice that made the model believe still-callable tools had been removed; a prompt rebuild now discards the queued delta it already reflects ([#11824](https://github.com/can1357/oh-my-pi/issues/11824)).
- Subagent `yield` no longer fails a run with `SYSTEM WARNING: Subagent called yield with null data.` when a data-less `useLastTurn` finalize (e.g. `{type:"result"}`) lands on a thinking-only turn with no text; the tool now rejects it at the boundary so the child is reminded to resubmit with `data` ([#11150](https://github.com/can1357/oh-my-pi/issues/11150)).
- `--continue` no longer treats a merely-missing breadcrumb cwd as a project move. Re-root now requires the continue directory to be the same device+inode the breadcrumb recorded (`git worktree move` / same-filesystem `mv`). A cross-filesystem `mv` (copy+unlink, new inode) is intentionally not re-rooted: the session stays in the original bucket, `header.cwd` is not rewritten, and a warn is logged ([#11565](https://github.com/can1357/oh-my-pi/issues/11565)).
- Cold-revived persisted subagents now anchor wake-turn artifacts to their own transcript directory rather than the live root session's, so nested-depth and post-`/new` revivals no longer write `<id>.md` outside the revived agent's tree ([#11563](https://github.com/can1357/oh-my-pi/issues/11563)).
- Legacy `settings.json` → `config.yml` migration now writes the YAML first and only then archives the JSON, surfaces failures instead of swallowing them, and recovers from an orphaned `settings.json.bak` when `config.yml` is missing ([#11569](https://github.com/can1357/oh-my-pi/issues/11569)).
- Legacy `settings.json` → `config.yml` migration now writes the YAML first and only then archives the JSON, and surfaces failures instead of swallowing them ([#11569](https://github.com/can1357/oh-my-pi/issues/11569)).
- MCP server names may now contain spaces, so human-friendly display labels like `MaaS Slack` survive `/mcp reauth` write-back instead of being rejected by the config writer ([#11731](https://github.com/can1357/oh-my-pi/issues/11731)).
- File paths in the compact grouped `Read (N)` tree are now clickable OSC 8 hyperlinks, matching standalone Read rows; delimited reads carry a resolved link target per row so both live output and rebuilt transcripts link correctly ([#11732](https://github.com/can1357/oh-my-pi/issues/11732)).
- Added server-name autocomplete for `/mcp` commands (`enable`, `disable`, `test`, `remove`, `reconnect`, `reauth`, `unauth`) using configured and runtime-discovered MCP servers.
- Added `CUT` and `PASTE` ops to the hashline edit tool for moving code without retyping it: `CUT N.=M` (and `.BLK` block forms) capture lines into a clipboard register, and `PASTE` operations insert them. The register flows across sections within a patch (cross-file moves) and persists across edit calls per session.
- Added `--from-claude` and `--from-codex` session imports (including compaction state for Codex), also available from `/resume @claude` and `/resume @codex`.
- Added interactive Exa API-key onboarding through `/login exa`, opening the official key dashboard and saving pasted keys for authenticated web search while preserving `EXA_API_KEY` and explicit-selection public MCP fallback behavior ([#1798](https://github.com/can1357/oh-my-pi/issues/1798)).
- Added `ExtensionContext.getAsyncJobSnapshot()` so extensions can read the owning session's async-job state without relying on process-global job-manager identity
- Added opt-in `tui.codexResetFireworks` celebrations for unscheduled Codex weekly usage resets and newly banked saved resets, shown in a theme-aware top-third modal until Escape ([#6858](https://github.com/can1357/oh-my-pi/pull/6858) by [@joshrzemien](https://github.com/joshrzemien)).
- The Cursor exec bridge serves the seven modern Pi tool frames, mapping each to its local equivalent: `pi_read`/`pi_ls` → `read`, `pi_bash` → `bash`, `pi_edit` → `edit`, `pi_write` → `write`, `pi_grep` → `grep`, and `pi_find` → `glob`. The frames are a separate wire family from the legacy args, not aliases, so each mapping is a real translation — `pi_grep`'s `ignore_case` is the inverse of the local tool's case-sensitivity flag, `pi_find` searches filenames rather than contents, and `pi_edit`'s replacements are renamed to the local snake_case pairs.
- `providers.autoThinkingMaxEffort` (`xhigh` | `max`, default `xhigh`) raises the ceiling of the `auto` thinking classifier. `max` became a first-class effort tier after the classifier prompt was written, so `auto` could never reach it on models that expose the tier — only the `ultrathink` keyword could. Opting in adds `max` to the classifier's vocabulary, gated on the target model actually supporting it; the default keeps today's prompt byte-for-byte. The ceiling is enforced inside the effort clamp rather than on the classifier's answer, so a sparse ladder cannot snap an excluded request back up, and the Low floor is still resolved against the model's own ladder. The on-device 3-bucket classifier stays capped at `xhigh` regardless of the setting. The ceiling governs what `auto` resolves: a ladder with nothing underneath it yields no auto level, and a `thinking.requiresEffort` model still gets its lowest supported effort from the transport.
[…67ln elided…]
- A manual `/compact` (slash command, RPC `compact`, extension `ctx.compact()`) issued while a turn is in flight now resumes that turn once the summary is committed, or immediately when there was nothing to compact — a queued steer/follow-up drives the resume, otherwise the same auto-continue nudge context-full compaction uses — instead of leaving the agent idle on a half-finished tool loop until the user types "continue". A prompt or extension-triggered turn that lands first takes the session instead. `compaction.autoContinue: false` still disables the resume; plan-mode "Approve and compact context" keeps dispatching its own execution turn ([#11873](https://github.com/can1357/oh-my-pi/pull/11873) by [@brndnmtthws](https://github.com/brndnmtthws)).
- Model-browser prices now preserve integer trailing zeros and positive sub-cent rates, and identify invalid individual rates ([#11624](https://github.com/can1357/oh-my-pi/pull/11624) by [@cyriusweng](https://github.com/cyriusweng)).
- Fixed the composer stranding blank rows below the input after a confirmation dialog or tall multi-line editor collapses; the editor now stays pinned to the bottom instead of drifting up until a resize ([#11007](https://github.com/can1357/oh-my-pi/issues/11007)).
- Subagent transcripts now identify their parent session and attribute host or parent-agent steering to the agent instead of the user ([#12077](https://github.com/can1357/oh-my-pi/issues/12077)).
- User-shell `!` commands now keep their transcript block mutable until queued PTY replay finishes, preventing successful and nonzero stdout/stderr from disappearing into immutable terminal history ([#12062](https://github.com/can1357/oh-my-pi/issues/12062); [#12080](https://github.com/can1357/oh-my-pi/pull/12080) by [@Dante-dan](https://github.com/Dante-dan)).
- Headless print mode now stays alive while first-turn mnemopi recall waits for its embedding worker ([#12067](https://github.com/can1357/oh-my-pi/issues/12067)).
- Deferred TTSR reminders no longer repeat before the configured `repeatGap` has elapsed ([#12065](https://github.com/can1357/oh-my-pi/pull/12065) by [@Dante-dan](https://github.com/Dante-dan)).
- Queued user steering and follow-up messages now refresh extension policy at delivery, including the first steering turn in a new session; returned overrides stay current when hooks change tools, and repeated policy changes pause automatic draining until an explicit retry ([#11835](https://github.com/can1357/oh-my-pi/pull/11835) by [@andrebrait](https://github.com/andrebrait)).
- Fixed the TODO HUD auto-dismiss lifecycle: completed plans now persist their hidden state, survive session reopen, and can be explicitly revealed without stale timers hiding replacement plans.
- Agents shipped by omp-installed marketplace plugins now honor their `model:` frontmatter instead of always inheriting `@default`; only Claude Code-format plugins (declaring `.claude-plugin/plugin.json`) keep dropping their provider-specific aliases ([#12028](https://github.com/can1357/oh-my-pi/issues/12028)).
- `--resume`/`--continue` combined with `--no-session` now fail with `--resume requires session persistence` instead of silently starting a fresh empty session and discarding the resumed history ([#12008](https://github.com/can1357/oh-my-pi/issues/12008)).
- Session search now keeps exact and partial title matches above prompt-history matches, so a session found by name stays at the top after typing pauses ([#11990](https://github.com/can1357/oh-my-pi/pull/11990) by [@lemonleks](https://github.com/lemonleks)).
- Collab replication now enforces its 1 MiB frame ceiling: an entry too large to shrink ships as a "too large to replicate" entry instead of an oversized frame, a deeply nested entry no longer aborts a guest's join, and the ceiling is measured in bytes rather than UTF-16 code units ([#11433](https://github.com/can1357/oh-my-pi/issues/11433); [#11999](https://github.com/can1357/oh-my-pi/pull/11999) by [@MertSoylu](https://github.com/MertSoylu)).
- Model Hub now waits for default-role assignment to finish before accepting more input, preventing stale UI state and duplicate model changes that made a selection appear to require a second attempt ([#10982](https://github.com/can1357/oh-my-pi/pull/10982) by [@lemonleks](https://github.com/lemonleks)).
- Fixed macOS copies showing pasteboard warnings, mangling non-ASCII text, reinterpreting PDF/EPS/RTF text, or leaving stale text after rapid copies ([#9015](https://github.com/can1357/oh-my-pi/pull/9015) by [@lemonleks](https://github.com/lemonleks)).
- Fixed the coding-agent binary bundle failing with `Could not resolve: "chalk"` in hermetic installs (e.g. `nix run`) by importing chalk from the in-repo `@oh-my-pi/pi-utils/chalk` reimplementation instead of the undeclared npm `chalk` package ([#12001](https://github.com/can1357/oh-my-pi/issues/12001)).
- Fixed `edit.modelVariants` and other model-dependent system-prompt policy going stale after an automatic retry or usage-aware fallback swapped the model, so a session that fell back to a variant-pinned model now rebuilds its prompt for the model actually serving the turn ([#11983](https://github.com/can1357/oh-my-pi/issues/11983)).
- `omp auth-gateway serve` now picks up credential logins and logouts made by another process within ~10s instead of serving its boot-time credential set until restart: broker-backed clients implement `pollExternalChanges()`, and the gateway polls it to reload credentials and rebuild its served catalog so a newly-logged-in provider becomes routable and a logged-out one stops being advertised and used ([#11781](https://github.com/can1357/oh-my-pi/issues/11781)).
- Fixed `omp bench` and `omp if-bench` rejecting models that `omp models` lists (e.g. llama.cpp, Ollama, LM Studio, `models.yml` servers) by retrying model resolution through a live discovery pass when the local cache can't restore their credentials ([#11598](https://github.com/can1357/oh-my-pi/pull/11598) by [@yomgui1](https://github.com/yomgui1)).
- `omp --fork` with a missing session path now fails with `Session "<path>" not found.` instead of silently opening an empty parentless session ([#11944](https://github.com/can1357/oh-my-pi/pull/11944) by [@onlyysaurabh](https://github.com/onlyysaurabh)).
- `omp read <mcp-resource>` now waits for a still-handshaking MCP server to finish connecting instead of reporting `No MCP server has resource` when the connect outlasts the startup race ([#11950](https://github.com/can1357/oh-my-pi/issues/11950)).
- `memory://root` is now advertised in URL completion only on `memory.backend=local`, and reading it on `hindsight`/`mnemopi` reports the file-backed root as local-only (pointing at `recall`/`reflect`) instead of telling you to enable memories that are already enabled; the memory glob validator now names the expected form (`memory://root/**`) instead of echoing the rejected input ([#11909](https://github.com/can1357/oh-my-pi/issues/11909)).
- Advisors no longer brick themselves permanently on a transient rate limit: a usage-limit error whose credential is only temporarily blocked is now waited out and retried (bounded by `retry.maxDelayMs` / `retry.maxRetries`), latching the quota-exhausted state only when the block is a genuine long quota window ([#11947](https://github.com/can1357/oh-my-pi/issues/11947)).
- Large eval `display()` values now stay bounded in session history while remaining available through output artifacts, preventing slow `--resume` startup ([#11920](https://github.com/can1357/oh-my-pi/issues/11920)).
- Hindsight mental-model refresh no longer rewrites the active session's cached system-prompt prefix: the rendered `<mental_models>` block is frozen for the session lifetime (a background reflect applies to the next session; `/memory mm reload` remains the explicit in-session refresh), and volatile `last_refreshed_at` metadata no longer enters the model-facing prompt ([#11961](https://github.com/can1357/oh-my-pi/issues/11961)).
- Fixed Ctrl+D quitting the prompt even with draft text; it now deletes the character at the cursor like Delete, and only exits on an empty draft.
- Task subagents now honor the parent session's pinned OAuth account, including parallel and nested tasks ([#11939](https://github.com/can1357/oh-my-pi/issues/11939)).
- Advisor acknowledgments distinguish acceptance, deferral, and suppression; higher-priority findings replace only pending notes from the same review ([#11881](https://github.com/can1357/oh-my-pi/pull/11881) by [@olegpulatov](https://github.com/olegpulatov)).
- `/extensions` now shows an enabled context file as active when its higher-priority competitor is disabled ([#11870](https://github.com/can1357/oh-my-pi/issues/11870)).
- Anthropic prompt caching now keeps rolling breakpoints on persisted history when multiple `context` extension handlers append per-call messages ([#11897](https://github.com/can1357/oh-my-pi/issues/11897)).
- Collab guests now automatically rejoin when a transient host network drop recreates the relay room ([#11858](https://github.com/can1357/oh-my-pi/issues/11858)).
- Yield now resets the schema-validation retry budget after each valid section and recovers double-encoded JSON values instead of spending retries ([#11890](https://github.com/can1357/oh-my-pi/pull/11890) by [@lucamaia9](https://github.com/lucamaia9)).
- Bash commands whose `cwd` is a secondary Git worktree no longer inherit the agent's own `GIT_DIR`/`GIT_WORK_TREE` and related repo-location overrides, so a failed cherry-pick stays in the worktree where it ran instead of contaminating the primary one ([#11082](https://github.com/can1357/oh-my-pi/issues/11082)).
- Fixed `hub start` failing with a raw `connect ENOENT …/broker.sock` when the project daemon broker's lease was stale: the lease is now a process-owned lock the OS releases however the broker dies, a stale lease no longer blocks startup, and a broker that still cannot start reports its scope path plus recovery commands ([#11080](https://github.com/can1357/oh-my-pi/issues/11080)).
- Fixed concurrent `/pin` toggles from multiple omp instances silently dropping each other's pins, and crashes mid-write corrupting the pins file.
- LSP and debugger connections reject oversized or invalid frames instead of accumulating stdout indefinitely; fragmented headers decode without rescanning previous bytes.
- Read-only transcripts skip image blobs from hidden history, and session blob loading limits concurrent reads.
- Ctrl+C during an in-flight extension/hook load now exits cleanly instead of raising an `ExtensionExitError` unhandled-rejection storm ([#11789](https://github.com/can1357/oh-my-pi/issues/11789)).
- The legacy `@earendil-works/pi-coding-agent` shim now exports `findCutPoint` (adapted to upstream Pi's tokenizer-less 4-arg signature) and `sessionEntryToContextMessages`, so extensions targeting upstream Pi 0.84.2's compaction/session APIs (e.g. NVlabs/SoL-Pi) install instead of failing validation ([#11796](https://github.com/can1357/oh-my-pi/issues/11796)).
- `write` now rejects exact incomplete read projections before they can replace and truncate an existing file ([#11792](https://github.com/can1357/oh-my-pi/issues/11792)).
- Long reasoning streams retain less memory while preserving scrollback and terminal-width replay.
- `omp read <image>?q=<question>` no longer fails with "Model registry is unavailable for image questions."; the read CLI now wires a model registry so image questions resolve `modelRoles.vision`/`@default` like the agent ([#11338](https://github.com/can1357/oh-my-pi/issues/11338)).
- Shared sessions stay connected when a guest sends a corrupted frame or uses the wrong room key.
- Fixed turns dying with `undefined is not an object (evaluating 'e.identity.class')` as soon as the model started thinking when an extension provider projects its own catalog through `oauth.modifyModels` (`pi-provider-kiro` and friends); projected models are now materialized like every other catalog source.
- Legacy `agent.db` settings rows are deleted after a successful `config.yml` migration write, so deleting `config.yml` no longer silently resurrects stale values ([#11568](https://github.com/can1357/oh-my-pi/issues/11568)).
- Subagents (including `/vibe` workers) that write their report in one turn and then finalize with a data-less `yield` in the next no longer come back as `SYSTEM WARNING: Subagent called yield with null data` stapled to accumulated narration. The finalize now harvests the last turn that actually reported — prose with no further work started — so mid-run narration can never surface as a final result either ([#11746](https://github.com/can1357/oh-my-pi/pull/11746) by [@oldschoola](https://github.com/oldschoola)).
- Fixed `/force` and other forced tool choices refusing every OpenRouter model: `buildNamedToolChoice` did not recognise the `openrouter` api. Models whose compat disables tool choice or forced tool choice now report forcing as unsupported instead of queueing a choice the transport discards ([#11658](https://github.com/can1357/oh-my-pi/pull/11658) by [@datrixlab](https://github.com/datrixlab)).
- Provider `baseUrl` overrides now scope by API: custom models inheriting the provider URL define which APIs it covers (a provider-level `api` covers override-only providers), `transport: pi-native` keeps its gateway `baseUrl` provider-wide, and a bundled model no longer routes to another API's endpoint ([#11608](https://github.com/can1357/oh-my-pi/pull/11608) by [@danilouchoa](https://github.com/danilouchoa)).
- Invalidated stale background speculative compaction results when post-snapshot branch growth prevents recovery headroom or causes net context expansion, preventing dead-end progress pauses and provider context overflows ([#11637](https://github.com/can1357/oh-my-pi/pull/11637) by [@alvins82](https://github.com/alvins82)).
- Fixed `AgentSession.waitForIdle()` returning before successful retry recovery events and persistence had settled.
- Reviving a parked subagent whose session file vanished, or whose transcript lost its message history, now fails loudly instead of resurrecting a zero-history agent that runs, answers peers, and writes attributed work ([#11500](https://github.com/can1357/oh-my-pi/issues/11500)).
- Native compaction preserves prior local summaries and messages arriving while a speculative compaction is in flight. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Advisor maintenance preserves compaction summaries and native replay payloads in later requests without duplicating native-covered retained messages. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Advisor maintenance uses portable summaries for incompatible native targets and prevents automatic model switches or recovery re-primes from stranding native history. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Advisor fallback, cooldown restoration, and context promotion can replay compatible native history when new native compaction is disabled; creating native results still requires the remote method to be enabled. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Secret obfuscation covers native message, tool/search text, and dynamic discovery descriptions and schema annotations in replay and preserved compaction history, including search/discovery-only collisions and snapshots committed after a later secret is discovered, while preserving tool schema constraints. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- A session store that stops accepting writes (full disk, locked file, removed drive) now reports the failure on stderr in print mode and as an error notice in RPC mode, and a run whose transcript never became durable exits nonzero instead of reporting success ([#11493](https://github.com/can1357/oh-my-pi/issues/11493)).
- Online auto-thinking classification and session titles now walk `retry.fallbackChains` when the tiny/smol primary returns a provider error, instead of failing the background task while the main turn still has a fallback chain.
- Online tiny tasks now use canonical model-keyed, wildcard, and role fallback resolution, and stop at the first resolvable model when `retry.modelFallback` is disabled.
- Session title generation now expands the appended active session model's own `retry.fallbackChains` after that model fails, without merging tiny/commit/smol role defaults onto it ([#10938](https://github.com/can1357/oh-my-pi/pull/10938)).
- `/export` HTML now renders bold inline code inside ordered-list items followed by fenced code blocks instead of displaying literal `<strong>` and `<code>` tags ([#11690](https://github.com/can1357/oh-my-pi/issues/11690)).
- Disabled providers are no longer selected as pinned subagent models; ordered agent model lists now skip them ([#11709](https://github.com/can1357/oh-my-pi/issues/11709)).
- Entering goal or vibe mode while a plan session is paused now warns `Plan mode is paused — run /plan again to fully exit.` instead of the stale `Exit plan mode first.` ([#11692](https://github.com/can1357/oh-my-pi/issues/11692)).
- `omp plugin install <name>` for npm packages now bypasses bun's manifest cache, so a reinstall picks up a newly published version instead of a stale one, and installing an explicit `<name>@<version>` no longer fails to resolve a version that exists on the registry ([#11634](https://github.com/can1357/oh-my-pi/issues/11634)).
- File slash commands now surface their `argument-hint` frontmatter as inline autocomplete ghost text and ACP `input.hint`, not only in the `/extensions` inspector ([#11647](https://github.com/can1357/oh-my-pi/issues/11647)).
- Extensions authored against upstream Pi (e.g. pi-fabric) no longer crash every session at startup: registered tools now carry the upstream-shaped `sourceInfo` provenance that `getAllRegisteredTools()` consumers read ([#11661](https://github.com/can1357/oh-my-pi/issues/11661)).
- Custom `openai-responses` / `openai-codex-responses` providers can now set `compat.supportsConfigurationUpdate: false` in `models.yml` so auto-thinking effort changes on `gpt-6-astra` are sent as the top-level `reasoning.effort` instead of a `configuration_update` input item the endpoint rejects with HTTP 400; the key is validated as a boolean and documented ([#11121](https://github.com/can1357/oh-my-pi/issues/11121)).
- Missing execute-time tool context now fails closed to `always-ask` with an empty policy map (no user grant) instead of silently resolving as `yolo` with empty policies. The former copies (`ExtensionToolWrapper.execute`, Cursor `refuseByWritePolicy`, `mcpApprovalPreflight`, and eval prelude host calls) share one helper so they cannot drift. A session-bound wrapper that is invoked without context still inherits that session's settings ([#10362](https://github.com/can1357/oh-my-pi/issues/10362)).
- Advisors that repeatedly emit unsafe tool calls now pause their optional review until reset or their model/tool capability basis changes.
- Stop eval from advertising `agent()` after the session reaches its subagent recursion-depth limit.
- Background job snapshots preserve complete sibling results when a capture fails and show each capture warning only once.
- Failed raw-output captures now show a warning without failing the command or advertising an incomplete artifact as full output.
- Unknown custom status-line segment ids now produce a config warning and are rejected by `omp config set` instead of silently disappearing ([#11579](https://github.com/can1357/oh-my-pi/issues/11579)).
- `ast_edit`, `search`, and `ast_grep` no longer fan out into overlapping scans when `paths` mixes a directory with a file inside it and the directory is spelled as an absolute path; `ast_edit` previously applied each rewrite twice to the nested file (corrupting it, e.g. `wrap(wrap(log(1)))`) or reported a spurious stale-preview error ([#11584](https://github.com/can1357/oh-my-pi/issues/11584)).

[Showing lines 1-117 and 185-300 of 300; 67 middle lines (15.9KB) elided. Use :301 to continue. Read artifact://14 for full output]