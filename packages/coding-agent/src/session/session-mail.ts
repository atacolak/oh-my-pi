/**
 * Pull-only mail. The recipient journal owns messages and contact rules.
 * A live owner verifies the sender over its native socket. For a sleeping
 * recipient, the sender owner deposits under the journal's exclusive lease.
 * Neither path admits conversation input or starts an owner process.
 */
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import { sessionAttachEndpoint } from "../launch/session-attach";
import { RpcClient } from "../modes/rpc/rpc-client";
import { SessionManager } from "./session-manager";
import { NativeSessionService, type NativeSessionInfo } from "./session-service";

/** Journal `custom` entry carrying one mail outcome; never enters model context. */
export const AGENT_MAIL_CUSTOM_TYPE = "omp.agent_mail";

/** Bounded reads: default and maximum records one read returns. */
const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 100;
/** Bounded discovery: default and maximum peer entries one listing returns. */
const DEFAULT_DISCOVERY_LIMIT = 25;
const MAX_DISCOVERY_LIMIT = 100;
/** Envelope bounds; peer-controlled strings are capped before any rendering. */
const MAX_BODY_CHARS = 64 * 1024;
const MAX_ID_CHARS = 256;
/** A send capability outlives its command only briefly; it is single-use. */
const CAPABILITY_TTL_MS = 30_000;
/** Discovery handshake bounds. */
const DISCOVERY_RESPONSE_TIMEOUT_MS = 2_500;

/** Native addressability of one session end at mail time. */
export interface AgentMailEndpointIdentity {
	/** Canonical session UUID; stable across renames. */
	sessionId: string;
	/** Actor handle at capture time, or null when unnamed. A label, never a role or permission. */
	handle: string | null;
	/** Provider/model string of the session at capture time, when known. Distinct from any agent profile. */
	model: string | null;
}

/** Exact native owner incarnation; runtime generation is not a process identity. */
export interface AgentMailIncarnation {
	sessionId: string;
	sessionFile: string;
	bootId: string;
}

/** A saved journal has no recipient process incarnation while asleep. */
export type AgentMailTarget = Omit<AgentMailIncarnation, "bootId"> & { bootId: string | null };
export type AgentMailFolder = "inbox" | "requests";
export interface AgentMailContact {
	peer: string;
	rule: "allow" | "block" | "reset";
}
export interface AgentMailReadOptions {
	threadId?: string;
	limit?: number;
	folder?: AgentMailFolder;
	/** Exclusive message ID from the preceding page in this folder/thread. */
	before?: string;
}

/** The complete mail envelope a capability is bound to. */
export interface AgentMailEnvelope {
	recipientSessionId: string;
	recipientSessionFile: string;
	recipientBootId: string;
	/** Minted by the sending owner, bound to the proof before any delivery. */
	messageId: string;
	message: string;
	threadId?: string;
	replyTo?: string;
	delivery: "inbox";
	sentAt: number;
}

/** Owner send parameters; `to` is a canonical UUID, unique id prefix, or actor handle. */
export interface AgentMailSendParams {
	to: string;
	message: string;
	threadId?: string;
	replyTo?: string;
}

/**
 * Recipient-owned directional rule for one sender plus the journal revision it
 * reflects. `unknown` is default deny, never consent; `revision` is the id of
 * the newest matching contact entry, or null when none exists.
 */
export interface AgentMailPolicy {
	rule: "allow" | "block" | "unknown";
	revision: string | null;
}

/** Explicit operator decision for one otherwise-refused send; anything else fails closed. */
export type AgentMailApproval = "once" | "always" | "cancel";

/**
 * The exact candidate mail put to a trusted local operator. It never crosses
 * the wire: the peer only ever sees a body-free policy question.
 */
export interface AgentMailApprovalRequest {
	/** The exact recipient selector the local operator typed, before resolution. */
	reference: string;
	sender: AgentMailEndpointIdentity;
	recipient: AgentMailEndpointIdentity;
	message: string;
	messageId: string;
}

/** A granted operator decision bound to the recipient policy revision it was shown against. */
type AgentMailConsent = { approval: "once" | "always"; policyRevision: string | null };

/** The immutable candidate envelope before the recipient incarnation is known. */
type MailPost = Omit<AgentMailEnvelope, "recipientSessionFile" | "recipientBootId">;

/** One consent consultation: either a definite refusal, or the grant (if any) to bind into the proof. */
type ConsentOutcome =
	| { status: "refused"; refused: AgentMailSendResult }
	| { status: "consented"; consent?: AgentMailConsent };

/** Send options. `approve` is supplied only by a trusted local TUI scope, never by a wire payload. */
export interface AgentMailSendOptions {
	responseTimeoutMs?: number;
	approve?: (request: AgentMailApprovalRequest) => Promise<AgentMailApproval>;
	signal?: AbortSignal;
}

/** One delivered mail record with full provenance, as journaled and served by the owner. */
export interface AgentMailRecord {
	messageId: string;
	threadId: string;
	replyTo?: string;
	sender: AgentMailEndpointIdentity;
	recipient: AgentMailEndpointIdentity;
	source: AgentMailIncarnation;
	target: AgentMailTarget;
	body: string;
	sentAt: number;
	receivedAt: number;
	delivery: "inbox" | "queue" | "steer";
	/** Historical receipts can describe input admission; new mail is only stored. */
	admission: "stored" | "admitted" | "queued" | "steering";
	folder?: AgentMailFolder;
}

/** Stored in the selected journal; not a read or execution receipt. */
export interface AgentMailReceipt {
	messageId: string;
	threadId: string;
	admission: "stored";
	recipient: AgentMailEndpointIdentity;
	target: AgentMailTarget;
}

/** Bounded inbox read derived from the current journal. */
export interface AgentMailReadResult {
	/** Newest-last records actually returned. */
	messages: AgentMailRecord[];
	/** Total admitted records matching the read (thread) filter. */
	total: number;
	/** True when an older page exists in this folder/thread. */
	truncated: boolean;
	nextBefore?: string;
}

