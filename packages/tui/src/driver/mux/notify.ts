/**
 * Notification delivery inside multiplexers that would swallow the terminal's
 * own sequence.
 *
 * Notifiers are tried innermost target first: Herdr's pane reports its own
 * Idle/Blocked toast, a surface notifier addresses the containing app surface
 * through its CLI (cmux), and in-band notifiers rewrite the terminal sequence
 * (tmux, then Zellij). A notifier that cannot deliver leaves the notification
 * to the next one and finally to the terminal sequence.
 */
import type { TerminalNotification } from "../notify";
import { type Env, hasMultiplexerSession, type MultiplexerId } from "./detect";
import { wrapTmuxPassthrough } from "./tmux";

/** One notification offered to the multiplexer notifiers. */
export interface MultiplexerNotificationRequest {
	readonly message: string | TerminalNotification;
	readonly env: Env;
	/** The terminal's OSC notification, or null when the terminal notifies with a bare BEL. */
	readonly sequence: string | null;
	/** Write through the terminal's ordered output path. */
	write(data: string): void;
}

/** Title for CLI notifications that carry none of their own. */
const DEFAULT_TITLE = "omp";

function titleAndBody(message: string | TerminalNotification): { title: string; body: string } {
	if (typeof message === "string") return { title: DEFAULT_TITLE, body: message };
	return { title: message.title?.trim() || DEFAULT_TITLE, body: message.body ?? "" };
}

/** Start a notifier CLI without waiting for or pinning it; false when it cannot be spawned. */
function spawnNotifier(cmd: string[]): boolean {
	try {
		Bun.spawn({ cmd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
	} catch {
		return false;
	}
	return true;
}

const HERDR_PANE_ID = /^[0-9A-Za-z:_-]{1,64}$/u;
const CMUX_SURFACE_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

const NOTIFIERS: ReadonlyArray<{
	readonly id: MultiplexerId;
	send(request: MultiplexerNotificationRequest): boolean;
}> = [
	{
		// Herdr already toasts Finished on Idle and NeedsAttention on Blocked from its pane's
		// agent-state report, so `herdr notification show` only adds a duplicate session-title
		// card. Claiming still suppresses the OSC 9/99 sequence Herdr swallows.
		id: "herdr",
		send({ env }) {
			const pane = env.HERDR_PANE_ID?.trim();
			if (!pane || !HERDR_PANE_ID.test(pane)) return false;
			return true;
		},
	},
	{
		// Only the injected surface UUID identifies the pane that should receive it.
		id: "cmux",
		send({ message, env }) {
			const surface = env.CMUX_SURFACE_ID?.trim();
			if (!surface || !CMUX_SURFACE_ID.test(surface)) return false;
			const { title, body } = titleAndBody(message);
			return spawnNotifier(["cmux", "notify", "--surface", surface, "--title", title, "--body", body]);
		},
	},
	{
		// tmux swallows bare OSCs: passthrough keeps the toast and a BEL flags the pane. One write
		// keeps a concurrent frame from landing between the two. Bell notifications already flag it.
		id: "tmux",
		send({ sequence, write }) {
			if (sequence === null) return false;
			write(`${wrapTmuxPassthrough(sequence)}\x07`);
			return true;
		},
	},
	{
		// Zellij drops OSCs and has no passthrough; a bare BEL raises its bell flag.
		id: "zellij",
		send({ sequence, write }) {
			if (sequence === null) return false;
			write(`${sequence}\x07`);
			return true;
		},
	},
];

/** Offer `request` to every active session's notifier, innermost first; true when one delivered it. */
export function routeMultiplexerNotification(request: MultiplexerNotificationRequest): boolean {
	return NOTIFIERS.some(notifier => hasMultiplexerSession(notifier.id, request.env) && notifier.send(request));
}
