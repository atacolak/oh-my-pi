import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveLaunchAgent, rootAgentToolNames } from "@oh-my-pi/pi-coding-agent/cli/launch-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { RootAgentToolProfile } from "@oh-my-pi/pi-coding-agent/session/role-tool-refresh";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { cfgToolsXdev } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const ROLE_NAME = "actor-switch-override";

function roleDocument(name: string, tools: string[]): string {
	return `---\nname: ${name}\ndescription: Journal adoption fixture\ntools: [${tools.join(", ")}]\n---\n\nFixture body.\n`;
}

describe("actor tools across journal adoption", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let sessionCount = 0;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@actor-tool-switch-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cfgToolsXdev.set(Settings.instance, false);
		sessions = [];
		sessionCount = 0;
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function writeRole(name: string, tools: string[]): Promise<string> {
		const dir = path.join(tempDir.path(), ".omp", "agents");
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, `${name}.md`);
		await fs.writeFile(filePath, roleDocument(name, tools), "utf-8");
		return filePath;
	}

	function profileOf(agent: AgentDefinition, toolNames: string[]): RootAgentToolProfile {
		if (agent.filePath === undefined) throw new Error("Fixture role must resolve to a file path");
		return { filePath: agent.filePath, source: agent.source, name: agent.name, toolNames: [...toolNames] };
	}

	async function makeSession(agent: AgentDefinition): Promise<AgentSession> {
		const toolNames = rootAgentToolNames(agent) ?? [];
		const sessionDir = path.join(tempDir.path(), `sessions-${sessionCount++}`);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.create(tempDir.path(), sessionDir),
			authStorage,
			modelRegistry,
			settings: Settings.instance,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			agentName: agent.name,
			toolNames,
			rootAgentProfile: profileOf(agent, toolNames),
		});
		sessions.push(session);
		return session;
	}

	it("refuses to adopt another UUID journal that saves a revoked tool", async () => {
		await writeRole(ROLE_NAME, ["read", "glob"]);
		const agent = (await resolveLaunchAgent(ROLE_NAME, tempDir.path()))!;

		const target = await makeSession(agent);
		const targetFile = target.sessionFile;
		const targetId = target.sessionId;
		if (!targetFile) throw new Error("Target journal was not persisted");
		await target.applyActorToolChange({
			add: [],
			remove: ["glob"],
			expectedRevision: target.getActorToolState().revision,
		});
		await target.flushToDisk();
		await target.dispose();
		sessions.splice(sessions.indexOf(target), 1);

		const source = await makeSession(agent);
		const sourceFile = source.sessionFile;
		const sourceId = source.sessionId;
		expect(source.getEnabledToolNames()).toContain("glob");

		await expect(source.switchSession(targetFile)).rejects.toThrow(`omp --resume ${targetId}`);

		expect(source.sessionId).toBe(sourceId);
		expect(source.sessionFile).toBe(sourceFile);
		expect(source.getEnabledToolNames()).toContain("glob");
		expect(source.getActorToolState().removed).toEqual([]);
	});

	it("refuses to carry this journal's selection into another UUID journal", async () => {
		await writeRole(ROLE_NAME, ["read", "glob"]);
		const agent = (await resolveLaunchAgent(ROLE_NAME, tempDir.path()))!;

		const target = await makeSession(agent);
		const targetFile = target.sessionFile;
		const targetId = target.sessionId;
		if (!targetFile) throw new Error("Target journal was not persisted");
		target.sessionManager.appendMessage({ role: "user", content: "target journal", timestamp: Date.now() });
		await target.flushToDisk();
		await target.sessionManager.ensureOnDisk();
		await target.dispose();
		sessions.splice(sessions.indexOf(target), 1);

		const source = await makeSession(agent);
		const sourceId = source.sessionId;
		await source.applyActorToolChange({
			add: ["grep"],
			remove: [],
			expectedRevision: source.getActorToolState().revision,
		});

		await expect(source.switchSession(targetFile)).rejects.toThrow(`omp --resume ${targetId}`);

		expect(source.sessionId).toBe(sourceId);
		expect(source.getEnabledToolNames()).toContain("grep");
		expect(source.getActorToolState().added).toEqual(["grep"]);
	});

	it("keeps the live tool selection when adopting the same UUID journal", async () => {
		await writeRole(ROLE_NAME, ["read", "glob"]);
		const agent = (await resolveLaunchAgent(ROLE_NAME, tempDir.path()))!;
		const session = await makeSession(agent);
		const sourceFile = session.sessionFile;
		const sessionId = session.sessionId;
		if (!sourceFile) throw new Error("Journal was not persisted");
		await session.applyActorToolChange({
			add: [],
			remove: ["glob"],
			expectedRevision: session.getActorToolState().revision,
		});
		await session.flushToDisk();

		const journal = await fs.readFile(sourceFile, "utf-8");
		const lines = journal
			.split("\n")
			.filter(line => !line.includes(`"customType":"actor-tool-change"`))
			.join("\n");
		const copyFile = path.join(tempDir.path(), "same-identity-branch.jsonl");
		await fs.writeFile(copyFile, lines, "utf-8");

		expect(await session.switchSession(copyFile)).toBe(true);
		expect(session.sessionId).toBe(sessionId);
		expect(session.getEnabledToolNames()).not.toContain("glob");
		expect(session.getActorToolState().removed).toEqual(["glob"]);
	});

	it("still switches to an unrelated journal without tool overrides", async () => {
		await writeRole(ROLE_NAME, ["read", "glob"]);
		const agent = (await resolveLaunchAgent(ROLE_NAME, tempDir.path()))!;

		const target = await makeSession(agent);
		const targetFile = target.sessionFile;
		const targetId = target.sessionId;
		if (!targetFile) throw new Error("Target journal was not persisted");
		target.sessionManager.appendMessage({ role: "user", content: "target journal", timestamp: Date.now() });
		await target.flushToDisk();
		await target.sessionManager.ensureOnDisk();
		await target.dispose();
		sessions.splice(sessions.indexOf(target), 1);

		const source = await makeSession(agent);
		expect(await source.switchSession(targetFile)).toBe(true);
		expect(source.sessionId).toBe(targetId);
		expect(source.getEnabledToolNames()).toContain("glob");
	});
});
