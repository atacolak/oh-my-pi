import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import {
	MEMORY_RECALL_CONTEXT_MESSAGE_TYPE,
	MEMORY_RECALL_ENTRY_TYPE,
} from "@oh-my-pi/pi-coding-agent/memory-backend/recall-entry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgCompactionKeepRecentTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionProviderBoundary } from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { getProjectAgentDir, getProjectDir, setProjectDir, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		// `Settings.loadIsolated` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
		AgentStorage.close();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it.each(["disabled", "empty", "failed"] as const)(
		"drops source Hindsight context after cwd rebind when destination recall is %s",
		async destinationRecall => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-memory-prompt-move-"));
			tempDirs.push(tempDir);
			const cwdA = path.join(tempDir, "cwd-a");
			const cwdB = path.join(tempDir, "cwd-b");
			const agentDir = path.join(tempDir, "agent");
			let moved = false;
			const recalledBanks: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const pathname = new URL(request.url).pathname;
					if (request.method === "PUT") return Response.json({});
					if (pathname.endsWith("/knowledge-base/tree")) return Response.json({ roots: [] });
					if (pathname.endsWith("/mental-models")) {
						return Response.json({
							items: [{ id: "source-model", name: "Source model", content: "SOURCE-MODEL-CANARY" }],
						});
					}
					if (pathname.endsWith("/memories/recall")) {
						recalledBanks.push(pathname.split("/")[4]!);
						if (moved && destinationRecall === "failed") return new Response("unavailable", { status: 503 });
						return Response.json({ results: moved ? [] : [{ id: "source-fact", text: "SOURCE-RECALL-CANARY" }] });
					}
					return new Response("Unexpected request", { status: 404 });
				},
			});
			const authStorage = createInMemoryAuthStorage();
			let session: AgentSession | undefined;
			try {
				// The failed-recall case keeps the bank but changes configuration.
				const destinationBank = destinationRecall === "failed" ? "source" : "destination";
				await Promise.all(
					[cwdA, cwdB].map(cwd =>
						Bun.write(
							path.join(getProjectAgentDir(cwd), "config.yml"),
							Bun.YAML.stringify({
								memory: { backend: "hindsight" },
								hindsight: {
									apiUrl: server.url.href,
									bankId: cwd === cwdA ? "source" : destinationBank,
									autoRecall: cwd === cwdA || destinationRecall !== "disabled",
									autoRetain: false,
									mentalModelsEnabled: cwd === cwdA,
									mentalModelAutoSeed: false,
								},
							}),
						),
					),
				);
				const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
				const sessionManager = SessionManager.create(cwdA, SessionManager.getDefaultSessionDir(cwdA, agentDir));
				authStorage.keys.setRuntime("openai", "test-key");
				({ session } = await createAgentSession({
					cwd: cwdA,
					agentDir,
					sessionManager,
					authStorage,
					modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
					settings,
					model: getBundledModel("openai", "gpt-4o-mini"),
					toolNames: ["read"],
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					rules: [],
					preloadedCustomToolPaths: [],
				}));
				const model = createMockModel({ handler: { content: ["ok"] } });
				session.agent.streamFn = model.stream;
				await session.applyMemoryBackend();
				await session.getHindsightSessionState()?.mentalModelsLoadPromise;
				const legacyScope: unknown = JSON.parse(session.getHindsightSessionState()!.recallContextScope);
				if (!Array.isArray(legacyScope)) throw new Error("expected structured recall scope");
				await session.sendCustomMessage({
					customType: MEMORY_RECALL_CONTEXT_MESSAGE_TYPE,
					content: "LEGACY-UNSCOPED-CANARY",
					display: false,
				});
				sessionManager.appendCustomEntry(MEMORY_RECALL_ENTRY_TYPE, {
					version: 1,
					scope: JSON.stringify(legacyScope.slice(0, -1)),
					text: "LEGACY-UNSCOPED-CANARY",
					memories: [{ id: "legacy-source", text: "LEGACY-UNSCOPED-CANARY" }],
				});
				await session.prompt("Summarize this project.");
				const sourcePrompt = model.calls[0]!.context.systemPrompt!.join("\n");
				expect(JSON.stringify(model.calls[0]!.context.messages)).toContain("SOURCE-RECALL-CANARY");
				expect(sourcePrompt).not.toContain("SOURCE-RECALL-CANARY");
				expect(sourcePrompt).toContain("SOURCE-MODEL-CANARY");
				expect(JSON.stringify(model.calls[0]!.context.messages)).not.toContain("LEGACY-UNSCOPED-CANARY");
				expect(recalledBanks).toEqual(["source"]);
				await session.prompt("Continue the same project.");
				expect(JSON.stringify(model.calls[1]!.context.messages)).toContain("SOURCE-RECALL-CANARY");
				expect(model.calls[1]!.context.systemPrompt!.join("\n")).toBe(sourcePrompt);
				const sourceRecallCount = recalledBanks.length;

				moved = true;
				await sessionManager.moveTo(cwdB);
				expect(sessionManager.getSessionDir().startsWith(`${agentDir}${path.sep}`)).toBe(true);
				await settings.reloadForCwd(cwdB);
				// Rebinding must clear memory without depending on a later skill/tool refresh.
				await rebindMemoryBackendForCwd(session);
				expect(session.getHindsightSessionState()?.bankId).toBe(destinationBank);
				const movedPrompt = session.agent.state.systemPrompt.join("\n");
				await session.prompt("Summarize the destination project.");
				expect(model.calls).toHaveLength(3);
				const destinationPrompt = model.calls[2]!.context.systemPrompt!.join("\n");
				expect(JSON.stringify(model.calls[2]!.context.messages)).not.toContain("SOURCE-RECALL-CANARY");
				expect(recalledBanks.slice(sourceRecallCount)).toEqual(
					destinationRecall === "disabled" ? [] : [destinationBank],
				);
				for (const prompt of [movedPrompt, destinationPrompt]) {
					expect(prompt).not.toContain("SOURCE-RECALL-CANARY");
					expect(prompt).not.toContain("SOURCE-MODEL-CANARY");
					expect(prompt).toContain("# Memory");
				}
				const deliveredRecall = sessionManager
					.getEntries()
					.filter(
						entry => entry.type === "custom_message" && entry.customType === MEMORY_RECALL_CONTEXT_MESSAGE_TYPE,
					);
				expect(JSON.stringify(deliveredRecall)).toContain("SOURCE-RECALL-CANARY");
				expect(JSON.stringify(deliveredRecall)).toContain("LEGACY-UNSCOPED-CANARY");
				await session.reload();
				await session.prompt("Continue after reloading the moved conversation.");
				expect(JSON.stringify(model.calls[3]!.context.messages)).not.toContain("SOURCE-RECALL-CANARY");
				cfgCompactionKeepRecentTokens.override(settings, 1);
				const abort = new AbortController();
				let compactionInput: Message[] | undefined;
				const convert = SessionProviderBoundary.prototype.convertToLlmForSideRequest;
				const intercept = spyOn(SessionProviderBoundary.prototype, "convertToLlmForSideRequest").mockImplementation(
					function (this: SessionProviderBoundary, messages: AgentMessage[]) {
						compactionInput = convert.call(this, messages);
						abort.abort();
						throw abort.signal.reason;
					},
				);
				try {
					await expect(session.compact()).rejects.toMatchObject({ name: "AbortError" });
				} finally {
					intercept.mockRestore();
				}
				expect(compactionInput).toBeDefined();
				expect(JSON.stringify(compactionInput)).not.toContain("SOURCE-RECALL-CANARY");
				expect(JSON.stringify(compactionInput)).not.toContain("LEGACY-UNSCOPED-CANARY");
			} finally {
				await session?.dispose();
				authStorage.close();
				await server.stop(true);
			}
		},
	);

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		await Bun.write(path.join(cwdB, "moved.txt"), "moved cwd");
		const agentDir = path.join(tempDir, "agent");

		const sessionManager = SessionManager.create(cwdA, SessionManager.getDefaultSessionDir(cwdA, agentDir));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "async.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			await sessionManager.moveTo(cwdB);
			expect(sessionManager.getSessionDir().startsWith(`${agentDir}${path.sep}`)).toBe(true);

			// A relative read proves cwd rebinding without creating the process-scoped shell snapshot cache.
			const readTool = session.getToolByName("read");
			if (!readTool) throw new Error("Expected read tool");
			const result = await readTool.execute("read-after-move", { path: "moved.txt" });

			expect(textContent(result)).toContain("moved cwd");
		} finally {
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
	it.each(["hindsight", "mnemopi"] as const)("keeps %s disabled in restricted sessions after /move", async backend => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-restricted-memory-move-"));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		const agentDir = path.join(tempDir, "agent");
		await Promise.all(
			[cwdA, cwdB].map(cwd =>
				Bun.write(
					path.join(getProjectAgentDir(cwd), "config.yml"),
					Bun.YAML.stringify({
						memory: { backend },
						hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
						mnemopi: { noEmbeddings: true, llmMode: "none" },
					}),
				),
			),
		);
		const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
		const sessionManager = SessionManager.create(cwdA, SessionManager.getDefaultSessionDir(cwdA, agentDir));
		const authStorage = createInMemoryAuthStorage();
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir,
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			restrictToolNames: true,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
		});
		const originalProjectDir = getProjectDir();
		try {
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			const output: string[] = [];
			await executeAcpBuiltinSlashCommand("/move " + cwdB, {
				session,
				sessionManager,
				settings,
				cwd: cwdA,
				output: text => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			});
			expect(output.join("\n")).toContain("Moved to ");
			expect(sessionManager.getCwd()).toBe(cwdB);
			expect(sessionManager.getSessionDir().startsWith(`${agentDir}${path.sep}`)).toBe(true);
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			// Explicit backend reapplication must preserve the same startup policy.
			await session.applyMemoryBackend();
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			setProjectDir(originalProjectDir);
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
});
