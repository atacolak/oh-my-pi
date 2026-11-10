import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const cleanups: (() => Promise<void>)[] = [];
let runs = 0;

async function runConfiguredScout(state: "stale" | "pending" | "warm" | "missing") {
	const id = `ConfiguredScout${++runs}`;
	const sourceId = `configured-scout-${runs}`;
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-configured-scout-"));
	const authStorage = await AuthStorage.create(":memory:");
	cleanups.push(async () => {
		await AgentRegistry.global().get(id)?.session?.dispose();
		AgentRegistry.global().unregister(id);
		unregisterCustomApis(sourceId);
		authStorage.close();
		await fs.rm(cwd, { recursive: true, force: true });
	});
	const model = createMockModel({
		id: `configured-scout-target-${runs}`,
		handler: () => ({ content: ["task completed"] }),
	});
	registerMockApi(sourceId);
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), {
		ignoreLocalModelConfig: true,
	});
	let warm = state === "warm";
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => (warm ? [model] : []));
	vi.spyOn(modelRegistry, "getAll").mockImplementation(() => (warm ? [model] : []));
	const find = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, modelId) =>
		warm && provider === "mock" && modelId === model.id ? model : find(provider, modelId),
	);
	vi.spyOn(modelRegistry, "refreshInBackground").mockImplementation(() => {
		if (state === "stale") warm = true;
	});
	vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockImplementation(async () => {
		if (state === "pending") warm = true;
	});
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [
			{
				name: "scout",
				description: "test",
				systemPrompt: "test",
				source: "bundled",
				model: ["@smol"],
				tools: ["read"],
			},
		],
		projectAgentsDir: null,
	});
	const create = vi.spyOn(sdk, "createAgentSession");
	const settings = Settings.isolated({
		"task.perCallModel": "off",
		"task.maxRecursionDepth": 2,
		"task.isolation.enabled": false,
		"task.agentPrewalk": { scout: "off" },
		"task.agentAdvisor": { scout: "off" },
		"compaction.enabled": false,
		"retry.enabled": false,
		modelRoles: { smol: `mock/${model.id}` },
	});
	const session = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
	} as unknown as ToolSession;
	const execution = await runStructuredSubagent({
		session,
		invocationKind: "task",
		assignment: "Complete the read-only task.",
		agent: "scout",
		structured: false,
		identity: { id },
		keepAlive: false,
	});
	return { result: execution.result, create, model };
}

describe("configured scout model readiness", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	it.each([
		{ state: "stale" as const, contract: "refreshes a missing configured model with per-call selection off" },
		{ state: "pending" as const, contract: "awaits pending discovery before dispatching the configured scout" },
		{ state: "warm" as const, contract: "keeps an already available configured model dispatchable" },
	])("$contract", async ({ state }) => {
		const { result, model } = await runConfiguredScout(state);
		expect(result.exitCode, `${result.error ?? ""}${result.stderr}${result.output}`).toBe(0);
		expect(result.output).toBe("task completed");
		expect(
			model.calls.some(call =>
				call.context.messages.some(
					message =>
						message.role === "user" && JSON.stringify(message.content).includes("Complete the read-only task."),
				),
			),
		).toBe(true);
	});

	it("reports an unavailable configured selector before creating a model-less child", async () => {
		const { result, create, model } = await runConfiguredScout("missing");
		expect(result.exitCode).not.toBe(0);
		const failure = `${result.error ?? ""}${result.stderr}${result.output}`;
		expect(failure).toContain("configured-scout-target");
		expect(failure).not.toContain("No model selected");
		expect(create).not.toHaveBeenCalled();
		expect(model.calls).toHaveLength(0);
	});
});
