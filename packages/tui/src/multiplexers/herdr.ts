import type { TerminalMultiplexerModule } from "./types";

const HERDR_PANE_ID_PATTERN = /^[0-9A-Za-z:_-]{1,64}$/u;

export const herdrMultiplexer = {
	id: "herdr",
	precedence: "session",
	sessionEnvKeys: ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"],
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		// Identity vars survive env-sanitizing launchers that drop HERDR_ENV.
		// Client-only socket, binary, session, and config overrides are not proof
		// that this process runs inside a pane.
		return env.HERDR_ENV === "1" || Boolean(env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID);
	},
	/**
	 * Claim Herdr delivery when the process runs inside one of its panes.
	 * Herdr already toasts Finished on Idle and NeedsAttention on Blocked from
	 * `pane.report_agent` (`herdr-omp-agent-state`), so `herdr notification show`
	 * would only add a duplicate session-title card. Never spawn it.
	 *
	 * Claiming still returns true so {@link routeTerminalMultiplexerNotification}
	 * does not fall through to OSC 9/99, which Herdr swallows.
	 *
	 * Pane-only detection: without a valid pane id, Herdr does not own delivery
	 * and the existing terminal fallback stays.
	 */
	notifier: {
		tier: "pane",
		send({ env }) {
			const paneId = env.HERDR_PANE_ID?.trim();
			if (!paneId || !HERDR_PANE_ID_PATTERN.test(paneId)) return false;
			return true;
		},
	},
	// Herdr hides the outer terminal (`TERM=xterm-256color`, no `TERM_PROGRAM`),
	// but renders OSC 8 in its own grid and opens links itself on Ctrl+click.
	hyperlinks: "render",
	// The pane VTE is libghostty and suppresses compositing while DEC 2026 is
	// set. Without sync, CUP-diff paints and split write(2) chunks composite as
	// dirty-row patches: the live viewport tears, its top frozen while only the
	// bottom refreshes.
	honorsSynchronizedOutput: true,
	// The pane marker does not prove the client enabled Herdr's experimental
	// Kitty renderer, and leaked outer-terminal identities cannot either.
	imagesRequireOverride: true,
} as const satisfies TerminalMultiplexerModule;
