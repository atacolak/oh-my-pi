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
import type { AgentMailReadResult, AgentMailSendParams, AgentMailSendResult } from "./session-mail";
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

	/** The attached sender owner attests provenance, wakes the exact peer and returns admission—not inference completion. */
	sendMail(params: AgentMailSendParams): Promise<AgentMailSendResult> {
		return this.#request({ type: "agent_mail_send", ...params });
	}

	readMail(options: { threadId?: string; limit?: number } = {}): Promise<AgentMailReadResult> {
		return this.#request({ type: "agent_mail_read", ...options });
	}

	observe(listener: (event: AgentSessionEvent) => void): () => void {
		return this.#transport.observe(event => {
			if (isAgentSessionEvent(event)) listener(event);
		});
	}
}