/** One peer session as discovery reports it. */
export interface AgentMailPeerSession {
	/** Canonical session UUID; stable across renames. */
	sessionId: string;
	/** Mutable actor handle, or null when unnamed. A label, never a role or permission. */
	handle: string | null;
	/** `live`: handshake answered with this exact id. `offline`: saved, no live owner. `unavailable`: published but not verifiably reachable/compatible. */
	availability: "live" | "offline" | "unavailable";
	pid: number | null;
	startedAt: number | null;
	cwd: string | null;
	sessionFile: string | null;
	/** Provider/model string of the live owner, when known. */
	model: string | null;
}

/** Bounded peer discovery result. */
export interface AgentMailDiscoveryResult {
	sessions: AgentMailPeerSession[];
	total: number;
	truncated: boolean;
}

/**
 * Verdict of one send-capability verification: validity plus owner-attested
 * identity when valid, the refusal reason when not. Reveals nothing else.
 */
export interface AgentMailVerification {
	valid: boolean;
	reason?: string;
	sender?: AgentMailEndpointIdentity;
	source?: AgentMailIncarnation;
	target?: AgentMailIncarnation;
	/** Operator decision this capability was issued under; absent when an existing grant covered it. */
	approval?: "once" | "always";
	/** Recipient policy revision the approval was bound to; present exactly when `approval` is. */
	policyRevision?: string | null;
}

/** Owner send outcome. `unknown` means the mail's fate could not be determined; it is never resent automatically. */
export type AgentMailSendResult =
	| { status: "accepted"; receipt: AgentMailReceipt; target: string }
	| { status: "refused"; error: string; code?: string }
	| { status: "unknown"; error: string };

/** The mail's destination is not the session that was asked to receive it. */
export class AgentMailTargetMismatchError extends Error {
	constructor(
		readonly expectedSessionId: string,
		readonly ownerSessionId: string,
	) {
		super(`Mail addressed to session "${expectedSessionId}" reached owner "${ownerSessionId}"; refusing to deliver.`);
		this.name = "AgentMailTargetMismatchError";
	}
}

type JournalEnvelope = Omit<AgentMailEnvelope, "recipientBootId" | "delivery"> & {
	recipientBootId: string | null;
	delivery: AgentMailRecord["delivery"];
};

/** Durably-journaled mail outcome; `failed` records never claim delivery. */
interface AgentMailJournalEntry {
	version: 1;
	state: "pending" | "stored" | "admitted" | "sent" | "failed";
	mail?: AgentMailRecord;
	error?: string;
	/** Offered outgoing envelope, not a delivery claim or store-and-forward queue. */
	outgoing?: {
		envelope: JournalEnvelope;
		source: AgentMailIncarnation;
		target: AgentMailTarget;
		sender: AgentMailEndpointIdentity;
	};
}

/** In-flight send capability: single-use, expiring, bound to one envelope and both incarnations. */
interface AgentMailSendCapability {
	envelope: AgentMailEnvelope;
	source: AgentMailIncarnation;
	target: AgentMailIncarnation;
	sender: AgentMailEndpointIdentity;
	/** Operator decision and bounded policy revision, or absent when an established grant covered it. */
	consent?: AgentMailConsent;
	expiresAt: number;
	consumed: boolean;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Strict envelope validation shared by the wire surface, the sender and the
 * recipient. Returns the first problem, or undefined when the envelope is well
 * formed.
 */
export function agentMailEnvelopeError(value: unknown): string | undefined {
	return envelopeError(value, false);
}

function envelopeError(value: unknown, historical: boolean): string | undefined {
	if (isRecord(value)) {
		if (typeof value.recipientSessionFile !== "string" || !path.isAbsolute(value.recipientSessionFile))
			return "recipientSessionFile must be the canonical absolute journal";
		if (
			!(historical && value.recipientBootId === null) &&
			(typeof value.recipientBootId !== "string" || !value.recipientBootId)
		)
			return "recipientBootId must identify the native owner boot";
		if (!isMailReference(value.messageId)) return "messageId must be a valid owner-issued reference";
	}
	if (!isRecord(value)) return "mail envelope must be an object";
	if (typeof value.recipientSessionId !== "string" || !value.recipientSessionId.trim())
		return "recipientSessionId must be a non-empty string";
	if (typeof value.message !== "string" || !value.message.trim()) return "message must be a non-empty string";
	if (value.message.length > MAX_BODY_CHARS) return `message exceeds ${MAX_BODY_CHARS} characters`;
	if (value.delivery !== "inbox" && !(historical && (value.delivery === "steer" || value.delivery === "queue")))
		return "Only quiet inbox delivery is supported.";
	if (!isIntegerInRange(value.sentAt, 1, Number.MAX_SAFE_INTEGER))
		return "sentAt must be an integer epoch-millisecond timestamp";
	if (value.threadId !== undefined) {
		if (!isMailReference(value.threadId)) return "threadId must be a valid bounded reference";
	}
	if (value.replyTo !== undefined) {
		if (!isMailReference(value.replyTo)) return "replyTo must be a valid bounded reference";
		if (value.threadId === undefined) return "replyTo must name the thread it answers";
	}
	return undefined;
}

function isMailReference(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_ID_CHARS && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isEndpointIdentity(value: unknown): value is AgentMailEndpointIdentity {
	if (!isRecord(value)) return false;
	return (
		typeof value.sessionId === "string" &&
		value.sessionId.length > 0 &&
		(value.handle === null || typeof value.handle === "string") &&
		(value.model === null || typeof value.model === "string")
	);
}

function isMailTarget(value: unknown): value is AgentMailTarget {
	if (!isRecord(value)) return false;
	return (
		typeof value.sessionId === "string" &&
		value.sessionId.length > 0 &&
		typeof value.sessionFile === "string" &&
		path.isAbsolute(value.sessionFile) &&
		(value.bootId === null || (typeof value.bootId === "string" && value.bootId.length > 0))
	);
}

export function isAgentMailIncarnation(value: unknown): value is AgentMailIncarnation {
	return isMailTarget(value) && value.bootId !== null;
}

function isAgentMailRecord(value: unknown): value is AgentMailRecord {
	if (!isRecord(value)) return false;
	if (!isMailReference(value.messageId) || !isMailReference(value.threadId)) return false;
	if (value.replyTo !== undefined && !isMailReference(value.replyTo)) return false;
	if (!isEndpointIdentity(value.sender) || !isEndpointIdentity(value.recipient)) return false;
	if (!isAgentMailIncarnation(value.source) || !isMailTarget(value.target)) return false;
	if (value.source.sessionId !== value.sender.sessionId || value.target.sessionId !== value.recipient.sessionId)
		return false;
	if (typeof value.body !== "string") return false;
	if (!isIntegerInRange(value.sentAt, 1, Number.MAX_SAFE_INTEGER)) return false;
	if (!isIntegerInRange(value.receivedAt, 1, Number.MAX_SAFE_INTEGER)) return false;
	if (value.delivery === "inbox")
		return (
			value.admission === "stored" &&
			(value.folder === undefined || value.folder === "requests" || value.folder === "inbox")
		);
	if (value.delivery !== "queue" && value.delivery !== "steer") return false;
	if (value.admission !== "admitted" && value.admission !== "queued" && value.admission !== "steering") return false;
	return true;
}

/** Strictly parse one journaled mail entry; malformed claims are skipped, never trusted. */
function parseAgentMailJournalEntry(value: unknown): AgentMailJournalEntry | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== 1) return undefined;
	if (value.state === "pending") {
		const offered = value.outgoing;
		if (
			!isRecord(offered) ||
			envelopeError(offered.envelope, true) !== undefined ||
			!isAgentMailIncarnation(offered.source) ||
			!isMailTarget(offered.target) ||
			!isEndpointIdentity(offered.sender)
		)
			return undefined;
		const envelope = offered.envelope as JournalEnvelope;
		if (
			offered.sender.sessionId !== offered.source.sessionId ||
			envelope.recipientSessionId !== offered.target.sessionId ||
			envelope.recipientSessionFile !== offered.target.sessionFile ||
			envelope.recipientBootId !== offered.target.bootId
		)
			return undefined;
		return {
			version: 1,
			state: "pending",
			outgoing: {
				envelope,
				source: offered.source,
				target: offered.target,
				sender: offered.sender,
			},
		};
	}
	if (value.state === "failed") {
		return typeof value.error === "string" ? { version: 1, state: "failed", error: value.error } : undefined;
	}
	if (value.state !== "stored" && value.state !== "admitted" && value.state !== "sent") return undefined;
	if (!isAgentMailRecord(value.mail)) return undefined;
	return { version: 1, state: value.state, mail: value.mail };
}

