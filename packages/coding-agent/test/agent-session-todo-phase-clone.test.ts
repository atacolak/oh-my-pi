import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * Regression coverage: `AgentSession.#cloneTodoPhases` used to clone only
 * `{ name, tasks }`, dropping a phase's `kind` on every set/get. A passive phase
 * then returned to the automation path — auto-promotion, next-action selection,
 * and stop reminders — after any `todo view` or later op. The contract: a
 * phase's kind survives a `setTodoPhases` → `getTodoPhases` round-trip, the same
 * clone every storage read/write goes through.
 */
describe("AgentSession todo phase clone", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.inMemory();

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": true, "todo.reminders": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
	});

	it("preserves a passive phase kind across setTodoPhases/getTodoPhases", () => {
		session.setTodoPhases([
			{ name: "Reference", kind: "passive", tasks: [{ content: "retain report", status: "pending" }] },
			{ name: "Work", tasks: [{ content: "ship change", status: "in_progress" }] },
		]);
		expect(session.getTodoPhases()).toEqual([
			{ name: "Reference", kind: "passive", tasks: [{ content: "retain report", status: "pending" }] },
			{ name: "Work", tasks: [{ content: "ship change", status: "in_progress" }] },
		]);
	});
});
