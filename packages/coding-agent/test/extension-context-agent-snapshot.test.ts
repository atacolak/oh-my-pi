import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createRunner(getAgentSnapshot?: () => AgentSnapshot): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner(
		[],
		runtime,
		"/tmp",
		{ getCwd: () => "/tmp" } as never,
		{} as never,
		undefined,
		undefined,
		undefined,
		undefined,
		getAgentSnapshot,
	);
}

describe("ExtensionRunner agent snapshot context", () => {
	it("defaults to an empty sanitized roster", () => {
		expect(createRunner().createContext().getAgentSnapshot()).toEqual({ agents: [] });
	});

	it("exposes the owning session snapshot", () => {
		const snapshot: AgentSnapshot = {
			selfId: "Main",
			agents: [{ id: "a3f7", displayName: "parser", kind: "sub", status: "running", activity: "investigate" }],
		};
		expect(
			createRunner(() => snapshot)
				.createContext()
				.getAgentSnapshot(),
		).toBe(snapshot);
	});
});