/** Parse an owner verification response; refuses inconsistent evidence. */
export function parseAgentMailVerification(value: unknown): AgentMailVerification | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.valid !== "boolean") return undefined;
	if (value.valid === false) {
		return { valid: false, reason: typeof value.reason === "string" ? value.reason : "unspecified" };
	}
	if (
		!isEndpointIdentity(value.sender) ||
		!isAgentMailIncarnation(value.source) ||
		!isAgentMailIncarnation(value.target)
	)
		return undefined;
	if (value.source.sessionId !== value.sender.sessionId) return undefined;
	const approval = value.approval;
	const policyRevision = value.policyRevision;
	if (approval === undefined) {
		if (policyRevision !== undefined) return undefined;
		return { valid: true, sender: value.sender, source: value.source, target: value.target };
	}
	if (approval !== "once" && approval !== "always") return undefined;
	if (policyRevision !== null && !isMailReference(policyRevision)) return undefined;
	return {
		valid: true,
		sender: value.sender,
		source: value.source,
		target: value.target,
		approval,
		policyRevision,
	};
}

/** Parse one owner policy answer; anything unrecognized is not a verdict. */
export function parseAgentMailPolicy(value: unknown): AgentMailPolicy | undefined {
	if (!isRecord(value)) return undefined;
	if (value.rule !== "allow" && value.rule !== "block" && value.rule !== "unknown") return undefined;
	if (value.revision !== null && !isMailReference(value.revision)) return undefined;
	return { rule: value.rule, revision: value.revision };
}

function isAgentMailReceipt(value: unknown): value is AgentMailReceipt {
	if (!isRecord(value)) return false;
	if (typeof value.messageId !== "string" || !value.messageId) return false;
	if (typeof value.threadId !== "string" || !value.threadId) return false;
	if (value.admission !== "stored") return false;
	if (!isEndpointIdentity(value.recipient)) return false;
	if (!isAgentMailIncarnation(value.target)) return false;
	return true;
}

function sameEnvelope(left: AgentMailEnvelope, right: AgentMailEnvelope): boolean {
	return (
		left.recipientSessionId === right.recipientSessionId &&
		left.recipientSessionFile === right.recipientSessionFile &&
		left.recipientBootId === right.recipientBootId &&
		left.messageId === right.messageId &&
		left.message === right.message &&
		left.threadId === right.threadId &&
		left.replyTo === right.replyTo &&
		left.delivery === right.delivery &&
		left.sentAt === right.sentAt
	);
}

export function sameAgentMailIncarnation(left: AgentMailTarget, right: AgentMailTarget): boolean {
	return left.sessionId === right.sessionId && left.sessionFile === right.sessionFile && left.bootId === right.bootId;
}

/** Capabilities the mail owner borrows from its owning session. */
export interface SessionMailHost {
	sessionManager: SessionManager;
	isDisposed(): boolean;
	canSend(): boolean;
	/** Current canonical identity of the owning session, read at delivery time. */
	identity(): AgentMailEndpointIdentity;
	/** Exact native owner incarnation: UUID, owned canonical journal and bootId. */
	incarnation(): AgentMailIncarnation;
}

export class SessionMail {
	readonly #host: SessionMailHost;
	/** In-flight send capabilities. Transient by design: single-use, expiring, cleared on settlement, source change or dispose. Values are never logged. */
	readonly #sendCapabilities = new Map<string, AgentMailSendCapability>();
	#changingContact = false;

	constructor(host: SessionMailHost) {
		this.#host = host;
	}

	// =========================================================================
	// Sending
	// =========================================================================

