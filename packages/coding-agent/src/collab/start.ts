import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getActiveProfile, isProfileSelectedFromArgv, isProfileSelectedFromOmpEnv } from "@oh-my-pi/pi-utils/dirs";
import * as env from "@oh-my-pi/pi-utils/env";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { getDefault, type SettingPath, type SettingValue, type Settings } from "../config/settings";
import { expandTilde } from "../tools/path-utils";
import { sanitizeStatusText, TRUNCATE_LENGTHS } from "../tools/render-utils";
import { replaceFileAtomically } from "../utils/atomic-file";
import { DEFAULT_RELAY_URL } from "./protocol";
import type { CollabAccess } from "./registry";

export type CollabAutoStart = "off" | CollabAccess;

type CollabSettingPath = Extract<SettingPath, `collab.${string}`>;

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

function collabLayerValue(layer: unknown, path: CollabSettingPath): unknown {
	let current: unknown = layer;
	for (const segment of path.split(".")) {
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

function trustedCollabSetting<P extends CollabSettingPath>(settings: Settings, path: P): SettingValue<P> {
	const provenance = settings.getProvenance(path);
	if (provenance === "runtime" || provenance === "default") return settings.get(path);
	const effective = settings.get(path);
	if (path === "collab.autoStart") {
		if (isAutoStartOff(effective)) return "off" as SettingValue<P>;
		if (settings.getProjectSettingsLayers().some(layer => isAutoStartOff(collabLayerValue(layer, path)))) {
			return "off" as SettingValue<P>;
		}
		if (settings.getConfigOverlayLayers().some(layer => isAutoStartOff(collabLayerValue(layer, path)))) {
			return "off" as SettingValue<P>;
		}
	}
	if (redirectedGlobalConfig() && provenance !== "project") return getDefault(path);
	if (provenance === "overlay") {
		const projectValue = collabLayerValue(settings.getProjectSettings(), path);
		if (projectValue !== undefined) return projectValue as SettingValue<P>;
		const globalValue = collabLayerValue(settings.getGlobalSettings(), path);
		return (globalValue !== undefined ? globalValue : getDefault(path)) as SettingValue<P>;
	}
	return effective;
}

function isTrustedCollabConfigured(settings: Settings, path: CollabSettingPath): boolean {
	const provenance = settings.getProvenance(path);
	if (provenance === "runtime") return true;
	if (redirectedGlobalConfig()) return provenance === "project";
	if (provenance === "overlay") {
		return (
			collabLayerValue(settings.getProjectSettings(), path) !== undefined ||
			collabLayerValue(settings.getGlobalSettings(), path) !== undefined
		);
	}
	return settings.isConfigured(path);
}

export function resolveRelayUrl(input: string): string {
	const trimmed = input.trim();
	return trimmed.includes("://") ? trimmed : `wss://${trimmed}`;
}

export function resolveTrustedAutoStartMode(settings: Settings): CollabAutoStart {
	return asAutoStart(trustedCollabSetting(settings, "collab.autoStart"));
}

export function resolveTrustedAutoStartLaunch(
	settings: Settings,
	warn: (message: string) => void,
): TrustedAutoStartLaunch | undefined {
	const access = resolveTrustedAutoStartMode(settings);
	if (access === "off") {
		if (!isAutoStartOff(settings.get("collab.autoStart"))) {
			warn("Collab auto-start skipped: configure collab.autoStart outside config overlays.");
		}
		return undefined;
	}
	const relayInput = trustedCollabSetting(settings, "collab.relayUrl")?.trim() ?? "";
	if (!relayInput) {
		return { access, relayUrl: "", webUrl: "", writeLinkPath: "" };
	}
	const relayUrl = resolveRelayUrl(relayInput);
	if (relayUrl === DEFAULT_RELAY_URL && !isTrustedCollabConfigured(settings, "collab.relayUrl")) {
		warn("Collab auto-start skipped: configure collab.relayUrl explicitly before using the public relay.");
		return undefined;
	}
	if ((settings.get("collab.relayUrl") ?? "") !== relayInput) {
		warn("Collab auto-start ignored an overlay collab.relayUrl.");
	}
	const configuredLinkPath = settings.get("collab.writeLinkPath") ?? "";
	const writeLinkPath =
		settings.getProvenance("collab.writeLinkPath") === "overlay"
			? ""
			: (trustedCollabSetting(settings, "collab.writeLinkPath") ?? "");
	if (configuredLinkPath.trim() && !writeLinkPath) {
		warn("Collab link file skipped: configure collab.writeLinkPath outside config overlays.");
	}
	const webUrl = trustedCollabSetting(settings, "collab.webUrl") ?? "";
	if ((settings.get("collab.webUrl") ?? "") !== webUrl) {
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
