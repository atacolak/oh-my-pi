/**
 * `agent_sessions`: thin rendering consumer of the session owner's bounded peer
 * discovery (opt-in tool; see `prompts/tools/agent-sessions.md`).
 *
 * The owner merges the native identity catalog with live socket publications
 * and proves availability by handshake; this tool only renders the bounded
 * result with its truncation information.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { AgentMailDiscoveryResult, AgentMailPeerSession } from "../session/session-mail";
import agentSessionsDescription from "../prompts/tools/agent-sessions.md" with { type: "text" };
import type { ToolSession } from ".";

const agentSessionsSchema = type({
	"query?": type("string").describe("substring matched against actor handle and session UUID"),
	"live_only?": type("boolean").describe("only sessions proven live by handshake"),
	"limit?": type("number").describe("maximum entries returned (default 25, max 100)"),
});

type AgentSessionsParams = typeof agentSessionsSchema.infer;

interface AgentSessionsDetails {
	discovery: AgentMailDiscoveryResult;
}

function formatEntry(entry: AgentMailPeerSession): string {
	const label = entry.handle ?? "unnamed";
	const facts = [
		entry.pid !== null ? `pid ${entry.pid}` : undefined,
		entry.model ?? undefined,
		entry.cwd ? `cwd ${shortenPath(entry.cwd)}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(", ");
	return `- ${label} ${entry.sessionId} [${entry.availability}]${facts ? ` (${facts})` : ""}`;
}

export class AgentSessionsTool implements AgentTool<typeof agentSessionsSchema, AgentSessionsDetails> {
	readonly name = "agent_sessions";
	readonly approval = "read" as const;
	readonly label = "Agent Sessions";
	readonly summary = "List peer agent sessions with proven availability and canonical ids";
	readonly description = prompt.render(agentSessionsDescription);
	readonly parameters = agentSessionsSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: AgentSessionsParams,
	): Promise<AgentToolResult<AgentSessionsDetails>> {
		const mail = this.session.agentMail;
		if (!mail) {
			return {
				content: [{ type: "text", text: "This session has no agent mail owner; discovery is unavailable." }],
				details: { discovery: { sessions: [], total: 0, truncated: false } },
				isError: true,
			};
		}
		let discovery: AgentMailDiscoveryResult;
		try {
			discovery = await mail.discover({
				...(params.query === undefined ? {} : { query: params.query }),
				...(params.live_only === undefined ? {} : { liveOnly: params.live_only }),
				...(params.limit === undefined ? {} : { limit: params.limit }),
			});
		} catch (error) {
			return {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				details: { discovery: { sessions: [], total: 0, truncated: false } },
				isError: true,
			};
		}
		const footer = `(${discovery.sessions.length} of ${discovery.total} session(s)${discovery.truncated ? "; truncated — narrow with a query or raise the limit up to 100" : ""})`;
		return {
			content: [
				{
					type: "text",
					text: discovery.sessions.length
						? `${discovery.sessions.map(formatEntry).join("\n")}\n${footer}`
						: "No peer sessions match.",
				},
			],
			details: { discovery },
		};
	}
}
