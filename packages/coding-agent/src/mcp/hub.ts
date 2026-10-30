/**
 * MCPHub auto-discovery: one hub origin, many `/mcp/<name>` servers, one OAuth login.
 *
 * Catalog fetch never logs tokens. Child servers inherit the hub origin credential
 * via {@link hubOriginUrl}.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { MCPHttpServerConfig, MCPServerConfig } from "./types";

export type MCPHubEntry = {
	url: string;
};

const SERVER_NAME = /^[a-zA-Z0-9_.-]{1,100}$/;

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
			logger.debug("MCP hub catalog fetch failed", { url: origin, path: new URL(url).pathname, error: String(error) });
		}
	}
	return [];
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
