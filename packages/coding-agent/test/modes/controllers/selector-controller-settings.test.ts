import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as theme from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

beforeAll(async () => {
	await theme.initTheme();
});

describe("SelectorController prompt-affecting settings", () => {
	it("refreshes the active prompt when xdev docs mode changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("tools.xdevDocs", "catalog");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	describe("queue-mode toggles from the settings panel", () => {
		let tempDir: TempDir;
		let authStorage: AuthStorage;
		let settings: Settings;
		let session: AgentSession;
		let controller: SelectorController;
		let configPath: string;

		beforeEach(async () => {
			tempDir = TempDir.createSync("@pi-selector-queue-");
			const agentDir = tempDir.path();
			configPath = path.join(agentDir, "config.yml");

			authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
			settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: SessionManager.create(agentDir, agentDir),
				settings,
				modelRegistry,
				obfuscator: new SecretObfuscator([]),
			});
			controller = new SelectorController({ session } as unknown as InteractiveModeContext);
		});

		afterEach(async () => {
			authStorage.close();
			try {
				await tempDir.remove();
			} catch {}
		});

		it("applies panel queue-mode toggles live without a second global persist", async () => {
			controller.handleSettingChange("steeringMode", "all");
			controller.handleSettingChange("followUpMode", "all");
			controller.handleSettingChange("interruptMode", "wait");
			await settings.flush();

			expect(session.steeringMode).toBe("all");
			expect(session.followUpMode).toBe("all");
			expect(session.interruptMode).toBe("wait");
			expect(settings.getGlobalSettings()).not.toMatchObject({
				steeringMode: "all",
				followUpMode: "all",
				interruptMode: "wait",
			});
			expect(await Bun.file(configPath).exists()).toBe(false);
		});
	});

	it("persists the Auto-Compact toggle globally from the settings panel", () => {
		const setAutoCompactionEnabled = vi.fn();
		const ctx = {
			session: { setAutoCompactionEnabled },
			statusLine: { setAutoCompactEnabled: vi.fn() },
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("autoCompact", false);

		// persist=true: panel edits are durable, unlike the session-scoped RPC path (#11431).
		expect(setAutoCompactionEnabled).toHaveBeenCalledWith(false, true);
	});

	describe("live panel side effects that read the settings singleton", () => {
		let settingsState: SettingsTestState | undefined;

		beforeEach(async () => {
			settingsState = beginSettingsTest();
			await Settings.init({ inMemory: true });
		});

		afterEach(() => {
			restoreSettingsTestState(settingsState);
			settingsState = undefined;
		});

		it("refreshes the status line when cached status-line settings change", () => {
			const updateSettings = vi.fn();
			const requestRender = vi.fn();
			const controller = new SelectorController({
				statusLine: { updateSettings },
				ui: { requestRender },
			} as unknown as InteractiveModeContext);

			Settings.instance.override("statusLine.preset", "full");
			Settings.instance.override("statusLine.leftSegments", ["model"]);
			Settings.instance.override("statusLine.contextLine", "annotated");
			controller.handleSettingChange("statusLine.preset", "full");
			controller.handleSettingChange("statusLine.leftSegments", ["model"]);
			controller.handleSettingChange("statusLine.contextLine", "annotated");

			expect(updateSettings).toHaveBeenCalledTimes(3);
			expect(updateSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					preset: "full",
					leftSegments: ["model"],
					contextLine: "annotated",
				}),
			);
			expect(requestRender).toHaveBeenCalledTimes(3);
		});

		it("applies a thinking-level change without re-persisting it globally", () => {
			const setThinkingLevel = vi.fn();
			const invalidate = vi.fn();
			const updateEditorBorderColor = vi.fn();
			Settings.instance.set("defaultThinkingLevel", Effort.Medium);
			const controller = new SelectorController({
				session: { setThinkingLevel },
				statusLine: { invalidate },
				updateEditorBorderColor,
			} as unknown as InteractiveModeContext);

			controller.handleSettingChange("defaultThinkingLevel", Effort.High);

			expect(setThinkingLevel).toHaveBeenCalledTimes(1);
			expect(setThinkingLevel).toHaveBeenCalledWith(Effort.High);
			expect(setThinkingLevel.mock.calls[0]).toHaveLength(1);
			expect(Settings.instance.get("defaultThinkingLevel")).toBe(Effort.Medium);
		});
	});

	it("applies composer, spelling, scrollback, mermaid, and mcp changes live", () => {
		const syncComposerShape = vi.fn();
		const syncEditorSpelling = vi.fn();
		const requestRender = vi.fn();
		const setResizeScrollback = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const resetDisplay = vi.fn();
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const showError = vi.fn();
		const setNotificationsEnabled = vi.fn();
		const controller = new SelectorController({
			syncComposerShape,
			syncEditorSpelling,
			rebuildChatFromMessages,
			showError,
			session: { refreshBaseSystemPrompt },
			mcpManager: { setNotificationsEnabled },
			ui: { requestRender, setResizeScrollback, resetDisplay },
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("composer.shape", "box");
		controller.handleSettingChange("spelling.typoDetection", false);
		controller.handleSettingChange("tui.resizeScrollback", "preserve");
		controller.handleSettingChange("tui.renderMermaid", false);
		controller.handleSettingChange("mcp.notifications", true);

		expect(syncComposerShape).toHaveBeenCalledTimes(1);
		expect(syncEditorSpelling).toHaveBeenCalledTimes(1);
		expect(setResizeScrollback).toHaveBeenCalledWith("preserve");
		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(rebuildChatFromMessages.mock.invocationCallOrder[0]).toBeLessThan(
			resetDisplay.mock.invocationCallOrder[0],
		);
		expect(setNotificationsEnabled).toHaveBeenCalledWith(true);
	});
});

