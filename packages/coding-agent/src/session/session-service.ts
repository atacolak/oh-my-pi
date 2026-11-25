import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "../launch/client";
import { DAEMON_PROCESS_CONTROL_VERSION } from "../launch/protocol";
import { listSessionPublications, sessionAttachEndpoint, type SessionAttachTerminal } from "../launch/session-attach";
import { ensureSessionOwner } from "../launch/session-boot";
import { RpcClient, type RpcCommandBody } from "../modes/rpc/rpc-client";
import type {
	RpcRefreshPreflight,
	RpcResponse,
	RpcRuntimeRestartReceipt,
	RpcSessionState,
} from "../modes/rpc/rpc-types";
import type { CompactMode } from "./compact-modes";
import {
	listSessionIdentityInventory,
	resolveSessionIdentity,
	resolveSessionIdentityReference,
	type SessionIdentityNameConflict,
	type SessionResponsibilityAssignment,
} from "./session-identity";
import { lookupSessionTitle } from "./session-index";
import { loadSessionMessagesReadOnly, readSessionHeader } from "./session-loader";

/** A PID is a selector, never authority to signal a process. */
export type NativeSessionSelector = string | { pid: number };

export interface NativeSessionInfo {
	sessionId: string;
	handle: string | null;
	title: string | null;
	rootAgent: string | null;
	generation: string | null;
	rootAgentCwd?: string;
	assignments: SessionResponsibilityAssignment[];
	idleSleepSeconds?: number | null;
	cwd: string | null;
	sessionFile: string | null;
	pid: number | null;
	startedAt: number | null;
	modifiedAt?: number;
	model: string | null;
	availability: "live" | "offline" | "unavailable";
	state: "working" | "idle" | "sleeping" | "unknown";
	terminal: SessionAttachTerminal | null;
	owner?: RpcRuntimeRestartReceipt;
}

export interface NativeSessionListOptions {
	query?: string;
	liveOnly?: boolean;
	limit?: number;
	offset?: number;
	/** Metadata-only host discovery must borrow live state from existing bridge attachments. */
	probe?: boolean;
	/** Keep every named session plus this many most recently modified unnamed sessions. */
	unnamedLimit?: number;
}

export interface NativeSessionList {
	sessions: NativeSessionInfo[];
	total: number;
	truncated: boolean;
	nextOffset?: number;
	/** Historical name claims in this catalog; no claimant is selected as the owner. */
	conflicts?: SessionIdentityNameConflict[];
	/** Verified live session sockets publishing terminal coordinates across the catalog. */
	attachableSockets?: number;
	unverifiedSockets?: number;
	omittedUnnamed?: number;
}

export interface NativeSessionConnection {
	/** The caller owns this connection; stop() detaches it without stopping the owner. */
	client: RpcClient;
	session: NativeSessionInfo;
	owner: RpcRuntimeRestartReceipt;
}

export type NativeSessionControl = "abort" | "sleep" | "compact" | "restart" | "kill";

export interface NativeSessionControlOptions {
	force?: boolean;
	graceful?: boolean;
	compactBeforeRestart?: boolean;
	mode?: CompactMode;
}

/** Validate the native connection's actual UUID, journal and immutable boot receipt. */
export async function readSessionClientOwner(
	client: RpcClient,
	expected: { sessionId: string; sessionFile: string | null },
	timeoutMs = 2_500,
): Promise<RpcRefreshPreflight> {
	const preflight = await client.getRefreshPreflight(timeoutMs);
	const owner = preflight.restartReceipt;
	if (
		!isRecord(owner) ||
		owner.sessionId !== expected.sessionId ||
		typeof owner.sessionFile !== "string" ||
		!owner.sessionFile ||
		typeof owner.bootId !== "string" ||
		!owner.bootId ||
		(expected.sessionFile !== null && owner.sessionFile !== expected.sessionFile) ||
		preflight.sessionId !== owner.sessionId ||
		preflight.sessionFile !== owner.sessionFile
	) {
		throw new Error("Session socket did not prove the expected native UUID, journal and boot.");
	}
	return preflight;
}

/**
 * Stateless orchestration, not a roster or connection implementation. Journals
 * and the existing SQLite projection own identity; RpcClient owns RPC; the
 * existing broker owns process lifetime. No discovery operation wakes a session.
 */
export class NativeSessionService {
	static readonly #listProbeConcurrency = 32;
	constructor(readonly options: { sessionsRoot?: string; endpointDir?: string; timeoutMs?: number } = {}) {}

