import { afterEach, describe, expect, it } from "bun:test";
import { COMPACT_MODES, type CompactMode } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import { createRpcSurfaceHarness, type RpcSurfaceHarness } from "./helpers/rpc-command-surface";

let harness: RpcSurfaceHarness | undefined;

afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

describe("compact RPC command modes", () => {
	it("forwards an explicit mode to session.compact", async () => {
		harness = createRpcSurfaceHarness();
		const response = await harness.handle({ id: "1", type: "compact", mode: "soft" });

		expect(response).toMatchObject({ id: "1", command: "compact", success: true });
		expect(harness.compact.mock.calls).toEqual([[undefined, { mode: "soft" }]]);
	});

	it("forwards a mode together with focus instructions", async () => {
		harness = createRpcSurfaceHarness();
		await harness.handle({ id: "2", type: "compact", mode: "remote", customInstructions: "focus on auth" });

		expect(harness.compact.mock.calls).toEqual([["focus on auth", { mode: "remote" }]]);
	});

	it("keeps the legacy single-argument call when no mode is given", async () => {
		harness = createRpcSurfaceHarness();
		await harness.handle({ id: "3", type: "compact", customInstructions: "focus" });

		expect(harness.compact.mock.calls).toEqual([["focus"]]);
	});

	it("accepts every declared compact mode", async () => {
		harness = createRpcSurfaceHarness();
		for (const mode of COMPACT_MODES) {
			const response = await harness.handle({ id: mode.name, type: "compact", mode: mode.name });
			expect(response.success).toBe(true);
		}
		expect(harness.compact.mock.calls.map(call => call[1]?.mode)).toEqual(COMPACT_MODES.map(mode => mode.name));
	});

	it("refuses an unknown mode instead of falling back to the default", async () => {
		harness = createRpcSurfaceHarness();
		const response = await harness.handle({ id: "4", type: "compact", mode: "bogus" as CompactMode });

		expect(response).toMatchObject({
			id: "4",
			command: "compact",
			success: false,
			code: "invalid_compact_mode",
			error: 'Invalid compact mode: bogus. Expected "soft", "remote", or "snapcompact".',
		});
		expect(harness.compact.mock.calls).toEqual([]);
	});

	it("refuses a mode that only matches case-insensitively", async () => {
		harness = createRpcSurfaceHarness();
		const response = await harness.handle({ id: "5", type: "compact", mode: "SOFT" as CompactMode });

		expect(response).toMatchObject({ success: false, code: "invalid_compact_mode" });
		expect(harness.compact.mock.calls).toEqual([]);
	});

	it("refuses a non-string mode", async () => {
		harness = createRpcSurfaceHarness();
		const response = await harness.handle({
			id: "6",
			type: "compact",
			mode: 7 as unknown as CompactMode,
		});

		expect(response).toMatchObject({
			success: false,
			code: "invalid_compact_mode",
			error: 'Invalid compact mode: 7. Expected "soft", "remote", or "snapcompact".',
		});
		expect(harness.compact.mock.calls).toEqual([]);
	});

	it("refuses focus instructions for snapcompact", async () => {
		harness = createRpcSurfaceHarness();
		const response = await harness.handle({
			id: "7",
			type: "compact",
			mode: "snapcompact",
			customInstructions: "focus",
		});

		expect(response).toMatchObject({
			id: "7",
			command: "compact",
			success: false,
			code: "invalid_compact_args",
			error: "/compact snapcompact does not take focus instructions.",
		});
		expect(harness.compact.mock.calls).toEqual([]);
	});

	it("allows blank focus instructions for snapcompact", async () => {
		harness = createRpcSurfaceHarness();
		const response = await harness.handle({
			id: "8",
			type: "compact",
			mode: "snapcompact",
			customInstructions: "   ",
		});

		expect(response.success).toBe(true);
		expect(harness.compact.mock.calls).toEqual([["   ", { mode: "snapcompact" }]]);
	});
});
