import { isAgentSessionEvent, isRpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { RpcCommandBody } from "../modes/rpc/rpc-client";
import type {
	RpcSessionState,
	RpcRefreshPreflight,
	RpcRuntimeRestartReceipt,
	RpcSessionControlResult,
	RpcExitSessionResult,
	RpcUpgradeRuntimeResult,
} from "../modes/rpc/rpc-types";
import type { AgentSessionEvent } from "./agent-session-events";
import type {
	AgentMailContact,
	AgentMailReadOptions,
	AgentMailReadResult,
	AgentMailSendParams,
	AgentMailSendResult,
} from "./session-mail";
import type { CompactMode } from "./compact-modes";
import type { NativeSessionInfo, NativeSessionList, NativeSessionListOptions } from "./session-service";
import type { SessionIdentityPatch, SessionIdentityRecord } from "./session-identity";

/**
 * Supplied by the authenticated host's existing exact-session attachment.
 * This module uses only Node-compatible wire guards at runtime. It never
 * connects, scans journals, launches a subprocess or stores a session roster.
 */
export interface NativeSessionApiTransport {
	/** The existing host owns framing and correlation; the SDK narrows parsed wire values. */
	request(command: RpcCommandBody): Promise<unknown>;
	observe(listener: (event: unknown) => void): () => void;
}

export class NativeSessionApiError extends Error {
	readonly code: string | undefined;
	constructor(message: string, code?: string) {
		super(message);
		this.name = "NativeSessionApiError";
		this.code = code;
	}
}

export class NativeSessionApi {
	readonly #transport: NativeSessionApiTransport;
	constructor(transport: NativeSessionApiTransport) {
		this.#transport = transport;
	}

	async #request<T>(command: RpcCommandBody): Promise<T> {
		const response = await this.#transport.request(command);
		if (!isRpcResponse(response) || response.command !== command.type) {
			throw new NativeSessionApiError(
				"Native owner returned a mismatched or malformed response",
				"invalid_native_response",
			);
		}
		if (!response.success) throw new NativeSessionApiError(response.error, response.code);
		if (!("data" in response)) {
			throw new NativeSessionApiError(
				"Native owner returned a mismatched or missing response",
				"invalid_native_response",
			);
		}
		return response.data as T;
	}

	/** Metadata only. Existing bridge attachments own live state; this never wakes or reconnects peers. */
	catalog(options: Pick<NativeSessionListOptions, "query" | "limit" | "offset"> = {}): Promise<NativeSessionList> {
		return this.#request({ type: "list_sessions", ...options });
	}

	resolve(reference: string): Promise<NativeSessionInfo> {
		return this.#request({ type: "resolve_session", reference });
	}
	/** Inspect the actual attached owner's prompt, tools, queues and runtime state without waking peers. */
	state(): Promise<RpcSessionState> {
		return this.#request({ type: "get_state" });
	}

	preflight(): Promise<RpcRefreshPreflight> {
		return this.#request({ type: "get_refresh_preflight" });
	}

	/** Name/rename this conversation; a name is not a profile, model or permission grant. */
	setIdentity(
		owner: Pick<RpcRuntimeRestartReceipt, "sessionId" | "sessionFile">,
		patch: SessionIdentityPatch,
	): Promise<SessionIdentityRecord> {
		return this.#request({
			type: "set_session_identity",
			expectedSessionId: owner.sessionId,
			expectedSessionFile: owner.sessionFile,
			patch,
		});
	}

	/** Explicit wake of the catalog-selected conversation; no create/new-session fallback. */
	wake(target: { sessionId: string; sessionFile: string }): Promise<NativeSessionInfo & { revived: boolean }> {
		return this.#request({
			type: "wake_session",
			expectedSessionId: target.sessionId,
			expectedSessionFile: target.sessionFile,
		});
	}

	/** Control this transport's exact attachment, not another freshly opened SDK connection. */
	control(
		owner: RpcRuntimeRestartReceipt,
		action: "abort" | "compact" | "sleep" | "restart",
		options: {
			mode?: CompactMode;
			force?: boolean;
			graceful?: boolean;
			compactBeforeRestart?: boolean;
		} = {},
	): Promise<RpcSessionControlResult | RpcExitSessionResult | RpcUpgradeRuntimeResult> {
		if (options.graceful && action !== "restart")
			return Promise.reject(
				new NativeSessionApiError("Graceful control requires restart", "invalid_native_request"),
			);
		const expected = {
			expectedSessionId: owner.sessionId,
			expectedSessionFile: owner.sessionFile,
			expectedBootId: owner.bootId,
		};
		if (action === "sleep")
			return this.#request({ type: "exit_session", ...expected, ...(options.force ? { force: true } : {}) });
		if (action === "restart")
			return this.#request({
				type: "upgrade_runtime",
				...expected,
				refresh: true,
				whenIdle: true,
				...(options.graceful ? { graceful: true } : {}),
				...(options.force ? { force: true } : {}),
				...(options.compactBeforeRestart ? { compactBeforeRestart: true } : {}),
			});
		return this.#request({
			type: "session_control",
			action,
			...expected,
			...(action === "compact" ? { mode: options.mode ?? "snapcompact" } : {}),
		});
	}

	/** Deposit quiet mail in the recipient's journal; never wakes, steers or queues input. */
	sendMail(params: AgentMailSendParams): Promise<AgentMailSendResult> {
		return this.#request({
			type: "agent_mail_post_consented",
			to: params.to,
			message: params.message,
			...(params.threadId === undefined ? {} : { threadId: params.threadId }),
			...(params.replyTo === undefined ? {} : { replyTo: params.replyTo }),
		});
	}

	/** Deliberate read of this owner's mail; `folder` defaults to the inbox, never requests. */
	readMail(options: AgentMailReadOptions = {}): Promise<AgentMailReadResult> {
		return this.#request({
			type: "agent_mail_list",
			...(options.threadId === undefined ? {} : { threadId: options.threadId }),
			...(options.limit === undefined ? {} : { limit: options.limit }),
			...(options.folder === undefined ? {} : { folder: options.folder }),
			...(options.before === undefined ? {} : { before: options.before }),
		});
	}

	/** Revoke or block contact. A terminal consent decision, not this RPC, authorizes a new sender. */
	setMailContact(peer: string, rule: "block" | "reset"): Promise<AgentMailContact> {
		if (rule !== "block" && rule !== "reset")
			return Promise.reject(new NativeSessionApiError("Mail consent requires operator review.", "mail_operator_required"));
		return this.#request({ type: "agent_mail_restrict", peer, rule });
	}

	observe(listener: (event: AgentSessionEvent) => void): () => void {
		return this.#transport.observe(event => {
			if (isAgentSessionEvent(event)) listener(event);
		});
	}
}
