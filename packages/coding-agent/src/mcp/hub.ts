/**
 * MCPHub auto-discovery: one hub origin, many `/mcp/<name>` servers, one OAuth login.
 *
 * Catalog fetch never logs tokens. Child servers inherit the hub origin credential
 * via {@link hubOriginUrl}.
 */
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import type { MCPHttpServerConfig, MCPServerConfig } from "./types";

export type MCPHubEntry = {
	url: string;
};

const SERVER_NAME = /^[a-zA-Z0-9_.-]{1,100}$/;

type HubCatalogCacheFile = Record<string, { names: string[]; fetchedAt: string }>;

export function hubOriginUrl(serverUrl: string): string | undefined {
	try {
		const parsed = new URL(serverUrl);
		if (!parsed.pathname.startsWith("/mcp")) return undefined;
		return parsed.origin;
	} catch {
		return undefined;
	}
}

/** Catalog names used when the hub has not answered yet. */
export const DEFAULT_COLAB_HUB_SERVERS = ["whatsapp", "mail", "storage", "youtube", "github", "sfub", "services-1"];

export function hubCatalogCachePath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "mcp-hub-catalog.json");
}

export function hubChildUrl(hubUrl: string, name: string): string {
	const origin = new URL(hubUrl).origin;
	return `${origin}/mcp/${name}`;
}

export function parseHubCatalog(payload: unknown): string[] {
	const names: string[] = [];
	const take = (value: unknown) => {
		if (typeof value !== "string" || !SERVER_NAME.test(value)) return;
		if (!names.includes(value)) names.push(value);
	};
	if (Array.isArray(payload)) {
		for (const item of payload) {
			if (typeof item === "string") take(item);
			else if (item && typeof item === "object" && "name" in item) take((item as { name: unknown }).name);
		}
		return names;
	}
	if (!payload || typeof payload !== "object") return names;
	const bag = payload as Record<string, unknown>;
	if (Array.isArray(bag.servers)) {
		for (const item of bag.servers) {
			if (typeof item === "string") take(item);
			else if (item && typeof item === "object" && "name" in item) take((item as { name: unknown }).name);
		}
		return names;
	}
	if (bag.servers && typeof bag.servers === "object" && !Array.isArray(bag.servers)) {
		for (const name of Object.keys(bag.servers)) take(name);
		return names;
	}
	for (const name of Object.keys(bag)) {
		if (name === "ok" || name === "count") continue;
		take(name);
	}
	return names;
}

export async function fetchHubCatalog(hubUrl: string, bearer?: string): Promise<string[]> {
	const origin = new URL(hubUrl).origin;
	const headers: Record<string, string> = { accept: "application/json" };
	if (bearer) headers.authorization = `Bearer ${bearer}`;
	const urls = [`${origin}/mcp/catalog`, `${origin}/api/servers`];
	for (const url of urls) {
		try {
			const response = await fetch(url, { headers });
			if (!response.ok) continue;
			const payload: unknown = await response.json();
			const names = parseHubCatalog(payload);
			if (names.length > 0) return names;
		} catch (error) {
			logger.debug("MCP hub catalog fetch failed", {
				url: origin,
				path: new URL(url).pathname,
				error: String(error),
			});
		}
	}
	return [];
}

async function readHubCatalogCache(cachePath: string, origin: string): Promise<string[]> {
	try {
		const parsed: unknown = await Bun.file(cachePath).json();
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const entry = (parsed as HubCatalogCacheFile)[origin];
		return Array.isArray(entry?.names)
			? entry.names.filter(name => typeof name === "string" && SERVER_NAME.test(name))
			: [];
	} catch (error) {
		if (isEnoent(error)) return [];
		logger.debug("MCP hub catalog cache unreadable", { origin, error: String(error) });
		return [];
	}
}

async function writeHubCatalogCache(cachePath: string, origin: string, names: string[]): Promise<void> {
	let file: HubCatalogCacheFile = {};
	try {
		const parsed: unknown = await Bun.file(cachePath).json();
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			file = parsed as HubCatalogCacheFile;
		}
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("MCP hub catalog cache reset", { origin, error: String(error) });
		}
	}
	file[origin] = { names, fetchedAt: new Date().toISOString() };
	await Bun.write(cachePath, `${JSON.stringify(file, null, 2)}\n`);
}

export type ResolveHubCatalogOptions = {
	bearer?: string;
	cachePath?: string;
	fetchCatalog?: (hubUrl: string, bearer?: string) => Promise<string[]>;
	defaults?: string[];
};

/**
 * Live catalog when a bearer exists; otherwise cached names, then hardcoded defaults.
 * Never logs the bearer.
 */
export async function resolveHubCatalogNames(
	hubUrl: string,
	options: ResolveHubCatalogOptions = {},
): Promise<string[]> {
	const origin = new URL(hubUrl).origin;
	const cachePath = options.cachePath ?? hubCatalogCachePath();
	const fetchCatalog = options.fetchCatalog ?? fetchHubCatalog;
	if (options.bearer) {
		const names = await fetchCatalog(hubUrl, options.bearer);
		if (names.length > 0) {
			try {
				await writeHubCatalogCache(cachePath, origin, names);
			} catch (error) {
				logger.debug("MCP hub catalog cache write failed", { origin, error: String(error) });
			}
			return names;
		}
	}
	const cached = await readHubCatalogCache(cachePath, origin);
	if (cached.length > 0) return cached;
	return options.defaults ?? DEFAULT_COLAB_HUB_SERVERS;
}

export function hubDiscoveredServers(
	hubUrl: string,
	names: string[],
	auth?: MCPHttpServerConfig["auth"],
): Record<string, MCPServerConfig> {
	const configs: Record<string, MCPServerConfig> = {};
	for (const name of names) {
		if (!SERVER_NAME.test(name)) continue;
		configs[name] = {
			type: "http",
			url: hubChildUrl(hubUrl, name),
			...(auth ? { auth } : {}),
		};
	}
	return configs;
}