	/**
	 * Resolve a peer, ask the recipient for its body-free policy verdict, then
	 * issue a capability bound to the exact envelope and deliver it over the
	 * recipient's native socket. Only an `unknown` verdict reaches a trusted
	 * local approver; a refusal is definite, and a transport failure after the
	 * command was written is UNKNOWN and never automatically resent.
	 *
	 * Version fencing: the consented delivery command has no legacy fallback, so
	 * a peer without it refuses instead of accepting part of the protocol.
	 * Exactly-once is bounded: one capability is consumed once and the recipient
	 * writes one journal record, but a lost receipt cannot prove the mail is
	 * absent, so it is reported UNKNOWN and never resent with that id.
	 */
	async send(params: AgentMailSendParams, options: AgentMailSendOptions = {}): Promise<AgentMailSendResult> {
		if (this.#host.isDisposed()) throw new Error("Session is disposed.");
		if (!this.#host.canSend())
			return { status: "refused", code: "mail_send_disabled", error: "Sending mail is disabled for this session." };
		if ("delivery" in params || "intent" in params)
			throw new TypeError("Mailbox posts do not accept intent or delivery instructions.");
		if (typeof params.to !== "string" || !params.to.trim()) throw new TypeError("A recipient is required.");
		if (typeof params.message !== "string" || !params.message.trim())
			throw new TypeError("A non-empty message is required.");
		if (params.message.length > MAX_BODY_CHARS) throw new TypeError(`message exceeds ${MAX_BODY_CHARS} characters`);
		if (
			(params.threadId !== undefined && !isMailReference(params.threadId)) ||
			(params.replyTo !== undefined && !isMailReference(params.replyTo))
		)
			throw new TypeError("Invalid mail reference.");
		if (
			options.responseTimeoutMs !== undefined &&
			!isIntegerInRange(options.responseTimeoutMs, 1, Number.MAX_SAFE_INTEGER)
		)
			throw new TypeError("responseTimeoutMs must be a positive finite integer");
		if (options.approve !== undefined && typeof options.approve !== "function")
			throw new TypeError("approve must be a function");
		if (options.signal !== undefined && typeof options.signal.aborted !== "boolean")
			throw new TypeError("signal must be an AbortSignal");
		const request = { ...params };
		if (request.replyTo !== undefined && request.threadId === undefined)
			throw new TypeError("replyTo must name the thread it answers");
		const source = this.#host.incarnation();
		let resolved: NativeSessionInfo | undefined;
		try {
			resolved = await new NativeSessionService().resolve(request.to.trim());
		} catch {
			resolved = undefined;
		}
		// Resolution problems stay opaque: candidate identities are not a roster,
		// so the resolver's suggestion list never reaches the caller.
		if (!resolved) throw new Error("No single native session matches the requested recipient.");
		this.#assertIncarnation(source);
		if (resolved.sessionId === source.sessionId) throw new Error("Cannot send mail to the sending session.");
		const sender = this.#host.identity();
		if (sender.sessionId !== source.sessionId) throw new Error("Source session changed before send.");
		const messageId = Snowflake.next();
		const post = {
			recipientSessionId: resolved.sessionId,
			messageId,
			message: request.message,
			threadId: request.threadId ?? messageId,
			...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
			delivery: "inbox" as const,
			sentAt: Date.now(),
		};
		try {
			this.#assertReply(this.#host.sessionManager, post, sender.sessionId);
		} catch (error) {
			return refused(error);
		}
		const approvalRequest: AgentMailApprovalRequest = {
			reference: request.to,
			sender,
			recipient: { sessionId: resolved.sessionId, handle: resolved.handle, model: resolved.model },
			message: request.message,
			messageId,
		};
		if (resolved.availability === "offline") {
			if (!resolved.sessionFile) return { status: "refused", error: "Saved recipient has no canonical journal." };
			return this.#deliverSaved(
				post,
				approvalRequest,
				source,
				sender,
				{ sessionId: resolved.sessionId, sessionFile: resolved.sessionFile, bootId: null },
				options,
			);
		}
		return this.#deliverLive(post, approvalRequest, source, sender, resolved, options);
	}

	/** Saved recipient: read policy under the lease, release, ask, then re-check at the write. */
	async #deliverSaved(
		post: MailPost,
		approvalRequest: AgentMailApprovalRequest,
		source: AgentMailIncarnation,
		sender: AgentMailEndpointIdentity,
		target: AgentMailTarget & { bootId: null },
		options: AgentMailSendOptions,
	): Promise<AgentMailSendResult> {
		let policy: AgentMailPolicy | undefined;
		try {
			policy = await SessionManager.withOfflineJournal(target.sessionId, target.sessionFile, async manager =>
				contactPolicy(manager, manager.getSessionId(), source.sessionId),
			);
		} catch (error) {
			return { status: "refused", error: `Recipient journal is not readable: ${toMessage(error)}` };
		}
		if (!policy) return { status: "refused", error: "Recipient journal is not readable." };
		this.#assertIncarnation(source);
		const asked = await this.#consentFor(policy, approvalRequest, options);
		if (asked.status === "refused") return asked.refused;
		const consent = asked.consent;
		if (options.signal?.aborted) return cancelled();
		this.#assertIncarnation(source);
		if (!this.#host.canSend())
			return { status: "refused", code: "mail_send_disabled", error: "Sending mail was disabled." };
		const envelope = { ...post, recipientSessionFile: target.sessionFile, recipientBootId: null };
		let attempted = false;
		try {
			await this.#journalOffer(envelope, source, target, sender);
			const record = await SessionManager.withOfflineJournal(target.sessionId, target.sessionFile, async manager => {
				this.#assertIncarnation(source);
				if (!this.#host.canSend()) throw new Error("Sending mail was disabled.");
				assertCurrentPolicy(contactPolicy(manager, manager.getSessionId(), source.sessionId), consent);
				const recipient: AgentMailEndpointIdentity = {
					sessionId: target.sessionId,
					handle: manager.getSessionIdentityMetadata()?.actorHandle ?? null,
					model: null,
				};
				const mail = this.#prepareRecord(manager, post, sender, source, recipient, target);
				const append = () => {
					options.signal?.throwIfAborted();
					this.#assertIncarnation(source);
					if (!this.#host.canSend()) throw new Error("Sending mail was disabled.");
					attempted = true;
					if (consent?.approval === "always")
						manager.appendCustomEntry(CONTACT_TYPE, {
							owner: manager.getSessionId(),
							peer: source.sessionId,
							rule: "allow",
						});
					manager.appendCustomEntry(AGENT_MAIL_CUSTOM_TYPE, {
						version: 1,
						state: "stored",
						mail,
					} satisfies AgentMailJournalEntry);
				};
				if (consent?.approval === "always") await manager.appendEntriesAtomically(append);
				else append();
				return mail;
			});
			this.#assertIncarnation(source);
			const { folder: _recipientPolicy, ...outbound } = record;
			this.#appendJournalEntry({ version: 1, state: "sent", mail: outbound });
			await this.#host.sessionManager.flush();
			this.#assertIncarnation(source);
			return { status: "accepted", receipt: storedReceipt(record), target: target.sessionId };
		} catch (error) {
			return attempted ? { status: "unknown", error: toMessage(error) } : refused(error);
		}
	}

	async #deliverLive(
		post: MailPost,
		approvalRequest: AgentMailApprovalRequest,
		source: AgentMailIncarnation,
		sender: AgentMailEndpointIdentity,
		resolved: NativeSessionInfo,
		options: AgentMailSendOptions,
	): Promise<AgentMailSendResult> {
		let client: RpcClient;
		try {
			client = await RpcClient.connectSessionSocket({ endpoint: sessionAttachEndpoint(resolved.sessionId) });
		} catch (error) {
			return { status: "refused", error: `Recipient endpoint is not reachable: ${toMessage(error)}` };
		}
		let token: string | undefined;
		let written = false;
		try {
			this.#assertIncarnation(source);
			const preflight = await this.#readPeerIncarnation(client, options.responseTimeoutMs);
			this.#assertIncarnation(source);
			if (
				preflight.sessionId !== resolved.sessionId ||
				(resolved.sessionFile !== null && preflight.sessionFile !== resolved.sessionFile)
			) {
				throw new Error("Recipient publication no longer matches the connected owner.");
			}
			let policy: AgentMailPolicy | undefined;
			let policyError: unknown;
			try {
				policy = await this.#readPeerPolicy(client, source, preflight, options.responseTimeoutMs);
			} catch (error) {
				policy = undefined;
				policyError = error;
			}
			if (!policy)
				return {
					status: "refused",
					code: "mail_recipient_unavailable",
					error: `Recipient mail policy is unavailable: ${toMessage(policyError)}`,
				};
			this.#assertIncarnation(source);
			const asked = await this.#consentFor(policy, approvalRequest, options);
			if (asked.status === "refused") return asked.refused;
			const consent = asked.consent;
			if (options.signal?.aborted) return cancelled();
			this.#assertIncarnation(source);
			if (!this.#host.canSend())
				return { status: "refused", code: "mail_send_disabled", error: "Sending mail was disabled." };
			const target = await this.#readPeerIncarnation(client, options.responseTimeoutMs);
			this.#assertIncarnation(source);
			if (!sameAgentMailIncarnation(target, preflight))
				return {
					status: "refused",
					code: "mail_target_mismatch",
					error: "Recipient owner changed while awaiting approval.",
				};
			const envelope: AgentMailEnvelope = {
				...post,
				recipientSessionFile: target.sessionFile,
				recipientBootId: target.bootId,
			};
			const envelopeError = agentMailEnvelopeError(envelope);
			if (envelopeError) throw new TypeError(envelopeError);
			await this.#journalOffer(envelope, source, target, sender);
			this.#assertIncarnation(source);
			if (options.signal?.aborted) return cancelled();
			if (!this.#host.canSend())
				return { status: "refused", code: "mail_send_disabled", error: "Sending mail was disabled." };
			token = this.#issueSendCapability(envelope, source, target, sender, consent);
			written = true;
			const response = await client.send(
				{
					type: "agent_mail_deliver_consented",
					...envelope,
					senderSessionId: source.sessionId,
					senderSessionFile: source.sessionFile,
					senderBootId: source.bootId,
					capabilityToken: token,
				},
				options.responseTimeoutMs,
			);
			this.#assertIncarnation(source);
			if (!response.success) {
				if (response.code === "mail_store_unknown") return { status: "unknown", error: response.error };
				return { status: "refused", error: response.error, ...(response.code ? { code: response.code } : {}) };
			}
			if (
				!("data" in response) ||
				!isAgentMailReceipt(response.data) ||
				response.data.recipient.sessionId !== target.sessionId ||
				!sameAgentMailIncarnation(response.data.target, target) ||
				response.data.messageId !== post.messageId ||
				response.data.threadId !== envelope.threadId
			) {
				return { status: "unknown", error: "the recipient owner returned an unreadable or mismatched receipt" };
			}
			const receipt = response.data;
			// Outbound provenance lets the original sender validate replies. It is
			// journal data, not an inbox cache, and never appears in inbox reads.
			this.#appendJournalEntry({
				version: 1,
				state: "sent",
				mail: {
					messageId: post.messageId,
					threadId: receipt.threadId,
					...(envelope.replyTo === undefined ? {} : { replyTo: envelope.replyTo }),
					sender,
					recipient: receipt.recipient,
					body: envelope.message,
					source,
					target,
					sentAt: envelope.sentAt,
					receivedAt: Date.now(),
					delivery: envelope.delivery,
					admission: receipt.admission,
				},
			});
			await this.#host.sessionManager.flush();
			this.#assertIncarnation(source);
			return { status: "accepted", receipt, target: target.sessionId };
		} catch (error) {
			return written
				? { status: "unknown", error: `the recipient outcome could not be confirmed: ${toMessage(error)}` }
				: { status: "refused", error: toMessage(error) };
		} finally {
			if (token !== undefined) this.#settleSendCapability(token);
			await client.stop();
		}
	}

	/** Block refuses outright; an existing grant needs no operator; default deny asks one trusted scope. */
	async #consentFor(
		policy: AgentMailPolicy,
		request: AgentMailApprovalRequest,
		options: AgentMailSendOptions,
	): Promise<ConsentOutcome> {
		if (policy.rule === "block")
			return {
				status: "refused",
				refused: {
					status: "refused",
					code: "mail_contact_blocked",
					error: "Recipient does not accept mail from this sender.",
				},
			};
		if (policy.rule === "allow") return { status: "consented" };
		const approve = options.approve;
		if (!approve)
			return {
				status: "refused",
				refused: {
					status: "refused",
					code: "mail_approval_required",
					error: "The recipient has not allowed this sender; an operator must approve this first message.",
				},
			};
		if (options.signal?.aborted) return { status: "refused", refused: cancelled() };
		let decision: AgentMailApproval;
		try {
			decision = await approve({ ...request });
		} catch (error) {
			return {
				status: "refused",
				refused: options.signal?.aborted
					? cancelled()
					: {
							status: "refused",
							code: "mail_approval_cancelled",
							error: `Mail approval failed: ${toMessage(error)}`,
						},
			};
		}
		if (decision === "once" || decision === "always")
			return { status: "consented", consent: { approval: decision, policyRevision: policy.revision } };
		if (decision === "cancel") return { status: "refused", refused: cancelled() };
		return {
			status: "refused",
			refused: {
				status: "refused",
				code: "mail_approval_cancelled",
				error: "Mail approval was not a recognized decision.",
			},
		};
	}

	async #journalOffer(
		envelope: JournalEnvelope,
		source: AgentMailIncarnation,
		target: AgentMailTarget,
		sender: AgentMailEndpointIdentity,
	): Promise<void> {
		// Keep the offered id so replies remain verifiable if our receipt is lost.
		this.#appendJournalEntry({ version: 1, state: "pending", outgoing: { envelope, source, target, sender } });
		await this.#host.sessionManager.flush();
		this.#assertIncarnation(source);
	}

