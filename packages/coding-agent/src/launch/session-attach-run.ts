import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { readSessionInfo } from "../session/session-listing";
import { createDaemonBrokerClient, type DaemonBrokerClient, requireTerminalProtocol } from "./client";
import {
	decideSessionAttach,
	probeSessionAttach,
	requestSessionTerminalRefresh,
	type SessionAttachTerminal,
	type SessionAttachProbe,
} from "./session-attach";
import { runTerminalMirror, type TerminalMirrorOptions, UNVERIFIED_EXIT_REASON } from "./terminal-mirror";

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
	sessionPath?: string;
	/** Additional checks on the fenced owner observation before enabling input. */
	validateOwner?: (probe: SessionAttachProbe) => Promise<void>;
	/** Local terminal seams, for tests and callers that already own a terminal. */
	mirror?: Partial<Omit<TerminalMirrorOptions, "client" | "name" | "id" | "subscriptionId" | "refresh">>;
}

/** Recheck the exact owner immediately before admitting terminal input. */
export async function verifyLiveSessionOwner(
	sessionId: string,
	terminal: SessionAttachTerminal,
	options: LiveSessionAttachOptions,
): Promise<void> {
	if (options.sessionPath === undefined) {
		if (options.validateOwner) throw new Error("Owner validation requires the exact session path");
		return;
	}
	const probe = await probeSessionAttach(sessionId, {
		endpointDir: options.endpointDir,
		timeoutMs: options.timeoutMs,
		sessionPath: options.sessionPath,
		includeState: options.validateOwner !== undefined,
	});
	if (
		probe.status !== "live" ||
		probe.terminal?.projectDir !== terminal.projectDir ||
		probe.terminal.name !== terminal.name ||
		probe.terminal.id !== terminal.id
	)
		throw new Error("The exact live owner changed before terminal attachment");
	await options.validateOwner?.(probe);
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
	const client = options.client ?? (await createDaemonBrokerClient(terminal.projectDir, { existingOnly: true }));
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
		inputAfterRefresh: options.sessionPath !== undefined || options.validateOwner !== undefined,
		refresh: async () => {
			await verifyLiveSessionOwner(sessionId, terminal, options);
			await requestSessionTerminalRefresh(sessionId, terminal.id, {
				endpointDir: options.endpointDir,
				timeoutMs: options.timeoutMs,
			});
		},
	});
	if (result.reason === UNVERIFIED_EXIT_REASON)
		throw new Error("The session owner exited before attachment was verified");
	return result.detached ? 0 : (result.exitCode ?? 1);
}

export async function runAttachOnly(sessionPath: string, options: LiveSessionAttachOptions = {}): Promise<void> {
	try {
		if (!path.isAbsolute(sessionPath)) throw new Error("--attach requires an absolute transcript path");
		const canonicalPath = await fs.realpath(sessionPath);
		const session = await readSessionInfo(canonicalPath);
		if (!session) throw new Error(`Not a readable session transcript: ${sessionPath}`);
		const probe = await probeSessionAttach(session.id, {
			endpointDir: options.endpointDir,
			timeoutMs: options.timeoutMs,
			sessionPath: canonicalPath,
		});
		const decision = decideSessionAttach(probe);
		if (decision.kind === "cold") throw new Error(`Session "${session.id}" has no live owner`);
		if (decision.kind === "refuse") throw new Error(`Session "${session.id}" attach refused: ${decision.code}`);
		process.exitCode = await runLiveSessionAttach(session.id, decision.terminal, {
			...options,
			sessionPath: canonicalPath,
		});
	} catch (error) {
		process.stderr.write(
			`Error: --attach refused: ${error instanceof Error ? error.message : String(error)}; no session or owner created.\n`,
		);
		process.exitCode = 2;
	}
}
