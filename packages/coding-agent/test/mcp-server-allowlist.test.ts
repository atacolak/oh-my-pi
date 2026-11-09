/**
 * A session whose MCP policy is closed must not DIAL servers, not merely hide
 * their tools. `session-tools` filters mounted MCP tool names after
 * `discoverAndConnect` has already opened every configured server, so a profile
 * that declares no MCPs still spawned and handshook the user's whole set.
 *
 * These assertions are on the manager's own discovery and connect calls: the
 * tool list was already correct before the fix, so the dial path is the contract.
 */
import { describe, expect, it, spyOn } from "bun:test";
import type { LoadMCPConfigsResult } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager, type MCPLoadResult } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

function stdio(name: string): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [`${name}.ts`] };
}

/** The user's discovered servers: three distinct names, none of them connected here. */
function discoveredServers(): LoadMCPConfigsResult {
	return {
		configs: { youtube: stdio("youtube"), whatsapp: stdio("whatsapp"), mail: stdio("mail") },
		sources: {},
		exaApiKeys: [],
	};
}

function emptyResult(): MCPLoadResult {
	return { tools: [], errors: new Map(), connectedServers: [], exaApiKeys: [] };
}

describe("MCPManager server allowlist", () => {
	it("dials nothing when the allowlist is empty", async () => {
		let loadCalls = 0;
		const manager = new MCPManager(process.cwd(), null, async () => {
			loadCalls += 1;
			return discoveredServers();
		});
		const connect = spyOn(manager, "connectServers").mockResolvedValue(emptyResult());

		const result = await manager.discoverAndConnect({ serverAllowlist: new Set() });

		expect(loadCalls).toBe(0);
		expect(connect).not.toHaveBeenCalled();
		expect(result.tools).toEqual([]);
		expect(result.connectedServers).toEqual([]);
	});

	it("dials only the allowlisted server", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => discoveredServers());
		const connect = spyOn(manager, "connectServers").mockResolvedValue(emptyResult());

		await manager.discoverAndConnect({ serverAllowlist: new Set(["youtube"]) });

		expect(connect).toHaveBeenCalledTimes(1);
		expect(Object.keys(connect.mock.calls[0]![0])).toEqual(["youtube"]);
		expect(connect.mock.calls[0]![1]).toEqual({});
	});

	it("dials every discovered server for a session with no allowlist", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => discoveredServers());
		const connect = spyOn(manager, "connectServers").mockResolvedValue(emptyResult());

		await manager.discoverAndConnect();

		expect(Object.keys(connect.mock.calls[0]![0]).sort()).toEqual(["mail", "whatsapp", "youtube"]);
	});

	it("keeps the allowlist when a later reload passes no allowlist", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => discoveredServers());
		const connect = spyOn(manager, "connectServers").mockResolvedValue(emptyResult());

		await manager.discoverAndConnect({ serverAllowlist: new Set(["youtube"]) });
		await manager.discoverAndConnect({ filterExa: true });

		expect(connect).toHaveBeenCalledTimes(2);
		expect(Object.keys(connect.mock.calls[1]![0])).toEqual(["youtube"]);
	});
});
