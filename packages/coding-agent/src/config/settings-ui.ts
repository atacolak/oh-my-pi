import * as path from "node:path";
import { TERMINAL, replaceTabs } from "@oh-my-pi/pi-tui";
import {
	SETTING_TABS,
	type SettingsDisplayEntry,
	type SettingsHost,
	type SettingsScope,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	isSettingsInitialized,
	normalizeProviderMaxInFlightRequests,
	onProjectSettingsReconciled,
	Settings,
	settings,
	type SettingValue,
	validateProviderMaxInFlightRequests,
} from "./settings";
import {
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	isCredential,
	type SettingPath,
} from "./settings-schema";

function readSetting<P extends SettingPath>(path: P, scope?: SettingsScope): SettingValue<P> | undefined {
	try {
		const sm = Settings.instance;
		if (scope === "global") return sm.getGlobalValue(path);
		if (scope === "project") return sm.getProjectScopedValue(path);
		return sm.get(path);
	} catch {
		return undefined;
	}
}

const CONDITIONS: Record<string, (scope?: SettingsScope) => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: scope => readSetting("advisor.enabled", scope) === true,
	vimModeEnabled: scope => readSetting("tui.vimMode", scope) === true,
	hindsightActive: scope => readSetting("memory.backend", scope) === "hindsight",
	mnemopiActive: scope => readSetting("memory.backend", scope) === "mnemopi",
	autolearnActive: scope => readSetting("autolearn.enabled", scope) === true,
	autoThinkingActive: scope => readSetting("defaultThinkingLevel", scope) === "auto",
	usageAwareFallbackEnabled: scope => readSetting("retry.usageAwareFallback", scope) === true,
	planModeEnabled: scope => readSetting("plan.enabled", scope) === true,
	planAutosaveEnabled: scope => Boolean(readSetting("plan.enabled", scope) && readSetting("plan.autosave", scope)),
	unexpectedStopSmart: scope => readSetting("features.unexpectedStopDetection", scope) === "smart",
};

function settingsProjectLabel(cwd: string): string {
	let primary: string | null = null;
	try {
		primary = vcs.repo(cwd)?.primaryRoot() ?? null;
	} catch {
		primary = null;
	}
	const base = path.basename(primary ?? cwd);
	const name = base.endsWith(".git") ? base.slice(0, -4) : base;
	const cleaned = replaceTabs(sanitizeText(name))
		.replace(/[\r\n]+/g, " ")
		.trim();
	return cleaned || "project";
}

/** Adapt the application schema and settings store to the terminal overlay. */
export function createSettingsHost(cwd: string = process.cwd()): SettingsHost {
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const settingPath of getPathsForTab(tab)) {
			const ui = getUi(settingPath);
			entries.push({
				path: settingPath,
				type: getType(settingPath),
				defaultValue: getDefault(settingPath),
				ui,
				enumValues: getEnumValues(settingPath),
				credential: isCredential(settingPath),
				condition: ui?.condition ? CONDITIONS[ui.condition] : undefined,
			});
		}
	}
	return {
		entries,
		get: settingPath => settings.get(settingPath as SettingPath),
		getGlobal: settingPath => Settings.instance.getGlobalValue(settingPath as SettingPath),
		getProjectScoped: settingPath => Settings.instance.getProjectScopedValue(settingPath as SettingPath),
		getProjectInherited: settingPath => Settings.instance.getProjectInheritedValue(settingPath as SettingPath),
		set: (settingPath, value, scope = "global") => settings.set(settingPath as SettingPath, value as never, scope),
		clearProject: settingPath => Settings.instance.clearProject(settingPath as SettingPath),
		hasProjectConfig: () => Settings.instance.hasProjectConfig(),
		isCredential: settingPath => isCredential(settingPath as SettingPath),
		projectLabel: () => settingsProjectLabel(cwd),
		onProjectSettingsReconciled: cb =>
			onProjectSettingsReconciled((paths, source) => {
				if (!isSettingsInitialized() || source !== Settings.instance) return;
				cb(paths);
			}),
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}
