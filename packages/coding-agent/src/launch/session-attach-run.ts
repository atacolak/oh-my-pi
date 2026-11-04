import { Snowflake } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, type DaemonBrokerClient, requireTerminalProtocol } from "./client";
import { requestSessionTerminalRefresh, type SessionAttachTerminal } from "./session-attach";
import { runTerminalMirror, type TerminalMirrorOptions } from "./terminal-mirror";

/**
 * A live attach borrows this process's terminal until the owner exits or the
 * local terminal goes away; nothing here owns or disposes the session.
 */
export interface LiveSessionAttachOptions {
	/** The broker connection to stream from; defaults to this project's broker. */
	client?: DaemonBrokerClient;
	/** Endpoint directory that publishes the session's terminal refresh. */
	endpointDir?: string;
	/** Bound on the owner's `terminal_refreshed` reply. */
	timeoutMs?: number;
	/** Local terminal seams, for tests and callers that already own a terminal. */
	mirror?: Partial<Omit<TerminalMirrorOptions, "client" | "name" | "id" | "subscriptionId" | "refresh">>;
}

/**
 * Reconnect this process to the live owner of `sessionId`: mirror the owner's
 * PTY into the local terminal and ask the owner to repaint for the new
 * subscriber. A refused refresh detaches only this mirror and rejects; the
 * owner keeps running.
 */
export async function runLiveSessionAttach(
	sessionId: string,
	terminal: SessionAttachTerminal,
	options: LiveSessionAttachOptions = {},
): Promise<number> {
	const client = options.client ?? (await createDaemonBrokerClient(terminal.projectDir));
	try {
		await requireTerminalProtocol(client);
	} catch (error) {
		client.close();
		throw error;
	}

	const result = await runTerminalMirror({
		...options.mirror,
		client,
		name: terminal.name,
		id: terminal.id,
		subscriptionId: `mirror-${Snowflake.next()}`,
		refresh: () =>
			requestSessionTerminalRefresh(sessionId, terminal.id, {
				endpointDir: options.endpointDir,
				timeoutMs: options.timeoutMs,
			}),
	});
	return result.detached ? 0 : (result.exitCode ?? 1);
}