	async #entries(): Promise<{ entries: NativeSessionInfo[]; conflicts: SessionIdentityNameConflict[] }> {
		const { records, conflicts } = await listSessionIdentityInventory({ sessionsRoot: this.options.sessionsRoot });
		const entries = new Map<string, NativeSessionInfo>();
		for (const record of records) {
			entries.set(record.sessionId, {
				sessionId: record.sessionId,
				handle: record.actorHandle,
				title: lookupSessionTitle(record.sessionId) ?? null,
				rootAgent: record.rootAgent ?? null,
				generation: record.generation ?? null,
				assignments: record.assignments,
				idleSleepSeconds: record.idleSleepSeconds,
				cwd: record.cwd,
				sessionFile: record.sessionFile,
				pid: null,
				startedAt: null,
				model: null,
				modifiedAt: record.modifiedAt,
				availability: "offline",
				state: "sleeping",
				terminal: null,
			});
		}
		for (const publication of await listSessionPublications(this.options.endpointDir)) {
			const existing = entries.get(publication.sessionId);
			// A stale sidecar never replaces the journal's identity or advertises a live owner.
			if (!publication.live && existing) continue;
			if (existing?.sessionFile && publication.sessionFile !== existing.sessionFile) {
				entries.set(publication.sessionId, { ...existing, availability: "unavailable", state: "unknown" });
				continue;
			}
			entries.set(publication.sessionId, {
				sessionId: publication.sessionId,
				handle: existing?.handle ?? null,
				title: existing?.title ?? null,
				rootAgent: existing?.rootAgent ?? null,
				generation: existing?.generation ?? null,
				assignments: existing?.assignments ?? [],
				idleSleepSeconds: existing?.idleSleepSeconds,
				cwd: existing?.cwd ?? publication.cwd,
				sessionFile: existing?.sessionFile ?? publication.sessionFile,
				pid: publication.live ? publication.pid : null,
				startedAt: publication.startedAt,
				model: publication.agent,
				modifiedAt: existing?.modifiedAt ?? publication.startedAt ?? undefined,
				availability: "unavailable",
				state: "unknown",
				terminal: publication.terminal ?? null,
			});
		}
		return { entries: [...entries.values()], conflicts };
	}

	async #savedProfile(session: NativeSessionInfo): Promise<NativeSessionInfo> {
		if (!session.sessionFile) return session;
		const header = await readSessionHeader(session.sessionFile);
		if (!header || header.id !== session.sessionId)
			throw new Error("Selected session header changed or is unavailable");
		if (header.rootAgentCwd === undefined) return session;
		if (typeof header.rootAgentCwd !== "string" || !path.isAbsolute(header.rootAgentCwd))
			throw new Error("Saved agent definition directory is invalid");
		return { ...session, rootAgentCwd: header.rootAgentCwd };
	}

	async resolve(selector: NativeSessionSelector): Promise<NativeSessionInfo> {
		const { entries } = await this.#entries();
		let matches: NativeSessionInfo[];
		if (typeof selector !== "string") {
			if (!Number.isSafeInteger(selector.pid) || selector.pid <= 0)
				throw new TypeError("pid must be a positive integer");
			matches = entries.filter(entry => entry.pid === selector.pid);
		} else {
			const id = resolveSessionIdentityReference(
				entries.map(entry => ({
					sessionId: entry.sessionId,
					actorHandle: entry.handle,
				})),
				selector,
			);
			return this.#savedProfile(entries.find(entry => entry.sessionId === id)!);
		}
		if (matches.length === 1) return this.#savedProfile(matches[0]!);
		const label = typeof selector === "string" ? selector : `pid:${selector.pid}`;
		if (!matches.length) throw new Error(`No native session matches ${JSON.stringify(label)}`);
		throw new Error(
			`Ambiguous native session ${JSON.stringify(label)}: ${matches
				.slice(0, 8)
				.map(entry => entry.sessionId)
				.join(", ")}`,
		);
	}

	async #connectRecord(session: NativeSessionInfo): Promise<NativeSessionConnection> {
		const client = await RpcClient.connectSessionSocket({
			endpoint: sessionAttachEndpoint(session.sessionId, this.options.endpointDir),
			connectTimeoutMs: this.options.timeoutMs ?? 2_000,
		});
		try {
			const preflight = await readSessionClientOwner(client, session, this.options.timeoutMs ?? 2_500);
			if (!preflight.restartReceipt) throw new Error("Session has no owned boot receipt");
			return { client, session, owner: preflight.restartReceipt };
		} catch (error) {
			await client.stop();
			throw error;
		}
	}

	async connect(selector: NativeSessionSelector, options: { wake?: boolean } = {}): Promise<NativeSessionConnection> {
		let session = await this.resolve(selector);
		if (options.wake && session.availability === "offline") {
			await this.wake(session.sessionId);
			session = await this.resolve(session.sessionId);
		}
		return this.#connectRecord(session);
	}

	async #inspectRecord(session: NativeSessionInfo): Promise<NativeSessionInfo> {
		if (session.availability === "offline") return session;
		let connection: NativeSessionConnection | undefined;
		try {
			connection = await this.#connectRecord(session);
			const state: RpcSessionState = await connection.client.getState(this.options.timeoutMs ?? 2_500);
			if (state.sessionId !== session.sessionId || state.sessionFile !== connection.owner.sessionFile) {
				throw new Error("Session changed while inspecting its state");
			}
			return {
				...session,
				availability: "live",
				state: state.isSettled === true ? "idle" : state.isSettled === false ? "working" : "unknown",
				model: state.model ? `${state.model.provider}/${state.model.id}` : session.model,
				owner: connection.owner,
			};
		} catch {
			return { ...session, availability: "unavailable", state: "unknown" };
		} finally {
			await connection?.client.stop();
		}
	}

	async inspect(selector: NativeSessionSelector): Promise<NativeSessionInfo> {
		return this.#inspectRecord(await this.resolve(selector));
	}

	async list(options: NativeSessionListOptions = {}): Promise<NativeSessionList> {
		if (
			options.limit !== undefined &&
			(!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10_000)
		) {
			throw new TypeError("limit must be an integer between 1 and 10000");
		}
		const offset = options.offset ?? 0;
		if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a nonnegative integer");
		if (
			options.unnamedLimit !== undefined &&
			(!Number.isSafeInteger(options.unnamedLimit) || options.unnamedLimit < 0)
		)
			throw new TypeError("unnamedLimit must be a nonnegative integer");
		const query = options.query?.trim().toLowerCase();
		const { entries: allEntries, conflicts } = await this.#entries();
		const entries = allEntries.filter(
			entry =>
				!query ||
				[entry.sessionId, entry.handle, entry.title, entry.cwd, entry.rootAgent, entry.model].some(value =>
					value?.toLowerCase().includes(query),
				),
		);
		const recentFirst = (left: NativeSessionInfo, right: NativeSessionInfo) =>
			(right.modifiedAt ?? right.startedAt ?? 0) - (left.modifiedAt ?? left.startedAt ?? 0) ||
			right.sessionId.localeCompare(left.sessionId);
		const select = (rows: NativeSessionInfo[]) =>
			options.unnamedLimit === undefined
				? rows
				: [
						...rows.filter(entry => entry.handle !== null).sort((a, b) => a.handle!.localeCompare(b.handle!)),
						...rows
							.filter(entry => entry.handle === null)
							.sort(recentFirst)
							.slice(0, options.unnamedLimit),
					];
		const selected = select(entries);
		// Health-check only displayed records and published owners, never every
		// archived session. The latter also supply the catalog-wide socket count.
		const candidates = new Map(selected.map(entry => [entry.sessionId, entry]));
		if (options.probe !== false)
			for (const entry of allEntries) if (entry.pid !== null) candidates.set(entry.sessionId, entry);
		const inspected = new Map<string, NativeSessionInfo>();
		const pending = [...candidates.values()];
		for (let start = 0; start < pending.length; start += NativeSessionService.#listProbeConcurrency) {
			const batch = pending.slice(start, start + NativeSessionService.#listProbeConcurrency);
			const results =
				options.probe === false ? batch : await Promise.all(batch.map(entry => this.#inspectRecord(entry)));
			for (const entry of results) inspected.set(entry.sessionId, entry);
		}
		const matched = entries
			.map(entry => inspected.get(entry.sessionId) ?? entry)
			.filter(entry => !options.liveOnly || entry.availability === "live");
		const displayed = select(matched);
		if (options.unnamedLimit === undefined) {
			const rank = { live: 0, offline: 1, unavailable: 2 };
			displayed.sort(
				(left, right) => rank[left.availability] - rank[right.availability] || recentFirst(left, right),
			);
		}
		const page = displayed.slice(offset, options.limit === undefined ? undefined : offset + options.limit);
		const truncated = offset + page.length < displayed.length;
		const checked = [...inspected.values()];
		return {
			sessions: page,
			total: matched.length,
			truncated,
			...(conflicts.length ? { conflicts } : {}),
			...(truncated ? { nextOffset: offset + page.length } : {}),
			...(options.probe === false
				? {}
				: {
						attachableSockets: checked.filter(entry => entry.availability === "live" && entry.terminal !== null)
							.length,
						unverifiedSockets: checked.filter(entry => entry.pid !== null && entry.availability !== "live")
							.length,
					}),
			...(options.unnamedLimit === undefined ? {} : { omittedUnnamed: matched.length - displayed.length }),
		};
	}

	async wake(
		selector: NativeSessionSelector,
		expected: { expectedSessionFile?: string } = {},
	): Promise<NativeSessionInfo & { revived: boolean }> {
		const selected = await this.resolve(selector);
		if (expected.expectedSessionFile !== undefined && selected.sessionFile !== expected.expectedSessionFile)
			throw new Error("Selected session journal changed before wake");
		const durable = await resolveSessionIdentity(selected.sessionId, { sessionsRoot: this.options.sessionsRoot });
		if (selected.sessionFile !== durable.sessionFile) throw new Error("Selected session journal changed before wake");
		const owner = await ensureSessionOwner(durable, this.options);
		const inspected = await this.inspect(selected.sessionId);
		if (inspected.availability !== "live") throw new Error("Woken session did not prove its native owner");
		return { ...inspected, revived: owner.revived };
	}

	async read(
		selector: NativeSessionSelector,
		options: { limit?: number } = {},
	): Promise<{
		session: NativeSessionInfo;
		messages: AgentMessage[];
		total: number;
		truncated: boolean;
	}> {
		const session = await this.resolve(selector);
		if (!session.sessionFile) throw new Error("Session has no materialized native journal");
		const limit = options.limit ?? 40;
		if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
		const messages = await loadSessionMessagesReadOnly(session.sessionFile);
		return { session, messages: messages.slice(-limit), total: messages.length, truncated: messages.length > limit };
	}

	async request(selector: NativeSessionSelector, command: RpcCommandBody, timeoutMs?: number): Promise<RpcResponse> {
		const { client } = await this.connect(selector);
		try {
			return await client.send(command, timeoutMs);
		} finally {
			await client.stop();
		}
	}

	async control(
		selector: NativeSessionSelector,
		action: NativeSessionControl,
		options: NativeSessionControlOptions = {},
	): Promise<unknown> {
		if (options.graceful && action !== "restart") throw new TypeError("Graceful control requires restart");
		if (action === "sleep") {
			const session = await this.resolve(selector);
			if (session.availability === "offline")
				return { scheduled: false, alreadySleeping: true, sessionId: session.sessionId };
		}
		const { client, session, owner } = await this.connect(selector);
		try {
			const expected = {
				expectedSessionId: owner.sessionId,
				expectedSessionFile: owner.sessionFile,
				expectedBootId: owner.bootId,
			};
			if (action === "sleep")
				return await client.exitSession({ ...expected, ...(options.force ? { force: true } : {}) });
			if (action === "restart")
				return await client.upgradeRuntime({
					...expected,
					refresh: true,
					whenIdle: true,
					...(options.graceful ? { graceful: true } : {}),
					...(options.force ? { force: true } : {}),
					...(options.compactBeforeRestart ? { compactBeforeRestart: true } : {}),
				});
			if (action === "kill") {
				if (!session.terminal || session.pid === null)
					throw new Error("Native broker-owned process control is unavailable for this session");
				const broker = await createDaemonBrokerClient(session.terminal.projectDir, { existingOnly: true });
				try {
					const capability = await broker.request({ op: "ping" });
					if (capability.op !== "ping" || capability.processControlVersion !== DAEMON_PROCESS_CONTROL_VERSION) {
						throw new Error("Running broker lacks PID-fenced process control; no process was signalled");
					}
					const current = await readSessionClientOwner(client, session);
					if (current.restartReceipt?.bootId !== owner.bootId)
						throw new Error("Session owner changed before process control");
					const stopped = await broker.request({
						op: "stop",
						name: session.terminal.name,
						id: session.terminal.id,
						expectedPid: session.pid,
						requireProcessHandle: true,
						timeoutMs: 0,
					});
					if (
						stopped.op !== "stop" ||
						stopped.daemon.id !== session.terminal.id ||
						!["exited", "failed"].includes(stopped.daemon.state)
					)
						throw new Error("Process exit was not confirmed");
					return { stopped: true, sessionId: session.sessionId, pid: session.pid, bootId: owner.bootId };
				} finally {
					broker.close();
				}
			}
			const response = await client.send(
				{
					type: "session_control",
					action,
					...expected,
					...(action === "compact" ? { mode: options.mode ?? "snapcompact" } : {}),
				},
				action === "compact" ? 120_000 : undefined,
			);
			if (!response.success) throw new Error(response.error);
			return "data" in response ? response.data : { completed: true, action, sessionId: session.sessionId };
		} finally {
			await client.stop();
		}
	}
}
