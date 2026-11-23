/**
 * Cross-session agent mail, owned by the sending and receiving
 * {@link AgentSession}.
 *
 * Sending resolves a peer through the native authorities (live socket
 * publications first; the identity catalog for handles and id prefixes, via its
 * persisted projection), issues a short-lived single-use capability bound to
 * the exact envelope and both owners' incarnations, and delivers over the
 * recipient's native RPC socket with {@link RpcClient} — the one client owner.
 * The recipient verifies that capability with the claimed source owner's own
 * socket before admitting, so sender identity is owner-attested, never taken
 * from command arguments.
 *
 * Receiving admits mail through the session's normal input path — `prompt()`
 * with command/template execution disabled and the explicit queue-vs-steering
 * choice — and settles the receipt only once admission is observed and the
 * provenance record is durably journaled; the model's inference is never
 * awaited. Bounded reads derive from the current SessionManager's loaded
 * journal entries, so a reopen retains history and a session switch cannot
 * leak another conversation's mail.
 *
 * A transport failure after a send is written is reported as UNKNOWN and never
 * automatically resent. There is no outgoing mailbox, store-and-forward, or
 * discovery cache.
 */
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { isRecord, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import agentMailIncomingTemplate from "../prompts/tools/agent-mail-incoming.md" with { type: "text" };
import { sessionAttachEndpoint } from "../launch/session-attach";
import { RpcClient } from "../modes/rpc/rpc-client";
import type { AgentSessionEvent } from "./agent-session-events";
import type { PromptOptions } from "./agent-session-types";
import { escapeHarnessTags } from "./harness-tags";
import type { SessionManager } from "./session-manager";
import { NativeSessionService } from "./session-service";

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
	delivery: "queue" | "steer";
	sentAt: number;
}

/** Owner send parameters; `to` is a canonical UUID, unique id prefix, or actor handle. */
export interface AgentMailSendParams {
	to: string;
	message: string;
	delivery?: "queue" | "steer";
	threadId?: string;
	replyTo?: string;
}

/** One delivered mail record with full provenance, as journaled and served by the owner. */
export interface AgentMailRecord {
	messageId: string;
	threadId: string;
	replyTo?: string;
	sender: AgentMailEndpointIdentity;
	recipient: AgentMailEndpointIdentity;
	source: AgentMailIncarnation;
	target: AgentMailIncarnation;
	body: string;
	sentAt: number;
	receivedAt: number;
	delivery: "queue" | "steer";
	/** Input path the admission actually took; says nothing about the model having read or answered. */
	admission: "admitted" | "queued" | "steering";
}

/** Truthful receipt for one accepted mail: recorded and admitted, nothing more. */
export interface AgentMailReceipt {
	messageId: string;
	threadId: string;
	admission: "admitted" | "queued" | "steering";
	/** Whether a run was streaming on the recipient when the mail was admitted. */
	busy: boolean;
	recipient: AgentMailEndpointIdentity;
	target: AgentMailIncarnation;
}

