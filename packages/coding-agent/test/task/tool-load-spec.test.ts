/**
 * MCP access is closed-world for a named profile: omitting `mcps:` allows no
 * server, while only a bare unnamed session defaults to every user server.
 *
 * Rows below pin the whole decision table. The named-profile rows that both end
 * in "no server" are separated by provenance: an omitted field is synthesized
 * into a declared-empty policy, an explicit `mcps: []` is preserved verbatim.
 */
import { describe, expect, it } from "bun:test";
import {
	mcpLoadForNamedProfile,
	mcpServerAllowlist,
	mcpServerAllowed,
	type NamedLoadSet,
	parseNamedLoadSet,
} from "@oh-my-pi/pi-coding-agent/task/tool-load-spec";

const parseMcps = (value: unknown) => parseNamedLoadSet(value, { agent: "lead", field: "mcps", normalize: false });

const SERVERS = ["youtube", "mail"] as const;

describe("named profile mcps: closed-world default", () => {
	it("denies every server for a named profile that omits mcps:", () => {
		const resolved = mcpLoadForNamedProfile(undefined);
		expect(resolved.declared).toBe(true);
		expect(resolved.names).toEqual([]);
		expect(mcpServerAllowlist(resolved)?.size).toBe(0);
		for (const server of SERVERS) expect(mcpServerAllowed(resolved, server)).toBe(false);
	});

	it("allows exactly the declared servers for a named profile with a list", () => {
		const declared = parseMcps(["youtube"])!;
		const resolved = mcpLoadForNamedProfile(declared);
		expect(resolved).toBe(declared);
		expect(mcpServerAllowlist(resolved)).toEqual(new Set(["youtube"]));
		expect(mcpServerAllowed(resolved, "youtube")).toBe(true);
		expect(mcpServerAllowed(resolved, "mail")).toBe(false);
	});

	it("keeps an explicit mcps: [] profile verbatim and denies every server", () => {
		const declared = parseMcps([])!;
		const resolved = mcpLoadForNamedProfile(declared);
		expect(resolved).toBe(declared);
		expect(mcpServerAllowlist(resolved)?.size).toBe(0);
		for (const server of SERVERS) expect(mcpServerAllowed(resolved, server)).toBe(false);
	});

	it("leaves a bare unnamed session with no mcpLoad open to every server", () => {
		const bare: NamedLoadSet | undefined = undefined;
		expect(mcpServerAllowlist(bare)).toBeUndefined();
		for (const server of SERVERS) expect(mcpServerAllowed(bare, server)).toBe(true);
	});

	it("narrows a bare unnamed session that names servers itself", () => {
		const declared = parseMcps(["youtube"])!;
		expect(mcpServerAllowlist(declared)).toEqual(new Set(["youtube"]));
		expect(mcpServerAllowed(declared, "youtube")).toBe(true);
		expect(mcpServerAllowed(declared, "mail")).toBe(false);
	});
});
