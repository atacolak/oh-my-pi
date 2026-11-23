import { afterEach, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readSessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

for (const row of [
	{ label: "default to a named profile", current: undefined, target: "lead", allowed: false },
	{ label: "named profile to default", current: "lead", target: undefined, allowed: false },
	{ label: "same named profile", current: "lead", target: "lead", allowed: true },
]) {
	it(`resume ${row.label} preserves the loaded profile instead of silently mixing instructions`, async () => {
		using temp = TempDir.createSync("@omp-resume-profile-");
		const target = SessionManager.create(temp.path(), temp.join("target"));
		if (row.target) await target.setRootAgent(row.target);
		target.appendMessage({ role: "user", content: "Target conversation", timestamp: 1 });
		await target.ensureOnDisk();
		await target.flush();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Missing target fixture journal");
		const targetId = target.getSessionId();
		await target.close();
		const manager = SessionManager.create(temp.path(), temp.join("source"));
		if (row.current) await manager.setRootAgent(row.current);
		manager.appendMessage({ role: "user", content: "Source conversation", timestamp: 2 });
		await manager.ensureOnDisk();
		const sourceId = manager.getSessionId();
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai", "test-key");
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider requests in resume test"));
		try {
			const { session } = await createAgentSession({
				cwd: temp.path(),
				agentDir: temp.join("agent"),
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, temp.join("models.yml"), { ignoreLocalModelConfig: true }),
				model: getBundledModel("openai", "gpt-4o-mini"),
				sessionManager: manager,
				rootAgentName: row.current,
				customSystemPrompt: "Stable loaded profile fixture",
				toolNames: ["read"],
				settings: Settings.isolated({ "memory.backend": "off", "compaction.enabled": false }),
				contextFiles: [],
				skills: [],
				rules: [],
				promptTemplates: [],
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				deferSkillDescriptionCompression: true,
			});
			try {
				const prompt = [...session.systemPrompt];
				const messages = [...session.agent.state.messages];
				const abort = vi.spyOn(session, "abort");
				if (row.allowed) {
					expect(await session.switchSession(targetFile)).toBe(true);
					expect(manager.getSessionId()).toBe(targetId);
					expect(session.agent.state.messages).not.toEqual(messages);
				} else {
					await expect(session.switchSession(targetFile)).rejects.toThrow("different agent profile");
					expect(abort).not.toHaveBeenCalled();
					expect(manager.getSessionId()).toBe(sourceId);
					expect(session.agent.state.messages).toEqual(messages);
				}
				expect(session.getAgentProfileName()).toBe(row.current);
				expect(session.systemPrompt).toEqual(prompt);
				expect((await readSessionHeader(targetFile))?.rootAgent).toBe(row.target);
				expect(fetch).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			auth.close();
		}
	}, 20_000);
}