/** Bounded inbox read derived from the current journal. */
export interface AgentMailReadResult {
	/** Newest-last records actually returned. */
	messages: AgentMailRecord[];
	/** Total admitted records matching the read (thread) filter. */
	total: number;
	/** True when `total` exceeds the returned `messages`. */
	truncated: boolean;
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

/** Durably-journaled mail outcome; `failed` records never claim delivery. */
interface AgentMailJournalEntry {
	version: 1;
	state: "pending" | "admitted" | "sent" | "failed";
	mail?: AgentMailRecord;
	error?: string;
	/** Offered outgoing envelope, not a delivery claim or store-and-forward queue. */
	outgoing?: {
		envelope: AgentMailEnvelope;
		source: AgentMailIncarnation;
		target: AgentMailIncarnation;
		sender: AgentMailEndpointIdentity;
	};
}

/** In-flight send capability: single-use, expiring, bound to one envelope and both incarnations. */
interface AgentMailSendCapability {
	envelope: AgentMailEnvelope;
	source: AgentMailIncarnation;
	target: AgentMailIncarnation;
	sender: AgentMailEndpointIdentity;
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
	if (isRecord(value)) {
		if (typeof value.recipientSessionFile !== "string" || !path.isAbsolute(value.recipientSessionFile))
			return "recipientSessionFile must be the canonical absolute journal";
		if (typeof value.recipientBootId !== "string" || !value.recipientBootId)
			return "recipientBootId must identify the native owner boot";
		if (!isMailReference(value.messageId)) return "messageId must be a valid owner-issued reference";
	}
	if (!isRecord(value)) return "mail envelope must be an object";
	if (typeof value.recipientSessionId !== "string" || !value.recipientSessionId.trim())
		return "recipientSessionId must be a non-empty string";
	if (typeof value.message !== "string" || !value.message.trim()) return "message must be a non-empty string";
	if (value.message.length > MAX_BODY_CHARS) return `message exceeds ${MAX_BODY_CHARS} characters`;
	if (value.delivery !== "queue" && value.delivery !== "steer") return 'delivery must be "queue" or "steer"';
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

export function isAgentMailIncarnation(value: unknown): value is AgentMailIncarnation {
	if (!isRecord(value)) return false;
	return (
		typeof value.sessionId === "string" &&
		value.sessionId.length > 0 &&
		typeof value.sessionFile === "string" &&
		path.isAbsolute(value.sessionFile) &&
		typeof value.bootId === "string" &&
		value.bootId.length > 0
	);
}

function isAgentMailRecord(value: unknown): value is AgentMailRecord {
	if (!isRecord(value)) return false;
	if (!isMailReference(value.messageId) || !isMailReference(value.threadId)) return false;
	if (value.replyTo !== undefined && !isMailReference(value.replyTo)) return false;
	if (!isEndpointIdentity(value.sender) || !isEndpointIdentity(value.recipient)) return false;
	if (!isAgentMailIncarnation(value.source) || !isAgentMailIncarnation(value.target)) return false;
	if (value.source.sessionId !== value.sender.sessionId || value.target.sessionId !== value.recipient.sessionId)
		return false;
	if (typeof value.body !== "string") return false;
	if (!isIntegerInRange(value.sentAt, 1, Number.MAX_SAFE_INTEGER)) return false;
	if (!isIntegerInRange(value.receivedAt, 1, Number.MAX_SAFE_INTEGER)) return false;
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
			agentMailEnvelopeError(offered.envelope) !== undefined ||
			!isAgentMailIncarnation(offered.source) ||
			!isAgentMailIncarnation(offered.target) ||
			!isEndpointIdentity(offered.sender)
		)
			return undefined;
		const envelope = offered.envelope as AgentMailEnvelope;
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
	if (value.state !== "admitted" && value.state !== "sent") return undefined;
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
	return { valid: true, sender: value.sender, source: value.source, target: value.target };
}

function isAgentMailReceipt(value: unknown): value is AgentMailReceipt {
	if (!isRecord(value)) return false;
	if (typeof value.messageId !== "string" || !value.messageId) return false;
	if (typeof value.threadId !== "string" || !value.threadId) return false;
	if (value.admission !== "admitted" && value.admission !== "queued" && value.admission !== "steering") return false;
	if (typeof value.busy !== "boolean") return false;
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

export function sameAgentMailIncarnation(left: AgentMailIncarnation, right: AgentMailIncarnation): boolean {
	return left.sessionId === right.sessionId && left.sessionFile === right.sessionFile && left.bootId === right.bootId;
}

/** Capabilities the mail owner borrows from its owning session. */
export interface SessionMailHost {
	sessionManager: SessionManager;
	isDisposed(): boolean;
	isStreaming(): boolean;
	/** Normal-input admission, exactly as a typed message from the operator would take. */
	prompt(text: string, options?: PromptOptions): Promise<boolean>;
	/** Current canonical identity of the owning session, read at delivery time. */
	identity(): AgentMailEndpointIdentity;
	/** Exact native owner incarnation: UUID, owned canonical journal and bootId. */
	incarnation(): AgentMailIncarnation;
	emitSessionEvent(event: AgentSessionEvent): void;
}

export class SessionMail {
	readonly #host: SessionMailHost;
	/** In-flight send capabilities. Transient by design: single-use, expiring, cleared on settlement, source change or dispose. Values are never logged. */
	readonly #sendCapabilities = new Map<string, AgentMailSendCapability>();

	constructor(host: SessionMailHost) {
		this.#host = host;
	}

	// =========================================================================
	// Sending
	// =========================================================================

	/**
	 * Resolve a peer, issue a capability bound to the exact envelope, and
	 * deliver it over the recipient's native socket. A refusal is definite; a
	 * transport failure after the command was written is UNKNOWN and is never
	 * automatically resent.
	 */
	async send(params: AgentMailSendParams, options: { responseTimeoutMs?: number } = {}): Promise<AgentMailSendResult> {
		if (this.#host.isDisposed()) throw new Error("Session is disposed.");
		if (typeof params.to !== "string" || !params.to.trim()) throw new TypeError("A recipient is required.");
		if (typeof params.message !== "string" || !params.message.trim())
			throw new TypeError("A non-empty message is required.");
		if (
			options.responseTimeoutMs !== undefined &&
			!isIntegerInRange(options.responseTimeoutMs, 1, Number.MAX_SAFE_INTEGER)
		)
			throw new TypeError("responseTimeoutMs must be a positive finite integer");
		const responseTimeoutMs = options.responseTimeoutMs;
		const request = { ...params };
		if (request.replyTo !== undefined && request.threadId === undefined)
			throw new TypeError("replyTo must name the thread it answers");
		const source = this.#host.incarnation();
		const resolved = await this.#resolveTarget(request.to.trim());
		this.#assertIncarnation(source);
		if (resolved.sessionId === source.sessionId) throw new Error("Cannot send mail to the sending session.");
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
			const target = await this.#readPeerIncarnation(client);
			this.#assertIncarnation(source);
			if (
				target.sessionId !== resolved.sessionId ||
				(resolved.sessionFile !== null && target.sessionFile !== resolved.sessionFile)
			) {
				throw new Error("Recipient publication no longer matches the connected owner.");
			}
			const sender = this.#host.identity();
			if (sender.sessionId !== source.sessionId) throw new Error("Source session changed before send.");
			const messageId = Snowflake.next();
			const envelope: AgentMailEnvelope = {
				recipientSessionId: target.sessionId,
				recipientSessionFile: target.sessionFile,
				recipientBootId: target.bootId,
				messageId,
				message: request.message,
				threadId: request.threadId ?? messageId,
				...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
				delivery: request.delivery ?? "queue",
				sentAt: Date.now(),
			};
			const envelopeError = agentMailEnvelopeError(envelope);
			if (envelopeError) throw new TypeError(envelopeError);
			this.#assertReply(envelope, sender.sessionId);
			// Preserve offered ids in the owning journal even when the reply to
			// this RPC is lost. This is evidence only: nothing is resent.
			this.#appendJournalEntry({ version: 1, state: "pending", outgoing: { envelope, source, target, sender } });
			await this.#host.sessionManager.flush();
			this.#assertIncarnation(source);
			token = this.#issueSendCapability(envelope, source, target, sender);
			written = true;
			const response = await client.send(
				{
					type: "agent_mail_deliver",
					...envelope,
					senderSessionId: source.sessionId,
					senderSessionFile: source.sessionFile,
					senderBootId: source.bootId,
					capabilityToken: token,
				},
				responseTimeoutMs,
			);
			this.#assertIncarnation(source);
			if (!response.success) {
				return { status: "refused", error: response.error, ...(response.code ? { code: response.code } : {}) };
			}
			if (
				!("data" in response) ||
				!isAgentMailReceipt(response.data) ||
				response.data.recipient.sessionId !== target.sessionId ||
				!sameAgentMailIncarnation(response.data.target, target) ||
				response.data.messageId !== messageId ||
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
					messageId,
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

	async #readPeerIncarnation(client: RpcClient): Promise<AgentMailIncarnation> {
		const response = await client.send({ type: "get_refresh_preflight" }, DISCOVERY_RESPONSE_TIMEOUT_MS);
		const data: unknown = response.success && "data" in response ? response.data : undefined;
		if (!isRecord(data) || !isAgentMailIncarnation(data.restartReceipt))
			throw new Error("Peer does not expose an owned native boot/journal receipt.");
		const { sessionId, sessionFile, bootId } = data.restartReceipt;
		return { sessionId, sessionFile, bootId };
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
		if (
			!sameAgentMailIncarnation(claim.source, capability.source) ||
			!sameAgentMailIncarnation(claim.target, capability.target)
		)
			return refuse("capability source or target incarnation mismatch");
		if (!sameEnvelope(capability.envelope, claim.envelope as AgentMailEnvelope))
			return refuse("envelope does not match the issued capability");
		if (!sameAgentMailIncarnation(capability.source, this.#host.incarnation()))
			return refuse("source owner changed since the capability was issued");
		return { valid: true, sender: capability.sender, source: capability.source, target: capability.target };
	}

	#issueSendCapability(
		envelope: AgentMailEnvelope,
		source: AgentMailIncarnation,
		target: AgentMailIncarnation,
		sender: AgentMailEndpointIdentity,
	): string {
		this.#assertIncarnation(source);
		this.#pruneSendCapabilities();
		const token = randomBytes(32).toString("base64url");
		this.#sendCapabilities.set(token, {
			envelope,
			source,
			target,
			sender,
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
	#assertReply(envelope: AgentMailEnvelope, senderId: string): void {
		if (envelope.replyTo === undefined) return;
		const recipientId = envelope.recipientSessionId;
		const matches = (record: AgentMailRecord) =>
			record.messageId === envelope.replyTo &&
			record.threadId === envelope.threadId &&
			record.sender.sessionId === recipientId &&
			record.recipient.sessionId === senderId;
		for (const entry of this.#host.sessionManager.getEntries()) {
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
	 * Admit one verified mail. The receipt settles when the recipient's normal
	 * input admission is observed and the provenance record is durably
	 * journaled — never after inference. A pre-admission failure journals a
	 * `failed` record, emits no success event, and rejects.
	 */
	async receive(claim: {
		envelope: AgentMailEnvelope;
		sender: AgentMailEndpointIdentity;
		source: AgentMailIncarnation;
		target: AgentMailIncarnation;
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
		this.#assertIncarnation(claim.target);
		if (
			claim.target.sessionId !== envelope.recipientSessionId ||
			claim.target.sessionFile !== envelope.recipientSessionFile ||
			claim.target.bootId !== envelope.recipientBootId
		) {
			throw new Error("Verified recipient incarnation does not match the envelope.");
		}
		this.#assertReply(envelope, claim.sender.sessionId);
		const identity = this.#host.identity();
		if (envelope.recipientSessionId !== identity.sessionId) {
			throw new AgentMailTargetMismatchError(envelope.recipientSessionId, identity.sessionId);
		}
		if (claim.sender.sessionId === identity.sessionId) {
			throw new Error("Agent mail cannot be addressed to the sending session itself.");
		}
		const messageId = envelope.messageId;
		const threadId = envelope.threadId ?? messageId;
		const content = prompt.render(agentMailIncomingTemplate, {
			// Every peer-controlled label and id is escaped, not just the body.
			messageId: escapeHarnessTags(messageId),
			threadId: escapeHarnessTags(threadId),
			senderLabel: escapeHarnessTags(claim.sender.handle ?? claim.sender.sessionId),
			senderSessionId: escapeHarnessTags(claim.sender.sessionId),
			replyTo: envelope.replyTo === undefined ? "" : escapeHarnessTags(envelope.replyTo),
			body: escapeHarnessTags(envelope.message),
		});
		type AdmissionOutcome = { record: AgentMailRecord } | { failed: string };
		const admission = Promise.withResolvers<AdmissionOutcome>();
		let settled = false;
		const settle = (outcome: AdmissionOutcome): void => {
			if (settled) return;
			settled = true;
			admission.resolve(outcome);
		};
		let queued = false;
		const run = this.#host.prompt(content, {
			runCommands: false,
			expandPromptTemplates: false,
			streamingBehavior: envelope.delivery === "steer" ? "steer" : "followUp",
			throwOnDrop: true,
			assertInputTarget: () => this.#assertIncarnation(claim.target),
			onPromptQueued: () => {
				queued = true;
			},
			onPromptCommitted: () => {
				this.#assertIncarnation(claim.target);
				const observed = queued ? (envelope.delivery === "steer" ? "steering" : "queued") : "admitted";
				const record: AgentMailRecord = {
					messageId,
					threadId,
					...(envelope.replyTo === undefined ? {} : { replyTo: envelope.replyTo }),
					sender: claim.sender,
					recipient: this.#host.identity(),
					source: claim.source,
					target: claim.target,
					body: envelope.message,
					sentAt: envelope.sentAt,
					receivedAt: Date.now(),
					delivery: envelope.delivery,
					admission: observed,
				};
				// Publish provenance synchronously at the normal input commit so
				// even an immediate peer reply can validate its reference.
				this.#appendJournalEntry({ version: 1, state: "admitted", mail: record });
				settle({ record });
			},
		});
		void run.then(
			forwarded => {
				if (settled) return;
				settle({
					failed: forwarded === false ? "the prompt was dropped before admission" : "no admission was observed",
				});
			},
			error => {
				if (settled) {
					// The run failed after admission; the receipt already stated
					// only what was observed. Track it without bodies.
					logger.warn("Agent mail run failed after admission", { error: toMessage(error) });
					return;
				}
				settle({ failed: toMessage(error) });
			},
		);
		const outcome = await admission.promise;
		if ("failed" in outcome) {
			// Never append even a failure diagnostic to a successor conversation.
			this.#assertIncarnation(claim.target);
			this.#appendJournalEntry({ version: 1, state: "failed", error: outcome.failed });
			await this.#host.sessionManager.flush();
			throw new Error(`The mail was not admitted: ${outcome.failed}`);
		}
		// Exact-target guard after every admission await: never journal into a
		// conversation the recipient no longer owns.
		this.#assertIncarnation(claim.target);
		const record = outcome.record;
		await this.#host.sessionManager.flush();
		this.#assertIncarnation(claim.target);
		this.#host.emitSessionEvent({ type: "agent_mail", mail: record });
		return {
			messageId,
			threadId,
			admission: record.admission,
			busy: record.admission !== "admitted",
			recipient: record.recipient,
			target: claim.target,
		};
	}

	// =========================================================================
	// Bounded history
	// =========================================================================

	/**
	 * Bounded read of this session's admitted mail, newest last, derived from
	 * the current SessionManager's loaded journal entries — never a shadow
	 * inbox. Records whose recipient UUID is not this session are skipped.
	 */
	read(options: { threadId?: string; limit?: number } = {}): AgentMailReadResult {
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
			if (!parsed || parsed.state !== "admitted" || !parsed.mail) continue;
			if (parsed.mail.recipient.sessionId !== identity.sessionId) continue;
			if (options.threadId !== undefined && parsed.mail.threadId !== options.threadId) continue;
			admitted.push(parsed.mail);
		}
		const messages = admitted.slice(-limit).map(record => ({
			...record,
			sender: { ...record.sender },
			recipient: { ...record.recipient },
			source: { ...record.source },
			target: { ...record.target },
		}));
		return { messages, total: admitted.length, truncated: admitted.length > messages.length };
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

	// =========================================================================
	// Target resolution
	// =========================================================================

	/** Share the catalog's exact name/UUID/prefix policy; wake only the selected saved conversation. */
	async #resolveTarget(reference: string): Promise<{ sessionId: string; sessionFile: string | null }> {
		const service = new NativeSessionService();
		const selected = await service.resolve(reference);
		if (selected.availability === "offline") {
			if (!selected.sessionFile) throw new Error("Saved recipient has no journal");
			await service.wake(selected.sessionId, { expectedSessionFile: selected.sessionFile });
		}
		return { sessionId: selected.sessionId, sessionFile: selected.sessionFile };
	}

	#appendJournalEntry(entry: AgentMailJournalEntry): void {
		this.#host.sessionManager.appendCustomEntry(AGENT_MAIL_CUSTOM_TYPE, entry);
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
