import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveLaunchAgent, rootAgentToolNames } from "@oh-my-pi/pi-coding-agent/cli/launch-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { RootAgentToolProfile } from "@oh-my-pi/pi-coding-agent/session/role-tool-refresh";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { cfgToolsXdev } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function roleDocument(name: string, tools: string[]): string {
	return `---\nname: ${name}\ndescription: Actor override fixture\ntools: [${tools.join(", ")}]\n---\n\nFixture body.\n`;
}

describe("operator actor tool overrides", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@actor-tool-override-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cfgToolsXdev.set(Settings.instance, false);
		sessions = [];
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

	async function makeSession(agent: AgentDefinition, extra: Partial<CreateAgentSessionOptions> = {}) {
		const toolNames = rootAgentToolNames(agent) ?? [];
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
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
			...extra,
		});
		sessions.push(session);
		return session;
	}

	it("removes and restores a role tool on the configured root", async () => {
		const name = "actor-override-glob";
		await writeRole(name, ["read", "glob"]);
		const agent = (await resolveLaunchAgent(name, tempDir.path()))!;
		const session = await makeSession(agent);
		expect(session.getEnabledToolNames()).toEqual(expect.arrayContaining(["read", "glob"]));

		const removed = await session.applyActorToolChange({
			add: [],
			remove: ["glob"],
			expectedRevision: session.getActorToolState().revision,
		});
		expect(removed.removed).toEqual(["glob"]);
		expect(removed.active).not.toContain("glob");
		expect(session.getEnabledToolNames()).not.toContain("glob");
		expect(session.agent.state.tools.map(tool => tool.name)).not.toContain("glob");

		const restored = await session.applyActorToolChange({
			add: ["glob"],
			remove: [],
			expectedRevision: removed.revision,
		});
		expect(restored.removed).toEqual([]);
		expect(restored.active).toContain("glob");
		expect(session.getEnabledToolNames()).toContain("glob");
		expect(session.agent.state.tools.map(tool => tool.name)).toContain("glob");
	});

	it("cannot use a new write grant until its journal commit succeeds", async () => {
		const name = "actor-write-transaction";
		await writeRole(name, ["read"]);
		const agent = (await resolveLaunchAgent(name, tempDir.path()))!;
		const session = await makeSession(agent);
		const change = { add: ["write"], remove: [], expectedRevision: session.getActorToolState().revision };
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const save = spyOn(session.sessionManager, "appendEntriesAtomically").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("fixture: journal unavailable");
		});
		const attempted = session.applyActorToolChange(change);
		try {
			await entered.promise;
			expect(session.getActorToolState().active).not.toContain("write");
			expect(session.getToolForEvalBridge("write")).toBeUndefined();
		} finally {
			release.resolve();
			await expect(attempted).rejects.toThrow("journal unavailable");
			save.mockRestore();
		}
		expect(session.getActorToolState().revision).toBe(change.expectedRevision);
		await session.applyActorToolChange(change);
		const tool = session.getToolForEvalBridge("write");
		if (!tool) throw new Error("Accepted write grant did not expose a tool");
		const file = tempDir.join("receipt.txt");
		await tool.execute("actor-write", { path: file, content: "granted" });
		expect(await Bun.file(file).text()).toBe("granted");
	});

	it("adds a native builtin the role never granted", async () => {
		const name = "actor-override-grep";
		await writeRole(name, ["read", "glob"]);
		const agent = (await resolveLaunchAgent(name, tempDir.path()))!;
		const session = await makeSession(agent);
		const state = session.getActorToolState();
		expect(state.active).not.toContain("grep");
		expect(state.available).toContain("grep");

		const added = await session.applyActorToolChange({
			add: ["grep"],
			remove: [],
			expectedRevision: state.revision,
		});
		expect(added.added).toEqual(["grep"]);
		expect(added.active).toContain("grep");
		expect(session.getEnabledToolNames()).toContain("grep");
		expect(session.getToolByName("grep")).toBeDefined();
		expect(session.agent.state.tools.map(tool => tool.name)).toContain("grep");
	});

	it("removes glob only from this actor, refuses its queued call, restores the choice at boot, and can grant it back", async () => {
		const name = "scoped-glob";
		await writeRole(name, ["read", "glob"]);
		const profile = (await resolveLaunchAgent(name, tempDir.path()))!;
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const target = await makeSession(profile, { sessionManager: manager });
		const sibling = await makeSession(profile);
		const glob = target.agent.state.tools.find(tool => tool.name === "glob");
		if (!glob) throw new Error("Expected a callable glob before revocation");
		const revision = target.getActorToolState().revision;
		const off = await target.applyActorToolChange({ remove: ["glob"], add: [], expectedRevision: revision });
		expect(off.active).not.toContain("glob");
		expect(sibling.getActorToolState().active).toContain("glob");
		expect(target.getToolForEvalBridge("glob")).toBeUndefined();
		await expect(glob.execute("late-glob", { path: "*.md" })).rejects.toThrow(/revoked/);
		await expect(target.applyActorToolChange({ remove: [], add: ["glob"], expectedRevision: revision })).rejects.toThrow(/stale/i);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing persisted target");
		await target.dispose();
		sessions.splice(sessions.indexOf(target), 1);
		const resumed = await makeSession(profile, { sessionManager: await SessionManager.open(file) });
		expect(resumed.getActorToolState().active).not.toContain("glob");
		await resumed.applyActorToolChange({ remove: [], add: ["glob"], expectedRevision: resumed.getActorToolState().revision });
		const regranted = resumed.getToolForEvalBridge("glob");
		if (!regranted) throw new Error("Restored glob must dispatch");
		const matches = await regranted.execute("after-grant", { path: ".omp/agents/*.md" });
		expect(JSON.stringify(matches.content)).toContain(`${name}.md`);
		expect(resumed.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "actor-tool-change"))
			.toMatchObject([
				{ display: true, details: { removed: ["glob"], added: [] } },
				{ display: true, details: { removed: [], added: ["glob"] } },
			]);
	});

	it("does not widen a restricted session past its startup ceiling", async () => {
		const name = "actor-override-restricted";
		await writeRole(name, ["read"]);
		const agent = (await resolveLaunchAgent(name, tempDir.path()))!;
		const session = await makeSession(agent, { restrictToolNames: true });
		const before = session.getActorToolState();

		await expect(
			session.applyActorToolChange({ add: ["bash"], remove: [], expectedRevision: before.revision }),
		).rejects.toThrow();
		expect(session.getEnabledToolNames()).toContain("read");
		expect(session.getEnabledToolNames()).not.toContain("bash");
	});

	it("does not treat an unrelated explicit SDK ceiling as a role roster", async () => {
		const name = "actor-override-ceiling";
		await writeRole(name, ["read", "glob"]);
		const agent = (await resolveLaunchAgent(name, tempDir.path()))!;
		const session = await makeSession(agent, { toolNames: ["read"] });
		const before = session.getActorToolState();
		expect(before.active).toEqual(["read"]);

		await expect(
			session.applyActorToolChange({ add: ["glob"], remove: [], expectedRevision: before.revision }),
		).rejects.toThrow();
		expect(session.getEnabledToolNames()).toContain("read");
		expect(session.getEnabledToolNames()).not.toContain("glob");
	});
});
