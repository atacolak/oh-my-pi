import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { cfgAskEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

beforeAll(async () => {
	await initTheme();
});

describe("project-scoped /settings persist layer", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let projectDir: string;
	let agentDir: string;
	let projectConfigPath: string;
	let changes: Array<{ path: string; value: unknown }>;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-scope-test-");
		projectDir = tempDir.join("project");
		agentDir = tempDir.join("agent");
		projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		fs.mkdirSync(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ ask: { enabled: false } }, null, 2));
		await Bun.write(projectConfigPath, YAML.stringify({ ask: { enabled: true }, custom: { keep: true } }, null, 2));
		await Settings.init({ cwd: projectDir, agentDir });
		changes = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	function createSelector(): SettingsSelectorComponent {
		return new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				settings: createSettingsHost(projectDir),
				plugins: createPluginSettingsHost(projectDir),
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onCancel: () => {},
			},
		);
	}

	it("writes a project layer value to native .omp/config.yml without copying inherited keys", async () => {
		expect(cfgAskEnabled.get(settings)).toBe(true);
		cfgAskEnabled.setProject(settings, false);
		expect(cfgAskEnabled.get(settings)).toBe(false);
		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: false },
			custom: { keep: true },
		});
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: false } });
	});

	it("writes the global layer without live callbacks when the project value still wins", async () => {
		cfgAskEnabled.set(settings, true);
		const selector = createSelector();
		expect(selector.render(120).join("\n")).toContain(`Settings · ${path.basename(projectDir)}`);
		expect(settings.globalLayerValue(cfgAskEnabled)).toBe(true);
		expect(cfgAskEnabled.get(settings)).toBe(true);

		selector.handleInput("\x1bs");
		expect(selector.render(120).join("\n")).toContain("Settings · global");
		selector.handleInput("Enable the ask tool");
		selector.handleInput("\n");
		expect(settings.globalLayerValue(cfgAskEnabled)).toBe(false);
		expect(cfgAskEnabled.get(settings)).toBe(true);
		expect(changes).toEqual([]);

		await settings.flush();
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: false } });
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
		});
	});

	it("inherits the global fallback when removing a project override", async () => {
		const selector = createSelector();
		selector.handleInput("Enable the ask tool");
		selector.handleInput("\x1b");
		selector.handleInput("\x1b[3~");

		expect(cfgAskEnabled.get(settings)).toBe(false);
		expect(changes.at(-1)).toEqual({ path: "ask.enabled", value: false });

		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({ custom: { keep: true } });
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: false } });
	});

	it("computes the project label once instead of rediscovering the repo on each render", () => {
		const repoSpy = vi.spyOn(vcs, "repo");
		const selector = createSelector();
		const discoveries = repoSpy.mock.calls.length;
		expect(discoveries).toBeGreaterThan(0);
		selector.render(120);
		selector.render(80);
		expect(repoSpy.mock.calls.length).toBe(discoveries);
		expect(selector.render(120).join("\n")).toContain(`Settings · ${path.basename(projectDir)}`);
	});
});
