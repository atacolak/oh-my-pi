import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	RpcCommandSurface,
	RpcPendingExtensionRequests,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-surface";
import { RpcClientConnection, RpcClientRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/client-connection";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";

function model(id: string): Model {
	const found = getBundledModel("anthropic", id);
	if (!found) throw new Error(`Missing fixture model ${id}`);
	return found;
}

function responseData(response: RpcResponse): Record<string, unknown> {
	if (!response.success || !("data" in response)) throw new Error(JSON.stringify(response));
	return response.data as Record<string, unknown>;
}

describe("native model-role RPC", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;
	let surface: RpcCommandSurface | undefined;
	const sonnet = model("claude-sonnet-4-5");
	const opus = model("claude-opus-4-6");
	const builder = `missing-provider/unavailable, ${sonnet.provider}/${sonnet.id}:medium`;

	beforeAll(async () => {
		dir = await TempDir.create("@rpc-model-roles-");
		auth = await AuthStorage.create(dir.join("auth.db"));
		auth.keys.setRuntime("anthropic", "fixture-no-network");
		registry = new ModelRegistry(auth, dir.join("models.yml"));
	});

	afterEach(async () => {
		surface?.dispose();
		surface = undefined;
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		auth.close();
		await dir.remove();
	});

	async function start(
		roles: Record<string, string> = { builder, plain: `${sonnet.provider}/${sonnet.id}` },
		persist = true,
	) {
		vi.spyOn(registry, "refreshSelectedModelMetadata").mockImplementation(async selected => selected);
		const settings = Settings.isolated({ modelRoles: roles });
		const manager = persist
			? SessionManager.create(dir.path(), dir.join(crypto.randomUUID()))
			: SessionManager.inMemory(dir.path());
		await manager.ensureOnDisk();
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: opus, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.High },
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
		});
		const clients = new RpcClientRegistry();
		const defaultConn = new RpcClientConnection({ id: "role-test", send: () => {} });
		surface = new RpcCommandSurface({
			session,
			clients,
			defaultConn,
			output: () => {},
			maxResponseBytes: () => 16 * 1024 * 1024,
			pendingExtensionRequests: new RpcPendingExtensionRequests(),
			promptResults: new RpcPromptResults(session, () => {}),
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});
		const owner = session;
		const commands = surface;
		return {
			session: owner,
			settings,
			manager,
			async send(command: object) {
				return commands.handleCommand(command as RpcCommand);
			},
		};
	}

	test("catalog resolves native ordered fallbacks and observes without writing the journal or settings", async () => {
		const h = await start();
		const before = h.manager.getEntries();
		const rolesBefore = h.settings.getModelRoles();
		const result = await h.send({ type: "get_model_roles" });
		expect(result.success).toBe(true);
		const catalog = responseData(result);
		const rows = catalog.roles as Array<Record<string, unknown>>;
		expect(rows.find(row => row.id === "builder")).toMatchObject({
			selector: "@builder",
			configuredValue: builder,
			chain: ["missing-provider/unavailable", `${sonnet.provider}/${sonnet.id}:medium`],
			model: { provider: sonnet.provider, id: sonnet.id },
			matchedPatternIndex: 1,
			thinkingLevel: "medium",
			explicitThinkingLevel: true,
		});
		expect(catalog.current).toEqual({ provider: opus.provider, id: opus.id });
		expect(catalog.currentRole).toBeNull();
		expect(catalog.capabilities).toEqual({ roleSelection: true, sessionOnlyModel: true, preserveThinking: true });
		expect(h.manager.getEntries()).toEqual(before);
		expect(h.settings.getModelRoles()).toEqual(rolesBefore);
	});

	test("role selection records the named role and explicit effort without changing its shared chain", async () => {
		const h = await start();
		const before = h.settings.getModelRoles();
		const identity = responseData(await h.send({ type: "get_model_roles" }));
		const result = await h.send({
			type: "set_model_role",
			role: "builder",
			expectedSessionId: identity.sessionId,
			expectedSessionFile: identity.sessionFile,
			expectedBootId: identity.bootId,
		});
		expect(result.success).toBe(true);
		expect(responseData(result)).toMatchObject({
			currentRole: "builder",
			lastSelectedRole: "builder",
			current: { provider: sonnet.provider, id: sonnet.id },
			thinkingLevel: "medium",
		});
		expect(h.manager.getLastModelChangeRole()).toBe("builder");
		expect(h.settings.getModelRoles()).toEqual(before);
		expect(h.session.messages).toEqual([]);
	});

	test("role without explicit effort preserves current thinking and direct pick clears role identity", async () => {
		const h = await start();
		h.session.setThinkingLevel(ThinkingLevel.Medium);
		expect((await h.send({ type: "set_model_role", role: "plain" })).success).toBe(true);
		expect(h.session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(h.manager.getLastModelChangeRole()).toBe("plain");
		const direct = await h.send({
			type: "set_model",
			provider: opus.provider,
			modelId: opus.id,
			sessionOnly: true,
			preserveThinking: true,
		});
		expect(direct.success).toBe(true);
		expect(h.session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(h.manager.getLastModelChangeRole()).toBe("temporary");
		expect(responseData(await h.send({ type: "get_model_roles" }))).toMatchObject({
			currentRole: null,
			lastSelectedRole: null,
			current: { provider: opus.provider, id: opus.id },
		});
	});

	test("unavailable, unknown and cyclic roles reject without changing current model", async () => {
		const h = await start({ broken: "missing-provider/unavailable", cycle_a: "@cycle_b", cycle_b: "@cycle_a" });
		for (const [role, code] of [
			["unconfigured", "unknown_model_role"],
			["broken", "model_role_unavailable"],
			["cycle_a", "model_role_unavailable"],
		]) {
			const result = await h.send({ type: "set_model_role", role });
			expect(result).toMatchObject({ success: false, code });
			expect(h.session.model).toEqual(opus);
			expect(h.manager.getLastModelChangeRole()).toBeUndefined();
		}
	});

	test("wrong session, transcript, boot and busy owner are refused before model mutation", async () => {
		const h = await start();
		const identity = responseData(await h.send({ type: "get_model_roles" }));
		const expected = {
			expectedSessionId: identity.sessionId,
			expectedSessionFile: identity.sessionFile,
			expectedBootId: identity.bootId,
		};
		for (const changed of [
			{ expectedSessionId: "wrong" },
			{ expectedSessionFile: path.join(dir.path(), "wrong.jsonl") },
			{ expectedBootId: "old-boot" },
		]) {
			const result = await h.send({ type: "set_model_role", role: "builder", ...expected, ...changed });
			expect(result).toMatchObject({ success: false, code: "session_target_mismatch" });
		}
		vi.spyOn(h.session, "hasPendingAsyncWork").mockReturnValue(true);
		expect(await h.send({ type: "set_model_role", role: "builder", ...expected })).toMatchObject({
			success: false,
			code: "session_busy",
		});
		expect(h.session.model).toEqual(opus);
		expect(h.manager.getLastModelChangeRole()).toBeUndefined();
	});

	test("a configured role edit leaves selected intent visible beside its newly resolved primary", async () => {
		const h = await start();
		expect((await h.send({ type: "set_model_role", role: "builder" })).success).toBe(true);
		h.settings.overrideModelRoles({ builder: `${opus.provider}/${opus.id}` });
		expect(responseData(await h.send({ type: "get_model_roles" }))).toMatchObject({
			currentRole: "builder",
			lastSelectedRole: "builder",
			roleMatchesCurrentModel: false,
			current: { provider: sonnet.provider, id: sonnet.id },
			resolvedPrimary: { provider: opus.provider, id: opus.id },
		});
		expect(responseData(await h.send({ type: "get_state" }))).toMatchObject({
			currentRole: "builder",
			lastSelectedRole: "builder",
		});
	});

	test("a session switch during metadata discovery prevents a late model write into the new journal", async () => {
		const h = await start();
		const held = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		vi.spyOn(registry, "refreshSelectedModelMetadata").mockImplementationOnce(async selected => {
			entered.resolve();
			await held.promise;
			return selected;
		});
		const changing = h.send({ type: "set_model_role", role: "builder" });
		await entered.promise;
		await h.manager.newSession();
		held.resolve();
		expect(await changing).toMatchObject({ success: false, code: "session_target_mismatch" });
		expect(h.session.model).toEqual(opus);
		expect(h.manager.getLastModelChangeRole()).toBeUndefined();
	});

	test("a direct session-only pick preserves automatic thinking as an automatic selector", async () => {
		const h = await start();
		h.session.setThinkingLevel(AUTO_THINKING);
		expect(h.session.isAutoThinking).toBe(true);
		expect(
			(
				await h.send({
					type: "set_model",
					provider: sonnet.provider,
					modelId: sonnet.id,
					sessionOnly: true,
					preserveThinking: true,
				})
			).success,
		).toBe(true);
		expect(h.session.isAutoThinking).toBe(true);
	});

	test("configured dotted role names round-trip through discovery and selection", async () => {
		const h = await start({ "builder.v2": builder });
		const result = await h.send({ type: "set_model_role", role: "builder.v2" });
		expect(result.success).toBe(true);
		expect(responseData(result).currentRole).toBe("builder.v2");
	});

	for (const selection of ["role", "direct"]) {
		test(`a session switch during model reconciliation cannot append the ${selection} choice to the new journal`, async () => {
			const h = await start(undefined, false);
			let changed: Promise<string | undefined> | undefined;
			const unsubscribe = h.session.subscribe(event => {
				if (event.type === "model_changed") changed = h.manager.newSession();
			});
			try {
				const response = await h.send(
					selection === "role"
						? { type: "set_model_role", role: "builder" }
						: {
								type: "set_model",
								provider: sonnet.provider,
								modelId: sonnet.id,
								sessionOnly: true,
								preserveThinking: true,
							},
				);
				await changed;
				expect(response).toMatchObject({ success: false, code: "session_target_mismatch" });
				expect(h.manager.getLastModelChangeRole()).toBeUndefined();
			} finally {
				unsubscribe();
			}
		});
	}

	test("an ephemeral runtime fallback retains selected role separately from effective model", async () => {
		const h = await start();
		expect((await h.send({ type: "set_model_role", role: "builder" })).success).toBe(true);
		await h.session.setModelTemporary(opus, ThinkingLevel.Medium, { ephemeral: true });
		const observed = responseData(await h.send({ type: "get_model_roles" }));
		expect(observed).toMatchObject({
			lastSelectedRole: "builder",
			currentRole: "builder",
			roleMatchesCurrentModel: false,
			current: { provider: opus.provider, id: opus.id },
		});
	});
});
