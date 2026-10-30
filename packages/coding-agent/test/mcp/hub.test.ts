import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hubChildUrl, hubDiscoveredServers, hubOriginUrl, parseHubCatalog, resolveHubCatalogNames } from "../../src/mcp/hub";
import { loadAllMCPConfigs } from "../../src/mcp/config";
import { mcpOAuthCredentialIdsForServerUrl } from "../../src/mcp/oauth-credentials";
import type { AuthStorage } from "../../src/session/auth-storage";
import { getAgentDir, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";

describe("MCPHub catalog", () => {
	test("parses array, servers list, and named map catalogs", () => {
		expect(parseHubCatalog(["whatsapp", "mail"])).toEqual(["whatsapp", "mail"]);
		expect(parseHubCatalog({ servers: [{ name: "storage" }, { name: "youtube" }] })).toEqual(["storage", "youtube"]);
		expect(parseHubCatalog({ servers: { github: {}, sfub: {} } })).toEqual(["github", "sfub"]);
	});

	test("builds child http servers under the hub origin", () => {
		const configs = hubDiscoveredServers("https://mcp.colak.sh", ["youtube"]);
		expect(configs.youtube).toEqual({ type: "http", url: "https://mcp.colak.sh/mcp/youtube" });
		expect(hubChildUrl("https://mcp.colak.sh/", "mail")).toBe("https://mcp.colak.sh/mcp/mail");
	});

	test("child /mcp URLs share the hub origin credential id", () => {
		expect(hubOriginUrl("https://mcp.colak.sh/mcp/youtube")).toBe("https://mcp.colak.sh");
		const ids = mcpOAuthCredentialIdsForServerUrl("https://mcp.colak.sh/mcp/youtube");
		const originIds = mcpOAuthCredentialIdsForServerUrl("https://mcp.colak.sh");
		expect(ids.some(id => originIds.includes(id))).toBe(true);
	});

	test("fetches live catalog when a bearer exists and caches names", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hub-catalog-${Snowflake.next()}`));
		const cachePath = path.join(dir, "mcp-hub-catalog.json");
		try {
			const names = await resolveHubCatalogNames("https://mcp.colak.sh", {
				bearer: "test-token",
				cachePath,
				fetchCatalog: async () => ["whatsapp", "calendar"],
			});
			expect(names).toEqual(["whatsapp", "calendar"]);
			const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
				"https://mcp.colak.sh": { names: string[] };
			};
			expect(cached["https://mcp.colak.sh"].names).toEqual(["whatsapp", "calendar"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back to cache then defaults when unauthenticated", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hub-catalog-${Snowflake.next()}`));
		const cachePath = path.join(dir, "mcp-hub-catalog.json");
		try {
			fs.writeFileSync(
				cachePath,
				JSON.stringify({ "https://mcp.colak.sh": { names: ["mail"], fetchedAt: "2026-01-01T00:00:00.000Z" } }),
			);
			const cached = await resolveHubCatalogNames("https://mcp.colak.sh", {
				cachePath,
				fetchCatalog: async () => {
					throw new Error("must not fetch without bearer");
				},
			});
			expect(cached).toEqual(["mail"]);
			const missing = await resolveHubCatalogNames("https://mcp.colak.sh", {
				cachePath: path.join(dir, "empty.json"),
				defaults: ["youtube"],
			});
			expect(missing).toEqual(["youtube"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("loadAllMCPConfigs fetches hub catalog when an OAuth credential exists", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hub-load-${Snowflake.next()}`));
		const previous = getAgentDir();
		setAgentDir(dir);
		try {
			fs.writeFileSync(
				path.join(dir, "mcp.json"),
				JSON.stringify({ hubs: { colak: { url: "https://mcp.colak.sh" } } }),
			);
			const fetched: string[] = [];
			const result = await loadAllMCPConfigs(dir, {
				enableProjectConfig: false,
				filterExa: false,
				authStorage: {
					credentials: {
						get: () => ({ type: "oauth", access: "tok" }),
					},
				} as unknown as AuthStorage,
				fetchHubCatalog: async (_url, bearer) => {
					fetched.push(bearer ?? "");
					return ["calendar"];
				},
			});
			expect(fetched).toEqual(["tok"]);
			expect(result.configs.calendar).toEqual({ type: "http", url: "https://mcp.colak.sh/mcp/calendar" });
		} finally {
			setAgentDir(previous);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
