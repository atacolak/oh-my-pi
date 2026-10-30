import { describe, expect, test } from "bun:test";
import { hubChildUrl, hubDiscoveredServers, hubOriginUrl, parseHubCatalog } from "../../src/mcp/hub";
import { mcpOAuthCredentialIdsForServerUrl } from "../../src/mcp/oauth-credentials";

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
});
