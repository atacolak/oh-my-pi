/**
 * `agent_mail`: thin schema/rendering consumer of the session owner's mail
 * surface (opt-in tool; see `prompts/tools/agent-mail.md`).
 *
 * All authority stays on {@link SessionMail} through {@link ToolSession.agentMail}:
 * the owner resolves the peer, issues and verifies send capabilities, deposits
 * the mail in the recipient journal, and derives bounded history from the
 * current journal. This tool renders the owner's truthful outcomes — including
 * UNKNOWN, which is never resent automatically.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { currentMailApproval } from "../session/mail-approval-context";
import type {
	AgentMailReadResult,
	AgentMailRecord,
	AgentMailSendResult,
} from "../session/session-mail";
import agentMailDescription from "../prompts/tools/agent-mail.md" with { type: "text" };
import type { ToolSession } from ".";

const agentMailSchema = type({
	op: '"send" | "read"',
	"to?": type("string").describe("recipient session: canonical UUID, unique id prefix, or actor handle (send)"),
	"message?": type("string").describe("mail body (send)"),
	"reply_to?": type("string").describe("message id this mail answers (send)"),
	"thread?": type("string").describe("thread id to continue, or thread to read"),
	"folder?": type('"inbox" | "requests"').describe(
		"mailbox to read: inbox (default), or historical requests",
	),
	"before?": type("string").describe("read the page older than this message id in the same folder/thread (read)"),
	"limit?": type("number").describe("maximum records to read (read; default 20, max 100)"),
});

type AgentMailParams = typeof agentMailSchema.infer;

interface AgentMailSendDetails {
	op: "send";
	result: AgentMailSendResult;
}

interface AgentMailReadDetails {
	op: "read";
	result: AgentMailReadResult;
}

interface AgentMailErrorDetails {
	op: "error";
	message: string;
}

type AgentMailDetails = AgentMailSendDetails | AgentMailReadDetails | AgentMailErrorDetails;

function formatRecord(record: AgentMailRecord): string {
	const sender = record.sender.handle ?? record.sender.sessionId;
	const reply = record.replyTo ? ` (reply to ${record.replyTo})` : "";
	const folder = record.folder === "requests" ? " [requests]" : "";
	return `[${record.messageId}] thread ${record.threadId}${folder} from ${sender}${reply} (${record.sender.sessionId}): ${record.body}`;
}

function renderSend(result: AgentMailSendResult): AgentToolResult<AgentMailDetails> {
	if (result.status === "accepted") {
		const receipt = result.receipt;
		const recipientLabel = receipt.recipient.handle ?? receipt.recipient.sessionId;
		const owner = receipt.target.bootId === null ? "no live owner; the mail waits in its saved journal" : "its owner was live";
		return {
			content: [
				{
					type: "text",
					text: `Mail ${receipt.messageId} (thread ${receipt.threadId}) for ${recipientLabel}: stored in the recipient's journal (admission: ${receipt.admission}; ${owner}). Nothing was woken, steered or queued; the receipt does not say whether it was read or acted on.`,
				},
			],
			details: { op: "send", result },
		};
	}
	const label = result.status === "unknown" ? "UNKNOWN" : "refused";
	const suffix =
		result.status === "unknown"
			? " The mail may or may not have been delivered; it was NOT resent automatically."
			: "";
	return {
		content: [{ type: "text", text: `Mail send ${label}: ${result.error}.${suffix}` }],
		details:
			result.status === "unknown"
				? { op: "error", message: result.error }
				: { op: "send", result },
		isError: true,
	};
}

export class AgentMailTool implements AgentTool<typeof agentMailSchema, AgentMailDetails> {
	readonly name = "agent_mail";
	readonly approval = "exec" as const;
	readonly label = "Agent Mail";
	readonly summary = "Deposit mail in a peer session's journal and deliberately read this session's mail";
	readonly description = prompt.render(agentMailDescription);
	readonly parameters = agentMailSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: AgentMailParams, signal?: AbortSignal): Promise<AgentToolResult<AgentMailDetails>> {
		const mail = this.session.agentMail;
		if (!mail) return this.#fail("This session has no agent mail owner; mail is unavailable.");
		if (params.op === "read") {
			const folder = params.folder ?? "inbox";
			try {
				const result = mail.read({
					folder,
					...(params.thread === undefined ? {} : { threadId: params.thread }),
					...(params.limit === undefined ? {} : { limit: params.limit }),
					...(params.before === undefined ? {} : { before: params.before }),
				});
				const more = result.truncated
					? result.nextBefore
						? `; older matches remain: pass before: "${result.nextBefore}" with the same folder and thread`
						: "; older matches remain"
					: "";
				const footer = `(${result.messages.length} of ${result.total} record(s)${more})`;
				const body = result.messages.length
					? `${result.messages.map(formatRecord).join("\n\n")}\n${footer}`
					: folder === "requests"
						? "No historical requests for this filter."
						: "Inbox is empty for this filter.";
				return { content: [{ type: "text", text: body }], details: { op: "read", result } };
			} catch (error) {
				return this.#fail(error instanceof Error ? error.message : String(error));
			}
		}
		try {
			const result = await mail.send(
				{
					to: params.to ?? "",
					message: params.message ?? "",
					...(params.thread === undefined ? {} : { threadId: params.thread }),
					...(params.reply_to === undefined ? {} : { replyTo: params.reply_to }),
				},
				{ approve: currentMailApproval(signal), signal },
			);
			return renderSend(result);
		} catch (error) {
			return this.#fail(error instanceof Error ? error.message : String(error));
		}
	}

	#fail(message: string): AgentToolResult<AgentMailDetails> {
		return {
			content: [{ type: "text", text: message }],
			details: { op: "error", message },
			isError: true,
		};
	}
}
