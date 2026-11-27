/**
 * A completed operator tool-selection change commits one typed `actor-tool-change`
 * custom message to the journal and paints it inline, then reaches the model on
 * the next interaction exactly once: through ordinary history when idle, and
 * through the live run's next model request when the change lands mid-turn,
 * without steering, a second journal entry, or a duplicate display.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CustomMessageEntry } from "@oh-my-pi/pi-agent-core/compaction";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, type CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type } from "@oh-my-pi/omptype";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const ACTOR_TOOL_CHANGE_MESSAGE_TYPE = "actor-tool-change";
const NOTICE_MARKER = 'id="actor-tool-change"';

interface ActorToolChangeDetails {
	sessionId: string;
	added: string[];
	removed: string[];
	override: { added: string[]; removed: string[] };
	origin: string;
	scope: string;
}

function isActorToolChange(message: unknown): message is CustomMessage<ActorToolChangeDetails> {
	const custom = message as CustomMessage<ActorToolChangeDetails>;
	return custom?.role === "custom" && custom.customType === ACTOR_TOOL_CHANGE_MESSAGE_TYPE;
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function requestText(messages: Context["messages"]): string {
	return messages
		.map(message => {
			if (typeof message.content === "string") return message.content;
			return message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
		})
		.join("\n");
}

describe("actor tool change journal notice", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
	});

	async function makeSession(options: {
		sessionManager?: SessionManager;
		tools?: AgentTool[];
		responses?: MockResponseSource;
	}): Promise<{ session: AgentSession; mock: MockModel }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses: options.responses ?? [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: options.tools ?? [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const created = new AgentSession({
			agent,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			...(options.tools ? { toolRegistry: new Map(options.tools.map(tool => [tool.name, tool] as const)) } : {}),
		});
		session = created;
		return { session: created, mock };
	}

	it("commits one typed notice, paints it inline, and the next model request carries it once", async () => {
		const sessionManager = SessionManager.inMemory();
		const { session: created, mock } = await makeSession({ sessionManager });
		const events: AgentSessionEvent[] = [];
		created.subscribe(event => events.push(event));

		await created.recordActorToolChange(["agent_mail"], ["bash"], {
			added: ["agent_mail"],
			removed: ["bash"],
		});

		const entries = sessionManager
			.getBranch()
			.filter(
				entry => entry.type === "custom_message" && entry.customType === ACTOR_TOOL_CHANGE_MESSAGE_TYPE,
			) as CustomMessageEntry<ActorToolChangeDetails>[];
		expect(entries).toHaveLength(1);
		const entry = entries[0]!;
		expect(entry.display).toBe(true);
		expect(typeof entry.content === "string" ? entry.content : "").toContain("<system-notice");
		expect(typeof entry.content === "string" ? entry.content : "").toContain("agent_mail");
		expect(typeof entry.content === "string" ? entry.content : "").toContain("bash");
		expect(entry.details?.sessionId).toBe(sessionManager.getSessionId());
		expect(entry.details?.added).toEqual(["agent_mail"]);
		expect(entry.details?.removed).toEqual(["bash"]);
		expect(entry.details?.override).toEqual({ added: ["agent_mail"], removed: ["bash"] });
		expect(entry.details?.origin).toBe("system");
		expect(entry.details?.scope).toBe("session");

		const painted = events.filter(
			event => (event.type === "message_start" || event.type === "message_end") && isActorToolChange(event.message),
		);
		expect(painted.map(event => event.type)).toEqual(["message_start", "message_end"]);

		const replayed = created.buildDisplaySessionContext().messages.filter(isActorToolChange);
		expect(replayed).toHaveLength(1);
		expect(replayed[0]?.timestamp).toBe(new Date(entry.timestamp).getTime());

		await created.prompt("continue");
		await created.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(countOccurrences(requestText(mock.calls[0]!.context.messages), NOTICE_MARKER)).toBe(1);
	});

	it("injects a mid-run change at the next model request without steering or a second journal entry", async () => {
		const sessionManager = SessionManager.inMemory();
		let created: AgentSession | undefined;
		let queuedAfterRecord = false;
		const probe: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Records an operator tool change",
			parameters: type({}),
			execute: async () => {
				await created!.recordActorToolChange(["agent_mail"], [], {
					added: ["agent_mail"],
					removed: [],
				});
				queuedAfterRecord = created!.agent.hasQueuedMessages();
				return { content: [{ type: "text", text: "RECORDED" }] };
			},
		};
		const made = await makeSession({
			sessionManager,
			tools: [probe],
			responses: [
				{ content: [{ type: "toolCall", id: "tc-probe", name: "probe", arguments: {} }] },
				{ content: ["Done"] },
			],
		});
		created = made.session;

		await created.prompt("go");
		await created.waitForIdle();

		expect(queuedAfterRecord).toBe(false);
		const entries = sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom_message" && entry.customType === ACTOR_TOOL_CHANGE_MESSAGE_TYPE);
		expect(entries).toHaveLength(1);
		expect(made.mock.calls).toHaveLength(2);
		expect(requestText(made.mock.calls[0]!.context.messages)).not.toContain(NOTICE_MARKER);
		expect(countOccurrences(requestText(made.mock.calls[1]!.context.messages), NOTICE_MARKER)).toBe(1);
	});

	it("paints the committed change in the interactive transcript as the applied delta", async () => {
		const sessionManager = SessionManager.inMemory();
		const { session: created } = await makeSession({ sessionManager });
		const ctx = createInteractiveModeContext({
			session: created,
			sessionManager,
			initialChatRendered: true,
		});
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
		ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
		ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
		ctx.renderInitialMessages = helpers.renderInitialMessages.bind(helpers);
		const controller = new EventController(ctx);
		ctx.eventController = controller;
		const dispatched: Promise<void>[] = [];
		created.subscribe(event => dispatched.push(controller.handleEvent(event)));

		await created.recordActorToolChange(["agent_mail"], ["bash"], {
			added: ["agent_mail"],
			removed: ["bash"],
		});
		await Promise.all(dispatched);

		const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("Tool access updated");
		expect(rendered).toContain("+agent_mail");
		expect(rendered).toContain("-bash");
		expect(rendered).not.toContain("system-notice");
	});
});
