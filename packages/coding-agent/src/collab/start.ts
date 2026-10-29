import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getActiveProfile, isProfileSelectedFromArgv, isProfileSelectedFromOmpEnv } from "@oh-my-pi/pi-utils/dirs";
import * as env from "@oh-my-pi/pi-utils/env";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import type { Setting } from "../config/registry";
import type { Settings } from "../config/settings";
import { expandTilde } from "../tools/path-utils";
import { sanitizeStatusText, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { replaceFileAtomically } from "../utils/atomic-file";
import { DEFAULT_RELAY_URL } from "./protocol";
import type { CollabAccess } from "./registry";
import { cfgCollabAutoStart, cfgCollabRelayUrl, cfgCollabWebUrl, cfgCollabWriteLinkPath } from "./settings";

export type CollabAutoStart = "off" | CollabAccess;

const PROJECT_DOTENV_GLOBAL_DIR_KEYS = [
	"PI_CODING_AGENT_DIR",
	"OMP_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"OMP_CONFIG_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
] as const;

export interface TrustedAutoStartLaunch {
	access: CollabAccess;
	relayUrl: string;
	webUrl: string;
	writeLinkPath: string;
}

function collabLayerValue(layer: unknown, setting: Setting<unknown>): unknown {
	let current: unknown = layer;
	for (const segment of setting.segments) {
		if (current === null || current === undefined || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function isTrustedNamedProfile(): boolean {
	if (!getActiveProfile()) return false;
	if (isProfileSelectedFromArgv()) return true;
	if (isProfileSelectedFromOmpEnv()) return !env.isEnvOwnedByProjectDotenv("OMP_PROFILE");
	return !env.isEnvOwnedByProjectDotenv("PI_PROFILE");
}

function redirectedGlobalConfig(): boolean {
	const ignoreAgentDir = isTrustedNamedProfile();
	const skipFallbackPiProfile = isProfileSelectedFromOmpEnv();
	return PROJECT_DOTENV_GLOBAL_DIR_KEYS.some(name => {
		if (ignoreAgentDir && (name === "PI_CODING_AGENT_DIR" || name === "OMP_CODING_AGENT_DIR")) return false;
		if (skipFallbackPiProfile && name === "PI_PROFILE") return false;
		return env.isEnvOwnedByProjectDotenv(name);
	});
}

function isAutoStartOff(value: unknown): boolean {
	return value === "off" || value === false;
}

function asAutoStart(value: unknown): CollabAutoStart {
	if (value === "view" || value === "control") return value;
	if (value === true) return "control";
	return "off";
}

function trustedCollabSetting<T>(settings: Settings, setting: Setting<T>): T {
	const provenance = setting.provenance(settings);
	if (provenance === "runtime" || provenance === "default") return setting.get(settings);
	const effective = setting.get(settings);
	if (setting === cfgCollabAutoStart) {
		if (isAutoStartOff(effective)) return "off" as T;
		if (settings.getProjectSettingsLayers().some(layer => isAutoStartOff(collabLayerValue(layer, setting)))) {
			return "off" as T;
		}
		if (settings.getConfigOverlayLayers().some(layer => isAutoStartOff(collabLayerValue(layer, setting)))) {
			return "off" as T;
		}
	}
	if (redirectedGlobalConfig() && provenance !== "project") return setting.default;
	if (provenance === "overlay") {
		const projectValue = collabLayerValue(settings.getProjectSettings(), setting);
		if (projectValue !== undefined) return projectValue as T;
		const globalValue = collabLayerValue(settings.getGlobalSettings(), setting);
		return (globalValue !== undefined ? globalValue : setting.default) as T;
	}
	return effective;
}

function isTrustedCollabConfigured(settings: Settings, setting: Setting<unknown>): boolean {
	const provenance = setting.provenance(settings);
	if (provenance === "runtime") return true;
	if (redirectedGlobalConfig()) return provenance === "project";
	if (provenance === "overlay") {
		return (
			collabLayerValue(settings.getProjectSettings(), setting) !== undefined ||
			collabLayerValue(settings.getGlobalSettings(), setting) !== undefined
		);
	}
	return setting.isConfigured(settings);
}

export function resolveRelayUrl(input: string): string {
	const trimmed = input.trim();
	return trimmed.includes("://") ? trimmed : `wss://${trimmed}`;
}

export function resolveTrustedAutoStartMode(settings: Settings): CollabAutoStart {
	return asAutoStart(trustedCollabSetting(settings, cfgCollabAutoStart));
}

export function resolveTrustedAutoStartLaunch(
	settings: Settings,
	warn: (message: string) => void,
): TrustedAutoStartLaunch | undefined {
	const access = resolveTrustedAutoStartMode(settings);
	if (access === "off") {
		if (!isAutoStartOff(cfgCollabAutoStart.get(settings))) {
			warn("Collab auto-start skipped: configure collab.autoStart outside config overlays.");
		}
		return undefined;
	}
	const relayInput = trustedCollabSetting(settings, cfgCollabRelayUrl)?.trim() ?? "";
	if (!relayInput) {
		return { access, relayUrl: "", webUrl: "", writeLinkPath: "" };
	}
	const relayUrl = resolveRelayUrl(relayInput);
	if (relayUrl === DEFAULT_RELAY_URL && !isTrustedCollabConfigured(settings, cfgCollabRelayUrl)) {
		warn("Collab auto-start skipped: configure collab.relayUrl explicitly before using the public relay.");
		return undefined;
	}
	if ((cfgCollabRelayUrl.get(settings) ?? "") !== relayInput) {
		warn("Collab auto-start ignored an overlay collab.relayUrl.");
	}
	const configuredLinkPath = cfgCollabWriteLinkPath.get(settings) ?? "";
	const writeLinkPath =
		cfgCollabWriteLinkPath.provenance(settings) === "overlay"
			? ""
			: (trustedCollabSetting(settings, cfgCollabWriteLinkPath) ?? "");
	if (configuredLinkPath.trim() && !writeLinkPath) {
		warn("Collab link file skipped: configure collab.writeLinkPath outside config overlays.");
	}
	const webUrl = trustedCollabSetting(settings, cfgCollabWebUrl) ?? "";
	if ((cfgCollabWebUrl.get(settings) ?? "") !== webUrl) {
		warn("Collab auto-start ignored an overlay collab.webUrl.");
	}
	return { access, relayUrl, webUrl, writeLinkPath };
}

export function resolveCollabLinkPath(rawPath: string, ctxCwd: string): string {
	const expanded = expandTilde(rawPath.trim());
	return path.isAbsolute(expanded) ? expanded : path.resolve(ctxCwd, expanded);
}

async function withCollabLinkLock<T>(target: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	return await withFileLock(target, fn, { signal });
}

export function sanitizeCollabError(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return sanitizeStatusText(detail, TRUNCATE_LENGTHS.CONTENT, "Unknown error");
}

export async function writeCollabLink(target: string, link: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	const tempPath = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
	);
	try {
		await withCollabLinkLock(
			target,
			async () => {
				if (signal?.aborted) return;
				let removeTemp = false;
				try {
					const handle = await fs.open(tempPath, "wx", 0o600);
					removeTemp = true;
					try {
						await handle.writeFile(link, "utf8");
						await handle.sync();
					} finally {
						await handle.close();
					}
					if (signal?.aborted) return;
					await replaceFileAtomically(tempPath, target);
					removeTemp = false;
				} finally {
					if (removeTemp) await fs.rm(tempPath, { force: true }).catch(() => {});
				}
			},
			signal,
		);
	} catch (error) {
		if (signal?.aborted) return;
		throw error;
	}
}
