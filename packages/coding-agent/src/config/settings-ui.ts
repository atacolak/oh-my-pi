import * as path from "node:path";
import { TERMINAL, replaceTabs } from "@oh-my-pi/pi-tui";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import {
	SETTING_TABS,
	type SettingsDisplayEntry,
	type SettingsHost,
	type SettingsUiScope,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, Settings, settings } from "./settings";
import { orderedSettings } from "./all-settings";
import { type AnySetting, lookup } from "./registry";

import { cfgPlanAutosave, cfgPlanEnabled } from "../plan-mode/settings";
import {
	cfgRetryUsageAwareFallback,
	cfgDefaultThinkingLevel,
	normalizeProviderMaxInFlightRequests,
	validateProviderMaxInFlightRequests,
} from "../session/settings";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgTuiVimMode } from "../modes/settings";
import { cfgAdvisorEnabled } from "../advisor/settings";
import { cfgContextFilesExtra } from "../session/context-settings";
import { cfgToolsRestrictedFolders } from "../tools/settings";

/** Condition over the global settings; hidden (false) until they are initialized. */
function whenSettings(test: (settings: Settings) => boolean): () => boolean {
	return () => isSettingsInitialized() && test(Settings.instance);
}

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	nativeRendering: () => isNativeRendering(),
	advisorEnabled: whenSettings(s => cfgAdvisorEnabled.get(s) === true),
	vimModeEnabled: whenSettings(s => cfgTuiVimMode.get(s) === true),
	hindsightActive: whenSettings(s => cfgMemoryBackend.get(s) === "hindsight"),
	mnemopiActive: whenSettings(s => cfgMemoryBackend.get(s) === "mnemopi"),
	autolearnActive: whenSettings(s => cfgAutolearnEnabled.get(s) === true),
	autoThinkingActive: whenSettings(s => cfgDefaultThinkingLevel.get(s) === "auto"),
	usageAwareFallbackEnabled: whenSettings(s => cfgRetryUsageAwareFallback.get(s) === true),
	planModeEnabled: whenSettings(s => cfgPlanEnabled.get(s)),
	planAutosaveEnabled: whenSettings(s => cfgPlanEnabled.get(s) && cfgPlanAutosave.get(s)),
	contextFilesExtraNotProject: whenSettings(s => cfgContextFilesExtra.provenance(s) !== "project"),
	restrictedFoldersNotProject: whenSettings(s => cfgToolsRestrictedFolders.provenance(s) !== "project"),
};

function envNote(setting: AnySetting): string {
	if (!setting.envName || setting.envValue() === undefined) return "";
	return setting.envFallback
		? ` Unset, it falls back to $${setting.envName}.`
		: ` $${setting.envName} overrides this setting while it is set.`;
}

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

/**
 * Adapt the application schema and settings store to the terminal overlay. The panel shows and
 * edits the value of the settings layers, never an environment-supplied one (so an env credential
 * is never pre-filled or written to config); descriptions note an active environment variable.
 */
export function createSettingsHost(cwd: string = process.cwd()): SettingsHost {
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const setting of orderedSettings()) {
			const ui = setting.ui;
			if (ui?.tab !== tab) continue;
			const note = envNote(setting);
			entries.push({
				path: setting.id,
				type: setting.type,
				defaultValue: setting.default,
				ui: note ? { ...ui, description: `${ui.description}${note}` } : ui,
				enumValues: setting.enumValues,
				credential: setting.isCredential,
				condition: ui.condition ? CONDITIONS[ui.condition] : undefined,
			});
		}
	}
	const resolve = (path: string): AnySetting => {
		const setting = lookup(path);
		if (!setting) throw new Error(`Unknown setting: ${path}`);
		return setting;
	};
	return {
		entries,
		get: path => lookup(path)?.layered(settings),
		getGlobal: path => Settings.instance.globalLayerValue(resolve(path)),
		getProjectScoped: path => Settings.instance.projectScopedValue(resolve(path)),
		getProjectInherited: path => Settings.instance.projectInheritedValue(resolve(path)),
		set: (path, value, scope: SettingsUiScope = "global") => {
			const setting = resolve(path);
			if (scope === "project") setting.setProject(settings, value as never);
			else setting.set(settings, value as never);
		},
		unset: path => resolve(path).unset(settings),
		clearProject: path => resolve(path).unsetProject(settings),
		hasProjectConfig: () => Settings.instance.hasProjectConfig(),
		isCredential: path => resolve(path).isCredential,
		projectLabel: () => settingsProjectLabel(cwd),
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}
