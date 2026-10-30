import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { loadQueuedMessages } from "../src/session/queued-message-persist";

function queuedText(messages: readonly AgentMessage[]): string[] {
	const out: string[] = [];
	for (const message of messages) {
		const content: unknown = "content" in message ? message.content : undefined;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const text = (block as { text?: unknown } | null)?.text;
			if (typeof text === "string") out.push(text);
		}
	}
	return out;
}

describe("persisted steering/followUp queues", () => {
	let tempDir: TempDir;
	const authStorages: AuthStorage[] = [];
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-queued-persist-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			try {
				await session.dispose();
			} catch {
				/* test isolation */
			}
		}
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		await tempDir?.remove();
	});

	async function makeSession(sessionManager: SessionManager): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: async () => ({ content: ["ok"], stopReason: "stop" }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		sessions.push(session);
		return session;
	}

	it("survives a process-style resume from the session sidecar", async () => {
		const sessionDir = tempDir.join("sessions");
		const firstManager = SessionManager.create(tempDir.path(), sessionDir);
		const first = await makeSession(firstManager);
		await first.sessionManager.ensureOnDisk();
		const sessionFile = first.sessionFile;
		expect(sessionFile).toBeTruthy();

		first.agent.steer({
			role: "user",
			content: [{ type: "text", text: "do not lose this" }],
			steering: true,
			attribution: "user",
			timestamp: Date.now(),
		});
		first.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "and this after" }],
			attribution: "user",
			timestamp: Date.now(),
		});
		const snapshot = loadQueuedMessages(sessionFile!);
		expect(queuedText(snapshot?.steering ?? [])).toContain("do not lose this");
		expect(queuedText(snapshot?.followUp ?? [])).toContain("and this after");

		const secondManager = await SessionManager.open(sessionFile!, sessionDir);
		const second = await makeSession(secondManager);
		expect(queuedText(second.agent.peekSteeringQueue())).toContain("do not lose this");
		expect(queuedText(second.agent.peekFollowUpQueue())).toContain("and this after");
	});
});
