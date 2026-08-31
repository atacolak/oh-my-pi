import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ExtensionRunner,
	loadExtensionFromFactory,
	loadExtensions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import hotHandoff from "../examples/extensions/hot-handoff/index";
import { projectHandoffPath } from "../examples/extensions/hot-handoff/prompt";
import { HOT_HANDOFF_CUSTOM_TYPE } from "../examples/extensions/hot-handoff/types";

describe("hot handoff lifecycle", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let workingModel: Model;
	let authorModel: Model;
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionManager: SessionManager;
	let extensionRunner: ExtensionRunner;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@hot-handoff-life-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const working = getBundledModel("anthropic", "claude-sonnet-4-5");
		const author = getBundledModel("openai", "gpt-5");
		if (!working || !author) throw new Error("Expected bundled models");
		workingModel = working;
		authorModel = author;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	async function seedSession(options?: { handoffMd?: string; modelRoles?: Record<string, string> }): Promise<void> {
		tempDir = TempDir.createSync("@hot-handoff-life-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		if (options?.handoffMd !== undefined) {
			await fs.mkdir(path.join(tempDir.path(), ".omp"), { recursive: true });
			await Bun.write(projectHandoffPath(tempDir.path()), options.handoffMd);
		}
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: workingModel.api,
			provider: workingModel.provider,
			model: workingModel.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": false,
			"compaction.asyncEnabled": false,
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 1,
		});
		if (options?.modelRoles) {
			for (const [role, value] of Object.entries(options.modelRoles)) {
				settings.setModelRole(role, value);
			}
		}
		const extensionsResult = await loadExtensions([], tempDir.path());
		const extension = await loadExtensionFromFactory(
			hotHandoff,
			tempDir.path(),
			new EventBus(),
			extensionsResult.runtime,
			"hot-handoff",
		);
		extensionRunner = new ExtensionRunner(
			[extension],
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			settings,
			undefined,
			() => session?.getAsyncJobSnapshot() ?? null,
			() => session?.getAgentSnapshot() ?? { agents: [] },
		);
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: workingModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
		});
		extensionRunner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => session?.model,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
		);
	}

	it("does not override compaction without .omp/HANDOFF.md", async () => {
		await seedSession();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "stock summary",
			shortSummary: "stock",
			firstKeptEntryId: sessionManager.getBranch().at(-1)!.id,
			tokensBefore: 100,
			details: {},
		});
		await session!.compact();
		expect(compactSpy.mock.calls[0]![5]?.promptOverride).toBeUndefined();
		expect(compactSpy.mock.calls[0]![1].id).toBe(workingModel.id);
	});

	it("uses the independent @handoff author and project contract when opted in", async () => {
		await seedSession({
			handoffMd: "## Objective\nfinish the parser",
			modelRoles: { handoff: `${authorModel.provider}/${authorModel.id}` },
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "## Objective\nfinish the parser",
			shortSummary: "hot",
			firstKeptEntryId: sessionManager.getBranch().at(-1)!.id,
			tokensBefore: 100,
			details: {},
		});
		const sessionId = session!.sessionId;
		await session!.compact();
		expect(compactSpy.mock.calls[0]![1].id).toBe(authorModel.id);
		expect(compactSpy.mock.calls[0]![5]?.promptOverride).toContain("independent handoff author");
		expect(compactSpy.mock.calls[0]![5]?.promptOverride).toContain("## Objective\nfinish the parser");
		expect(compactSpy.mock.calls[0]![5]?.extraContext?.some(block => block.includes("<LIVE_STATE"))).toBe(true);
		expect(session!.model?.id).toBe(workingModel.id);
		expect(session!.sessionId).toBe(sessionId);
		const compaction = sessionManager.getBranch().findLast(entry => entry.type === "compaction");
		expect(compaction?.summary).toContain("finish the parser");
		const hot = (
			compaction?.preserveData as
				| { hotHandoff?: { version?: number; completedAt?: string; startedAt?: string } }
				| undefined
		)?.hotHandoff;
		expect(hot?.version).toBe(1);
		expect(hot?.startedAt).toBeDefined();
		expect(hot?.completedAt).toBeUndefined();
	});

	it("injects Snapshot B into the next provider context without persisting it", async () => {
		await seedSession({
			handoffMd: "## Objective\ncontinue",
			modelRoles: { handoff: `${authorModel.provider}/${authorModel.id}` },
		});
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "## Objective\ncontinue",
			shortSummary: "hot",
			firstKeptEntryId: sessionManager.getBranch().at(-1)!.id,
			tokensBefore: 100,
			details: {},
			preserveData: {
				hotHandoff: {
					version: 1,
					authorSelector: "@handoff",
					resolvedAuthor: `${authorModel.provider}/${authorModel.id}`,
					promptPath: ".omp/HANDOFF.md",
					promptHash: "abc",
					startedAt: new Date().toISOString(),
				},
			},
		});
		await session!.compact();
		const before = [{ role: "user", content: "hello", timestamp: Date.now() }] as AgentMessage[];
		const after = await extensionRunner.emitContext(before);
		expect(after).toHaveLength(2);
		const injected = after[1] as { role: string; customType?: string; content?: string };
		expect(injected.role).toBe("custom");
		expect(injected.customType).toBe(HOT_HANDOFF_CUSTOM_TYPE);
		expect(String(injected.content)).toContain("<LIVE_STATE");
		expect(String(injected.content)).toContain("authoritative for volatile runtime state");
		const persisted = JSON.stringify(sessionManager.getBranch());
		expect(persisted).not.toContain(HOT_HANDOFF_CUSTOM_TYPE);
		const second = await extensionRunner.emitContext(before);
		expect(second).toHaveLength(1);
	});

	it("does not inject Snapshot B into a different session", async () => {
		await seedSession({
			handoffMd: "## Objective\ncontinue",
			modelRoles: { handoff: `${authorModel.provider}/${authorModel.id}` },
		});
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "## Objective\ncontinue",
			shortSummary: "hot",
			firstKeptEntryId: sessionManager.getBranch().at(-1)!.id,
			tokensBefore: 100,
			details: {},
			preserveData: {
				hotHandoff: {
					version: 1,
					authorSelector: "@handoff",
					resolvedAuthor: `${authorModel.provider}/${authorModel.id}`,
					promptPath: ".omp/HANDOFF.md",
					promptHash: "abc",
					startedAt: new Date().toISOString(),
				},
			},
		});
		await session!.compact();
		await extensionRunner.emit({
			type: "session_switch",
			reason: "new",
			previousSessionFile: undefined,
		});
		const before = [{ role: "user", content: "hello", timestamp: Date.now() }] as AgentMessage[];
		const after = await extensionRunner.emitContext(before);
		expect(after).toHaveLength(1);
	});

	it("falls back to stock compaction when @handoff is the working model", async () => {
		await seedSession({
			handoffMd: "## Objective\ncontinue",
			modelRoles: { handoff: `${workingModel.provider}/${workingModel.id}` },
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "stock",
			shortSummary: "stock",
			firstKeptEntryId: sessionManager.getBranch().at(-1)!.id,
			tokensBefore: 100,
			details: {},
		});
		await session!.compact();
		expect(compactSpy.mock.calls[0]![1].id).toBe(workingModel.id);
		expect(compactSpy.mock.calls[0]![5]?.promptOverride).toBeUndefined();
	});
});
