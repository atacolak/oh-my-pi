/**
 * `agent_mail`: thin schema/rendering consumer of the session owner's mail
 * surface (opt-in tool; see `prompts/tools/agent-mail.md`).
 *
 * All authority stays on {@link SessionMail} through {@link ToolSession.agentMail}:
 * the owner resolves the peer, issues and verifies send capabilities, performs
 * the native-socket delivery, and derives bounded history from the current
 * journal. This tool renders the owner's truthful outcomes — including UNKNOWN,
 * which is never resent automatically.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
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
	"delivery?": type('"queue" | "steer"').describe("recipient-side path: queue behind the run, or steer into it (send)"),
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
	return `[${record.messageId}] thread ${record.threadId} from ${sender}${reply} (${record.sender.sessionId}): ${record.body}`;
}

function admissionText(admission: "admitted" | "queued" | "steering"): string {
	if (admission === "steering") return "steered into the recipient's active run";
	if (admission === "queued") return "queued on the recipient's input path behind its current run";
	return "admitted into the recipient's input path";
}

function renderSend(result: AgentMailSendResult): AgentToolResult<AgentMailDetails> {
	if (result.status === "accepted") {
		const receipt = result.receipt;
		const recipientLabel = receipt.recipient.handle ?? receipt.recipient.sessionId;
		return {
			content: [
				{
					type: "text",
					text: `Mail ${receipt.messageId} (thread ${receipt.threadId}) accepted by ${recipientLabel}: recorded and ${admissionText(receipt.admission)}${receipt.busy ? " while its run was busy" : ""}. The recipient owner admitted it; it has not necessarily been read or answered yet.`,
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
	readonly summary = "Send mail to a peer agent session and read this session's inbox";
	readonly description = prompt.render(agentMailDescription);
	readonly parameters = agentMailSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: AgentMailParams): Promise<AgentToolResult<AgentMailDetails>> {
		const mail = this.session.agentMail;
		if (!mail) return this.fail("This session has no agent mail owner; mail is unavailable.");
		if (params.op === "read") {
			try {
				const result = mail.read({
					...(params.thread === undefined ? {} : { threadId: params.thread }),
					...(params.limit === undefined ? {} : { limit: params.limit }),
				});
				const footer = `(${result.messages.length} of ${result.total} record(s)${result.truncated ? "; truncated — re-read with a thread filter or a higher limit up to 100" : ""})`;
				return {
					content: [
						{
							type: "text",
							text: result.messages.length
								? `${result.messages.map(formatRecord).join("\n\n")}\n${footer}`
								: "Inbox is empty for this filter.",
						},
					],
					details: { op: "read", result },
				};
			} catch (error) {
				return this.fail(error instanceof Error ? error.message : String(error));
			}
		}
		try {
			const result = await mail.send({
				to: params.to ?? "",
				message: params.message ?? "",
				...(params.delivery === undefined ? {} : { delivery: params.delivery }),
				...(params.thread === undefined ? {} : { threadId: params.thread }),
				...(params.reply_to === undefined ? {} : { replyTo: params.reply_to }),
			});
			return renderSend(result);
		} catch (error) {
			return this.fail(error instanceof Error ? error.message : String(error));
		}
	}

	private fail(message: string): AgentToolResult<AgentMailDetails> {
		return {
			content: [{ type: "text", text: message }],
			details: { op: "error", message },
			isError: true,
		};
	}
}
