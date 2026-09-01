import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("AgentSession adopted session-runtime changes", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-session-runtime-");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	it("keeps a temporary thinking level when adopting an unrelated sibling runtime edit", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(
			projectConfigPath,
			YAML.stringify({ defaultThinkingLevel: Effort.Low, autocompleteMaxVisible: 10 }, null, 2),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);

		settings.set("ask.enabled", false, "project");
		await Bun.write(
			projectConfigPath,
			YAML.stringify(
				{ defaultThinkingLevel: Effort.Low, autocompleteMaxVisible: 7, ask: { enabled: true } },
				null,
				2,
			),
		);
		await settings.flush();

		expect(settings.get("autocompleteMaxVisible")).toBe(7);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.High);
	});
});