	async #readPeerIncarnation(client: RpcClient, timeoutMs?: number): Promise<AgentMailIncarnation> {
		const response = await client.send(
			{ type: "get_refresh_preflight" },
			timeoutMs ?? DISCOVERY_RESPONSE_TIMEOUT_MS,
		);
		const data: unknown = response.success && "data" in response ? response.data : undefined;
		if (!isRecord(data) || !isAgentMailIncarnation(data.restartReceipt))
			throw new Error("Peer does not expose an owned native boot/journal receipt.");
		const { sessionId, sessionFile, bootId } = data.restartReceipt;
		return { sessionId, sessionFile, bootId };
	}

	/** Ask the recipient for its current rule without transmitting any body. */
	async #readPeerPolicy(
		client: RpcClient,
		source: AgentMailIncarnation,
		target: AgentMailIncarnation,
		timeoutMs?: number,
	): Promise<AgentMailPolicy> {
		const response = await client.send(
			{
				type: "agent_mail_policy",
				peer: source.sessionId,
				recipientSessionId: target.sessionId,
				recipientSessionFile: target.sessionFile,
				recipientBootId: target.bootId,
			},
			timeoutMs ?? DISCOVERY_RESPONSE_TIMEOUT_MS,
		);
		const policy = parseAgentMailPolicy(response.success && "data" in response ? response.data : undefined);
		if (!policy) throw new Error("Recipient did not answer a readable mail policy.");
		return policy;
	}

	/**
	 * Verify (and consume) one send capability presented by a recipient. The
	 * answer reveals only validity and this owner's identity — never the
	 * capability itself. Any mismatch — unknown or expired token, mutated
	 * envelope, different target, changed source incarnation — refuses.
	 */
	verifySendCapability(claim: {
		token: unknown;
		envelope: unknown;
		source: unknown;
		target: unknown;
	}): AgentMailVerification {
		const refuse = (reason: string): AgentMailVerification => ({ valid: false, reason });
		if (this.#host.isDisposed()) return refuse("source owner is disposed");
		this.#pruneSendCapabilities();
		if (typeof claim.token !== "string" || !claim.token) return refuse("malformed capability");
		if (!isAgentMailIncarnation(claim.source) || !isAgentMailIncarnation(claim.target))
			return refuse("malformed source or target incarnation");
		const envelopeError = agentMailEnvelopeError(claim.envelope);
		if (envelopeError) return refuse(`malformed envelope: ${envelopeError}`);
		const capability = this.#sendCapabilities.get(claim.token);
		if (!capability || capability.consumed) return refuse("unknown, expired or already-used capability");
		// Failed verification consumes the proof too; settlement/expiry
		// clears the transient record. Reply history lives only in the journal.
		capability.consumed = true;
		if (!this.#host.canSend()) return refuse("mail send permission was revoked");
		if (
			!sameAgentMailIncarnation(claim.source, capability.source) ||
			!sameAgentMailIncarnation(claim.target, capability.target)
		)
			return refuse("capability source or target incarnation mismatch");
		if (!sameEnvelope(capability.envelope, claim.envelope as AgentMailEnvelope))
			return refuse("envelope does not match the issued capability");
		if (!sameAgentMailIncarnation(capability.source, this.#host.incarnation()))
			return refuse("source owner changed since the capability was issued");
		const consent = capability.consent;
		return consent
			? {
					valid: true,
					sender: capability.sender,
					source: capability.source,
					target: capability.target,
					approval: consent.approval,
					policyRevision: consent.policyRevision,
				}
			: { valid: true, sender: capability.sender, source: capability.source, target: capability.target };
	}

	#issueSendCapability(
		envelope: AgentMailEnvelope,
		source: AgentMailIncarnation,
		target: AgentMailIncarnation,
		sender: AgentMailEndpointIdentity,
		consent?: AgentMailConsent,
	): string {
		this.#assertIncarnation(source);
		this.#pruneSendCapabilities();
		const token = randomBytes(32).toString("base64url");
		this.#sendCapabilities.set(token, {
			envelope,
			source,
			target,
			sender,
			...(consent === undefined ? {} : { consent }),
			expiresAt: Date.now() + CAPABILITY_TTL_MS,
			consumed: false,
		});
		return token;
	}

	#settleSendCapability(token: string): void {
		this.#sendCapabilities.delete(token);
	}

	/** Drop settled, expired and incarnation-broken capabilities. */
	#pruneSendCapabilities(): void {
		const now = Date.now();
		const incarnation = this.#host.incarnation();
		for (const [token, capability] of this.#sendCapabilities) {
			if (capability.expiresAt <= now || !sameAgentMailIncarnation(capability.source, incarnation)) {
				this.#sendCapabilities.delete(token);
			}
		}
	}

	clearTransient(): void {
		this.#sendCapabilities.clear();
	}

	#assertIncarnation(expected: AgentMailIncarnation): void {
		if (this.#host.isDisposed() || !sameAgentMailIncarnation(expected, this.#host.incarnation()))
			throw new AgentMailTargetMismatchError(expected.sessionId, this.#host.identity().sessionId);
	}

	/** A reply must answer a known reverse-direction message in that thread. */
	#assertReply(
		manager: SessionManager,
		envelope: Pick<AgentMailEnvelope, "replyTo" | "threadId" | "recipientSessionId">,
		senderId: string,
	): void {
		if (envelope.replyTo === undefined) return;
		const recipientId = envelope.recipientSessionId;
		const matches = (record: AgentMailRecord) =>
			record.messageId === envelope.replyTo &&
			record.threadId === envelope.threadId &&
			record.sender.sessionId === recipientId &&
			record.recipient.sessionId === senderId;
		for (const entry of manager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== AGENT_MAIL_CUSTOM_TYPE) continue;
			const parsed = parseAgentMailJournalEntry(entry.data);
			if (parsed?.mail && matches(parsed.mail)) return;
			const offered = parsed?.outgoing;
			if (
				offered &&
				offered.source.sessionId === recipientId &&
				offered.target.sessionId === senderId &&
				offered.envelope.messageId === envelope.replyTo &&
				offered.envelope.threadId === envelope.threadId
			)
				return;
		}
		throw new Error("replyTo does not identify a message from this peer in the requested thread.");
	}

	// =========================================================================
	// Receiving
	// =========================================================================

	/**
	 * Store only after the live receiver has authenticated the sender, the exact
	 * target, and its own current policy. An approved delivery must still match
	 * the revision the operator saw; a block always wins.
	 */
	async receive(claim: {
		envelope: AgentMailEnvelope;
		sender: AgentMailEndpointIdentity;
		source: AgentMailIncarnation;
		target: AgentMailIncarnation;
		approval?: "once" | "always";
		policyRevision?: string | null;
	}): Promise<AgentMailReceipt> {
		if (this.#host.isDisposed()) throw new Error("Recipient session is disposed.");
		const envelope = claim.envelope;
		const envelopeError = agentMailEnvelopeError(envelope);
		if (envelopeError) throw new TypeError(envelopeError);
		if (
			!isEndpointIdentity(claim.sender) ||
			!isAgentMailIncarnation(claim.source) ||
			!isAgentMailIncarnation(claim.target)
		) {
			throw new TypeError("Verified sender evidence is malformed.");
		}
		if (claim.source.sessionId !== claim.sender.sessionId) {
			throw new Error("Verified sender evidence is inconsistent.");
		}
		const approval = claim.approval;
		const policyRevision = claim.policyRevision;
		if (approval === undefined) {
			if (policyRevision !== undefined) throw new TypeError("A policy revision requires an approval.");
		} else if (approval !== "once" && approval !== "always") {
			throw new TypeError("Unknown mail approval.");
		} else if (policyRevision !== null && !isMailReference(policyRevision)) {
			throw new TypeError("An approved delivery must name its policy revision.");
		}
		this.#assertIncarnation(claim.target);
		if (this.#changingContact) throw new Error("Recipient contact policy is being updated.");
		if (
			claim.target.sessionId !== envelope.recipientSessionId ||
			claim.target.sessionFile !== envelope.recipientSessionFile ||
			claim.target.bootId !== envelope.recipientBootId
		) {
			throw new Error("Verified recipient incarnation does not match the envelope.");
		}
		const identity = this.#host.identity();
		if (envelope.recipientSessionId !== identity.sessionId) {
			throw new AgentMailTargetMismatchError(envelope.recipientSessionId, identity.sessionId);
		}
		if (claim.sender.sessionId === identity.sessionId) {
			throw new Error("Agent mail cannot be addressed to the sending session itself.");
		}
		const current = contactPolicy(this.#host.sessionManager, identity.sessionId, claim.sender.sessionId);
		assertCurrentPolicy(current, approval === undefined ? undefined : { approval, policyRevision: policyRevision ?? null });
		const mail = this.#prepareRecord(
			this.#host.sessionManager,
			envelope,
			claim.sender,
			claim.source,
			identity,
			claim.target,
		);
		try {
			const consent = approval === undefined ? undefined : { approval, policyRevision: policyRevision ?? null };
			const commit = () => {
				this.#assertIncarnation(claim.target);
				if (this.#changingContact) throw new MailPolicyChangedError("Recipient contact policy is being updated.");
				assertCurrentPolicy(
					contactPolicy(this.#host.sessionManager, identity.sessionId, claim.sender.sessionId),
					consent,
				);
				if (approval === "always")
					this.#host.sessionManager.appendCustomEntry(CONTACT_TYPE, {
						owner: identity.sessionId,
						peer: claim.sender.sessionId,
						rule: "allow",
					});
				this.#appendJournalEntry({ version: 1, state: "stored", mail });
			};
			if (approval === "always") await this.#host.sessionManager.appendEntriesAtomically(commit);
			else commit();
			await this.#host.sessionManager.flush();
			this.#assertIncarnation(claim.target);
		} catch (error) {
			throw error instanceof MailContactBlockedError ? error : new MailStoreUnknownError(toMessage(error));
		}
		return storedReceipt(mail);
	}

	#prepareRecord(
		manager: SessionManager,
		post: MailPost,
		sender: AgentMailEndpointIdentity,
		source: AgentMailIncarnation,
		recipient: AgentMailEndpointIdentity,
		target: AgentMailTarget,
	): AgentMailRecord {
		this.#assertReply(manager, post, sender.sessionId);
		return {
			messageId: post.messageId,
			threadId: post.threadId ?? post.messageId,
			...(post.replyTo ? { replyTo: post.replyTo } : {}),
			sender,
			source,
			recipient,
			target,
			body: post.message,
			sentAt: post.sentAt,
			receivedAt: Date.now(),
			delivery: "inbox",
			admission: "stored",
			folder: "inbox",
		};
	}

	/** This session's current directional rule for one sender, with the revision it reflects. */
	policy(peer: string): AgentMailPolicy {
		if (typeof peer !== "string" || !peer.trim()) throw new TypeError("A peer session id is required.");
		const manager = this.#host.sessionManager;
		return contactPolicy(manager, manager.getSessionId(), peer);
	}

	async setContact(contact: AgentMailContact): Promise<AgentMailContact> {
		const owner = this.#host.incarnation();
		if (
			typeof contact.peer !== "string" ||
			!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(contact.peer) ||
			contact.peer === owner.sessionId
		)
			throw new TypeError("Contact must be another session's exact UUID.");
		if (contact.rule !== "allow" && contact.rule !== "block" && contact.rule !== "reset")
			throw new TypeError("Invalid contact rule.");
		if (this.#changingContact) throw new Error("Recipient contact policy is being updated.");
		this.#changingContact = true;
		try {
			await this.#host.sessionManager.appendEntriesAtomically(() => {
				this.#assertIncarnation(owner);
				this.#host.sessionManager.appendCustomEntry(CONTACT_TYPE, {
					owner: owner.sessionId,
					peer: contact.peer,
					rule: contact.rule,
				});
			});
			this.#assertIncarnation(owner);
			return { peer: contact.peer, rule: contact.rule };
		} finally {
			this.#changingContact = false;
		}
	}

	// =========================================================================
	// Bounded history
	// =========================================================================

	/**
	 * Bounded read of this session's admitted mail, newest last, derived from
	 * the current SessionManager's loaded journal entries — never a shadow
	 * inbox. Records whose recipient UUID is not this session are skipped.
	 */
	read(options: AgentMailReadOptions = {}): AgentMailReadResult {
		if (options.folder !== undefined && options.folder !== "inbox" && options.folder !== "requests")
			throw new TypeError("Unknown mail folder.");
		const folder = options.folder ?? "inbox";
		if (options.threadId !== undefined) {
			if (!isMailReference(options.threadId)) {
				throw new TypeError("threadId must be a valid bounded reference");
			}
		}
		const limit = options.limit ?? DEFAULT_READ_LIMIT;
		if (!isIntegerInRange(limit, 1, MAX_READ_LIMIT)) {
			throw new TypeError(`limit must be an integer between 1 and ${MAX_READ_LIMIT}`);
		}
		const identity = this.#host.identity();
		const admitted: AgentMailRecord[] = [];
		for (const entry of this.#host.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== AGENT_MAIL_CUSTOM_TYPE) continue;
			const parsed = parseAgentMailJournalEntry(entry.data);
			if (!parsed || (parsed.state !== "stored" && parsed.state !== "admitted") || !parsed.mail) continue;
			if ((parsed.mail.folder ?? "inbox") !== folder) continue;
			if (parsed.mail.recipient.sessionId !== identity.sessionId) continue;
			if (options.threadId !== undefined && parsed.mail.threadId !== options.threadId) continue;
			admitted.push(parsed.mail);
		}
		const end =
			options.before === undefined
				? admitted.length
				: admitted.findIndex(record => record.messageId === options.before);
		if (end < 0) throw new TypeError("Unknown mail cursor for this folder and thread.");
		const start = Math.max(0, end - limit);
		const messages = admitted.slice(start, end).map(record => ({
			...record,
			sender: { ...record.sender },
			recipient: { ...record.recipient },
			source: { ...record.source },
			target: { ...record.target },
		}));
		return {
			messages,
			total: admitted.length,
			truncated: start > 0,
			...(start > 0 ? { nextBefore: messages[0].messageId } : {}),
		};
	}

	// =========================================================================
	// Discovery
	// =========================================================================

	/**
	 * Bounded peer discovery merging the identity catalog (named and unnamed
	 * saved sessions) with live socket publications. Availability is proven by
	 * an actual native handshake with each published owner — a PID is never
	 * trusted as capability evidence.
	 */
	async discover(
		options: { query?: string; liveOnly?: boolean; limit?: number } = {},
	): Promise<AgentMailDiscoveryResult> {
		const limit = options.limit ?? DEFAULT_DISCOVERY_LIMIT;
		if (!isIntegerInRange(limit, 1, MAX_DISCOVERY_LIMIT)) {
			throw new TypeError(`limit must be an integer between 1 and ${MAX_DISCOVERY_LIMIT}`);
		}
		return new NativeSessionService().list({ ...options, limit });
	}

	#appendJournalEntry(entry: AgentMailJournalEntry): void {
		this.#host.sessionManager.appendCustomEntry(AGENT_MAIL_CUSTOM_TYPE, entry);
	}
}

