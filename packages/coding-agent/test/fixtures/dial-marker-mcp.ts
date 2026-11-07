#!/usr/bin/env bun
/**
 * Test fixture: a minimal stdio MCP server that records its own spawn.
 *
 * `mcps:` filtering has to happen before the manager dials, so a test needs a
 * signal that survives the tool list being filtered anyway. This fixture appends
 * its tag to `argv[2]` at process start, before any handshake: a marker line
 * means the server was spawned, whatever the session later mounted.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`).
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

const markerPath = process.argv[2];
const tag = process.argv[3] ?? "server";
if (markerPath) fs.appendFileSync(markerPath, `${tag}\n`);

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: { name?: string };
};

function startServer(): void {
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		let request: JsonRpcRequest;
		try {
			request = JSON.parse(line) as JsonRpcRequest;
		} catch {
			return;
		}
		if (request.id === undefined || request.id === null) return;
		let result: Record<string, unknown>;
		switch (request.method) {
			case "initialize":
				result = {
					protocolVersion: "2025-03-26",
					serverInfo: { name: `dial-marker-${tag}`, version: "1.0.0" },
					capabilities: { tools: {} },
				};
				break;
			case "tools/list":
				result = {
					tools: [
						{
							name: "ping",
							description: `${tag} ping`,
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				};
				break;
			case "tools/call":
				result = { content: [{ type: "text", text: tag }], isError: false };
				break;
			default:
				result = {};
		}
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) startServer();
