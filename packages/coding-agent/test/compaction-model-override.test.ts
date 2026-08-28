import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
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
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("session.compacting model override", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let workingModel: Model;
	let authorModel: Model;
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-compaction-override-shared-");
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

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-override-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
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
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		try {
			await tempDir.remove();
		} catch {}
	});

	async function createSessionWithFactory(
		factory: Parameters<typeof loadExtensionFromFactory>[0],
		options?: { obfuscator?: SecretObfuscator },
	): Promise<void> {
		const extensionsResult = await loadExtensions([], tempDir.path());
		const extension = await loadExtensionFromFactory(
			factory,
			tempDir.path(),
			new EventBus(),
			extensionsResult.runtime,
			"compaction-model-override",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
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
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.methodOrder": ["soft"],
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
			extensionRunner,
			obfuscator: options?.obfuscator,
		});
	}

	it("uses the compacting override model without mutating the session model", async () => {
		await createSessionWithFactory(pi => {
			pi.on("session.compacting", () => ({
				prompt: "reconstruct current working state",
				model: `${authorModel.provider}/${authorModel.id}`,
			}));
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "hot handoff",
			shortSummary: "hot",
			firstKeptEntryId: sessionManager.getBranch().at(-1)!.id,
			tokensBefore: 100,
			details: {},
		});

		expect(session.model?.id).toBe(workingModel.id);
		await session.compact();
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]![1].id).toBe(authorModel.id);
		expect(compactSpy.mock.calls[0]![1].provider).toBe(authorModel.provider);
		expect(session.model?.id).toBe(workingModel.id);
		expect(session.model?.provider).toBe(workingModel.provider);
	});

	it("obfuscates the compacting prompt override before the author request", async () => {
		const secret = "HANDOFF_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		await createSessionWithFactory(
			pi => {
				pi.on("session.compacting", () => ({
					prompt: `keep ${secret} out of the author request`,
					model: `${authorModel.provider}/${authorModel.id}`,
				}));
			},
			{ obfuscator },
		);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "hot handoff",
			shortSummary: "hot",
			firstKeptEntryId: sessionManager.getBranch().at(-1)!.id,
			tokensBefore: 100,
			details: {},
		});
		await session.compact();
		const options = compactSpy.mock.calls[0]![5];
		expect(options?.promptOverride).toContain(placeholder);
		expect(options?.promptOverride).not.toContain(secret);
		expect(compactSpy.mock.calls[0]![1].id).toBe(authorModel.id);
	});

	it("fails rather than silently using the working model when the override cannot be resolved", async () => {
		await createSessionWithFactory(pi => {
			pi.on("session.compacting", () => ({
				prompt: "reconstruct current working state",
				model: "missing-provider/missing-model",
			}));
		});
		const compactSpy = vi.spyOn(compactionModule, "compact");
		await expect(session.compact()).rejects.toThrow(/could not be resolved/);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(session.model?.id).toBe(workingModel.id);
	});
});