const CONTACT_TYPE = "omp.agent_mail.contact";

export class MailContactBlockedError extends Error {}
export class MailStoreUnknownError extends Error {}
/** The recipient's rule moved after the operator saw it; the old decision is not reused. */
export class MailPolicyChangedError extends MailContactBlockedError {}
/** No established grant covers this delivery; a trusted local approver may open one dialog. */
export class MailApprovalRequiredError extends MailContactBlockedError {}

/** Newest matching contact entry decides one direction; absence and reset are default deny. */
function contactPolicy(manager: SessionManager, ownerId: string, peer: string): AgentMailPolicy {
	const entries = manager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== CONTACT_TYPE || !isRecord(entry.data)) continue;
		if (entry.data.owner !== ownerId || entry.data.peer !== peer) continue;
		const rule = entry.data.rule;
		if (rule !== "allow" && rule !== "block" && rule !== "reset") continue;
		return { rule: rule === "reset" ? "unknown" : rule, revision: entry.id };
	}
	return { rule: "unknown", revision: null };
}

/** Recheck the recipient's rule at the write: a block wins, and stale consent is not escalated. */
function assertCurrentPolicy(current: AgentMailPolicy, consent?: AgentMailConsent): void {
	if (current.rule === "block")
		throw new MailContactBlockedError("Recipient does not accept mail from this sender.");
	if (consent) {
		if (current.revision !== consent.policyRevision)
			throw new MailPolicyChangedError("Recipient mail policy changed before delivery; nothing was stored.");
		return;
	}
	if (current.rule !== "allow")
		throw new MailApprovalRequiredError("Recipient has no current grant for this sender; nothing was stored.");
}

function storedReceipt(record: AgentMailRecord): AgentMailReceipt {
	return {
		messageId: record.messageId,
		threadId: record.threadId,
		admission: "stored",
		recipient: record.recipient,
		target: record.target,
	};
}

function refused(error: unknown): AgentMailSendResult {
	return { status: "refused", error: toMessage(error), ...refusalCode(error) };
}

function refusalCode(error: unknown): { code?: string } {
	if (error instanceof MailPolicyChangedError) return { code: "mail_policy_changed" };
	if (error instanceof MailApprovalRequiredError) return { code: "mail_approval_required" };
	if (error instanceof MailContactBlockedError) return { code: "mail_contact_blocked" };
	return {};
}

function cancelled(): AgentMailSendResult {
	return {
		status: "refused",
		code: "mail_approval_cancelled",
		error: "Mail send was cancelled before delivery.",
	};
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