describe("SelectorController settings overlay close", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	it("keeps custom segment options when closing /settings", async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-close-segment-options-");
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		const customOptions = { path: { abbreviate: false, maxLength: 12 } };
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ ask: { enabled: false } }, null, 2));
		await Bun.write(
			path.join(projectDir, ".omp", "config.yml"),
			YAML.stringify({ statusLine: { segmentOptions: customOptions } }, null, 2),
		);
		await Settings.init({ cwd: projectDir, agentDir });
		vi.spyOn(theme, "getAvailableThemes").mockResolvedValue(["dark-one", "titanium"]);

		const editor = { id: "editor", getTopBorderAvailableWidth: () => 80 };
		const overlay = { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
		const updateSettings = vi.fn();
		let selector: { handleInput: (data: string) => void } | undefined;
		const ctx = {
			editor,
			editorContainer: { children: [editor] },
			session: {
				getAvailableThinkingLevels: () => [],
				thinkingLevel: undefined,
				getAvailableModels: () => [],
				model: undefined,
			},
			statusLine: {
				updateSettings,
				invalidate: vi.fn(),
				getPreviewLines: () => [],
			},
			ui: {
				showOverlay: vi.fn(component => {
					selector = component as { handleInput: (data: string) => void };
					return overlay;
				}),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				invalidate: vi.fn(),
				imageBudget: undefined,
				terminal: { columns: 80 },
			},
		} as unknown as InteractiveModeContext;

		new SelectorController(ctx).showSettingsSelector();
		await Promise.resolve();
		expect(selector).toBeDefined();
		selector!.handleInput("\x1b");

		expect(updateSettings).toHaveBeenCalled();
		expect(updateSettings.mock.calls.at(-1)?.[0]).toMatchObject({
			segmentOptions: customOptions,
		});
		expect(overlay.hide).toHaveBeenCalledTimes(1);
	});

	it("previews scoped symbol and color-blind options then restores them on close", async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-close-presentation-");
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ symbolPreset: "ascii", colorBlindMode: false }, null, 2),
		);
		await Bun.write(
			path.join(projectDir, ".omp", "config.yml"),
			YAML.stringify({ symbolPreset: "nerd", colorBlindMode: true }, null, 2),
		);
		await Settings.init({ cwd: projectDir, agentDir });
		const previewed: Array<{ name: string; symbolPreset?: string; colorBlindMode?: boolean }> = [];
		vi.spyOn(theme, "getAvailableThemes").mockResolvedValue(["dark-one", "titanium"]);
		vi.spyOn(theme, "previewTheme").mockImplementation(
			async (name: string, event?: { symbolPreset?: string; colorBlindMode?: boolean }) => {
				previewed.push({
					name,
					symbolPreset: event?.symbolPreset,
					colorBlindMode: event?.colorBlindMode,
				});
				return { success: true };
			},
		);

		const editor = { id: "editor", getTopBorderAvailableWidth: () => 80 };
		const overlay = { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
		let selector: { handleInput: (data: string) => void } | undefined;
		const ctx = {
			editor,
			editorContainer: { children: [editor] },
			session: {
				getAvailableThinkingLevels: () => [],
				thinkingLevel: undefined,
				getAvailableModels: () => [],
				model: undefined,
			},
			statusLine: {
				updateSettings: vi.fn(),
				invalidate: vi.fn(),
				getPreviewLines: () => [],
			},
			ui: {
				showOverlay: vi.fn(component => {
					selector = component as { handleInput: (data: string) => void };
					return overlay;
				}),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				invalidate: vi.fn(),
				imageBudget: undefined,
				terminal: { columns: 80 },
			},
		} as unknown as InteractiveModeContext;

		new SelectorController(ctx).showSettingsSelector();
		await Promise.resolve();
		expect(selector).toBeDefined();
		expect(previewed.at(-1)).toMatchObject({ symbolPreset: "nerd", colorBlindMode: true });

		selector!.handleInput("\x1bs");
		await Promise.resolve();
		expect(previewed.at(-1)).toMatchObject({ symbolPreset: "ascii", colorBlindMode: false });

		selector!.handleInput("\x1b");
		await Promise.resolve();
		expect(previewed.at(-1)).toMatchObject({ symbolPreset: "nerd", colorBlindMode: true });
		expect(overlay.hide).toHaveBeenCalledTimes(1);
	});
});
