/**
 * Operator approval scope for one trusted local TUI submission.
 *
 * A session owner arms this scope around exactly one editor submission, with
 * the operator's original text and a callback that can put the exact mail to
 * them in a local selector. The `agent_mail` tool asks
 * {@link currentMailApproval} for a callback; it is absent everywhere else
 * (headless runs, RPC payloads, mail-driven prompts, loop and goal
 * continuations, focused subagent composers), so those paths stay refused.
 *
 * The callback only opens a dialog when the resolved recipient's exact full
 * handle or full session UUID appears as a whole token in the operator's own
 * text, and at most once per target per submission. The scope settles when its
 * dispatch returns, expires shortly after arming, and denies on abort, on a
 * changed sending session, or on any unrecognized decision. A callback kept
 * alive by a detached task or a later follow-up therefore opens nothing.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMailApproval, AgentMailApprovalRequest, AgentMailEndpointIdentity } from "./session-mail";

/** How long one armed submission may still ask its operator. */
export const MAIL_APPROVAL_CONTEXT_TTL_MS = 5 * 60_000;

/** The trusted local selector the scope asks; it must never be a wire-supplied function. */
export type MailApprovalApprover = (
	request: AgentMailApprovalRequest,
	signal: AbortSignal,
) => Promise<AgentMailApproval>;

export interface MailApprovalContextBinding {
	/** The session that submitted the prompt; any other sender is a different owner. */
	readonly sourceSessionId: string | undefined;
}

interface MailApprovalScope {
	readonly operatorText: string;
	readonly approve: MailApprovalApprover;
	readonly sourceSessionId: string | undefined;
	readonly expiresAt: number;
	readonly dialogued: Set<string>;
	/** Aborted when the submission settles, which closes any dialog still open. */
	readonly lifetime: AbortController;
	settled: boolean;
}

const scopes = new AsyncLocalStorage<MailApprovalScope>();

const TOKEN_EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

function operatorTokens(text: string): string[] {
	const tokens: string[] = [];
	for (const raw of text.split(/\s+/u)) {
		const token = raw.replace(TOKEN_EDGES, "");
		if (token) tokens.push(token.toLowerCase());
	}
	return tokens;
}

function isRecipient(value: unknown): value is AgentMailEndpointIdentity {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { sessionId?: unknown; handle?: unknown };
	return (
		typeof candidate.sessionId === "string" &&
		candidate.sessionId.length > 0 &&
		(candidate.handle === null || typeof candidate.handle === "string")
	);
}

/**
 * Whether the operator's own text names this exact recipient: the full handle
 * (case-insensitive) or the full session UUID, as a whole whitespace token
 * with surrounding punctuation removed. Prefixes and substrings never match.
 */
export function mailApprovalNamesTarget(operatorText: string, recipient: AgentMailEndpointIdentity): boolean {
	if (typeof operatorText !== "string" || !operatorText.trim()) return false;
	if (!isRecipient(recipient)) return false;
	const tokens = operatorTokens(operatorText);
	const sessionId = recipient.sessionId.toLowerCase();
	const handle = recipient.handle?.trim().toLowerCase();
	return tokens.some(token => token === sessionId || (handle !== undefined && handle.length > 0 && token === handle));
}

function stillArmed(scope: MailApprovalScope): boolean {
	return !scope.settled && !scope.lifetime.signal.aborted && Date.now() < scope.expiresAt;
}

async function consult(
	scope: MailApprovalScope,
	request: AgentMailApprovalRequest,
	signal: AbortSignal | undefined,
): Promise<AgentMailApproval> {
	if (!stillArmed(scope)) return "cancel";
	if (typeof request !== "object" || request === null || !isRecipient(request.recipient)) return "cancel";
	if (scope.sourceSessionId !== undefined && request.sender?.sessionId !== scope.sourceSessionId) return "cancel";
	if (!mailApprovalNamesTarget(scope.operatorText, request.recipient)) return "cancel";
	if (scope.dialogued.has(request.recipient.sessionId)) return "cancel";
	scope.dialogued.add(request.recipient.sessionId);
	if (signal?.aborted) return "cancel";
	const call = new AbortController();
	const relayAbort = () => call.abort();
	const relays = [scope.lifetime.signal, signal].filter((candidate): candidate is AbortSignal => candidate !== undefined);
	for (const relay of relays) relay.addEventListener("abort", relayAbort, { once: true });
	if (relays.some(relay => relay.aborted)) call.abort();
	try {
		const decision = await scope.approve(request, call.signal);
		if (scope.settled || scope.lifetime.signal.aborted || signal?.aborted) return "cancel";
		return decision === "once" || decision === "always" ? decision : "cancel";
	} catch {
		return "cancel";
	} finally {
		for (const relay of relays) relay.removeEventListener("abort", relayAbort);
	}
}

/**
 * Arm the scope for one trusted local submission and run its dispatch inside
 * it. An empty submission or a missing callback establishes no scope at all,
 * so no dialog can be opened on its behalf.
 */
export async function withMailApprovalContext<T>(
	operatorText: string,
	approve: MailApprovalApprover,
	run: () => Promise<T>,
	binding?: MailApprovalContextBinding,
): Promise<T> {
	if (typeof operatorText !== "string") throw new TypeError("operatorText must be the submitted string");
	if (typeof approve !== "function") throw new TypeError("approve must be the local selector callback");
	if (typeof run !== "function") throw new TypeError("run must be the submission dispatch");
	if (!operatorText.trim()) return run();
	const scope: MailApprovalScope = {
		operatorText,
		approve,
		sourceSessionId: binding?.sourceSessionId?.trim() || undefined,
		expiresAt: Date.now() + MAIL_APPROVAL_CONTEXT_TTL_MS,
		dialogued: new Set(),
		lifetime: new AbortController(),
		settled: false,
	};
	try {
		return await scopes.run(scope, run);
	} finally {
		scope.settled = true;
		scope.lifetime.abort();
	}
}

/**
 * The approval callback for a tool running inside an armed submission, or
 * `undefined` when nothing trusted armed this call. The returned callback
 * closes over `signal`, denies on abort, and denies once its submission has
 * settled, even when a detached task kept the function alive.
 */
export function currentMailApproval(
	signal?: AbortSignal,
): ((request: AgentMailApprovalRequest) => Promise<AgentMailApproval>) | undefined {
	const scope = scopes.getStore();
	if (!scope || !stillArmed(scope)) return undefined;
	return request => consult(scope, request, signal);
}
