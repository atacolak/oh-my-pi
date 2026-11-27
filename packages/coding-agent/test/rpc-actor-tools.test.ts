import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readRuntimeBootIdentity } from "@oh-my-pi/pi-coding-agent/launch/runtime-generation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcClientConnection, RpcClientRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/client-connection";
import {
	RpcCommandSurface,
	RpcPendingExtensionRequests,
	type RpcOutput,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-surface";
import { MAX_RPC_FRAME_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ActorToolState } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionStub } from "./helpers/interactive-mode-context";

const SESSION_ID = "01a00000-0000-7000-8000-000000000031";
const NOW: ActorToolState = {
	active: ["glob", "read"],
	available: ["bash", "find", "glob", "read"],
	added: [],
	removed: [],
	revision: "rev-1",
};
const APPLIED: ActorToolState = {
	active: ["find", "read"],
	available: ["bash", "find", "glob", "read"],
	added: ["find"],
	removed: ["glob"],
	revision: "rev-2",
};

type Frame = Record<string, unknown> & { type?: string; id?: string; method?: string };

interface Harness {
	readonly surface: RpcCommandSurface;
	readonly apply: ReturnType<typeof vi.fn>;
	readonly frames: Frame[];
	readonly pending: RpcPendingExtensionRequests;
	readonly sessionFile: string;
	handle(command: RpcCommand, conn?: RpcClientConnection): Promise<RpcResponse>;
	nextConfirm(): Promise<Frame>;
	answer(id: string, confirmed: boolean): void;
}

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@rpc-actor-tools-");
});

afterEach(() => {
	tempDir.removeSync();
});

async function createHarness(
	options: {
		supportsUi?: boolean;
		touch?: () => Promise<void>;
		confirmActorToolChange?: (title: string, message: string) => Promise<boolean>;
	} = {},
): Promise<Harness> {
	const requestedFile = path.join(tempDir.path(), "session.jsonl");
	await fs.writeFile(requestedFile, "");
	const sessionFile = await fs.realpath(requestedFile);
	const manager = SessionManager.inMemory(tempDir.path());
	manager.hasSessionOwnership = () => true;
	const apply = vi.fn(async () => {
		await options.touch?.();
		return APPLIED;
	});
	const session = createSessionStub(manager, Settings.isolated(), {
		sessionId: SESSION_ID,
		sessionFile,
		baseSystemPrompt: [],
		getActorToolState: () => NOW,
		applyActorToolChange: apply,
	});
	const frames: Frame[] = [];
	const record = (frame: object): void => {
		frames.push(frame as Frame);
	};
	const output: RpcOutput = frame => record(frame);
	const pending = new RpcPendingExtensionRequests();
	const surface = new RpcCommandSurface({
		session,
		output,
		clients: new RpcClientRegistry(),
		defaultConn: new RpcClientConnection({
			id: "stdio",
			send: frame => record(frame),
			supportsUi: options.supportsUi !== false,
		}),
		maxResponseBytes: () => MAX_RPC_FRAME_BYTES,
		pendingExtensionRequests: pending,
		promptResults: new RpcPromptResults(session, () => {}),
		extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		...(options.confirmActorToolChange ? { confirmActorToolChange: options.confirmActorToolChange } : {}),
	});
	return {
		surface,
		apply,
		frames,
		pending,
		sessionFile,
		handle: (command, conn) => surface.handleCommand(command, conn),
		nextConfirm: async () => {
			for (let attempt = 0; attempt < 200; attempt++) {
				const frame = frames.find(
					candidate =>
						candidate.type === "extension_ui_request" &&
						candidate.method === "confirm" &&
						typeof candidate.id === "string",
				);
				if (frame) return frame;
				await new Promise(resolve => setTimeout(resolve, 5));
			}
			throw new Error("The mutator never requested operator approval");
		},
		answer: (id, confirmed) => {
			const request = pending.get(id);
			if (!request) throw new Error(`No pending approval ${id}`);
			request.resolve({ type: "extension_ui_response", id, confirmed });
		},
	};
}

function applyCommand(harness: Harness, overrides: Record<string, unknown> = {}): RpcCommand {
	return {
		id: "apply-1",
		type: "apply_actor_tools",
		expectedSessionId: SESSION_ID,
		expectedSessionFile: harness.sessionFile,
		expectedBootId: readRuntimeBootIdentity().bootId,
		revision: NOW.revision,
		add: ["find"],
		remove: ["glob"],
		...overrides,
	} as unknown as RpcCommand;
}

describe("RPC actor tools", () => {
	it("reads the saved overrides and effective tools without asking for approval", async () => {
		const harness = await createHarness();
		const response = await harness.handle({ id: "read-1", type: "get_actor_tools" });

		expect(response.success).toBe(true);
		if (!response.success) throw new Error("expected success");
		expect((response as { data?: unknown }).data).toEqual(NOW);
		expect(harness.frames.some(frame => frame.type === "extension_ui_request")).toBe(false);
		harness.surface.dispose();
	});

	it("refuses a socket proposal when the owner offers no interactive confirmation", async () => {
		const harness = await createHarness();
		const socket = new RpcClientConnection({ id: "socket-1", send: () => {} });
		const response = await harness.handle(applyCommand(harness), socket);

		expect(response.success).toBe(false);
		expect((response as { code?: string }).code).toBe("actor_tool_operator_required");
		expect(harness.apply).not.toHaveBeenCalled();
		expect(harness.frames.some(frame => frame.type === "extension_ui_request")).toBe(false);
		harness.surface.dispose();
	});

	it("applies a socket proposal only after the owner's interactive confirmation", async () => {
		const confirmed: Array<{ title: string; message: string }> = [];
		const harness = await createHarness({
			confirmActorToolChange: async (title, message) => {
				confirmed.push({ title, message });
				return true;
			},
		});
		const socket = new RpcClientConnection({ id: "socket-1", send: () => {} });
		const response = await harness.handle(applyCommand(harness), socket);

		expect(response.success).toBe(true);
		if (!response.success) throw new Error("expected success");
		expect((response as { data?: unknown }).data).toEqual(APPLIED);
		expect(confirmed).toHaveLength(1);
		expect(confirmed[0]!.message).toContain(SESSION_ID);
		expect(confirmed[0]!.message).toContain(harness.sessionFile);
		expect(harness.frames.some(frame => frame.type === "extension_ui_request")).toBe(false);
		harness.surface.dispose();
	});

	it("refuses authority supplied in a caller field", async () => {
		const harness = await createHarness();
		const response = await harness.handle(applyCommand(harness, { approval: true }));

		expect(response.success).toBe(false);
		expect((response as { code?: string }).code).toBe("actor_tool_operator_required");
		expect(harness.apply).not.toHaveBeenCalled();
		harness.surface.dispose();
	});

	it("refuses a different owner before asking the operator", async () => {
		const harness = await createHarness();
		for (const overrides of [
			{ expectedSessionId: "01a00000-0000-7000-8000-000000000032" },
			{ expectedBootId: "another-boot" },
			{ revision: "rev-0" },
		]) {
			const response = await harness.handle(applyCommand(harness, overrides));
			expect(response.success).toBe(false);
			expect((response as { code?: string }).code).toBe(
				"revision" in overrides ? "actor_tool_revision_stale" : "actor_tool_target_mismatch",
			);
		}
		expect(harness.apply).not.toHaveBeenCalled();
		expect(harness.frames.some(frame => frame.type === "extension_ui_request")).toBe(false);
		harness.surface.dispose();
	});

	it("applies the exact change only after explicit operator confirmation", async () => {
		const harness = await createHarness();
		const pending = harness.handle(applyCommand(harness));
		const dialog = await harness.nextConfirm();

		expect(String(dialog.message)).toContain("find");
		expect(String(dialog.message)).toContain("glob");
		expect(String(dialog.message)).toContain("conversation");
		harness.answer(String(dialog.id), true);

		const response = await pending;
		expect(response.success).toBe(true);
		if (!response.success) throw new Error("expected success");
		expect((response as { data?: unknown }).data).toEqual(APPLIED);
		expect(harness.apply).toHaveBeenCalledWith(
			{ add: ["find"], remove: ["glob"], expectedRevision: NOW.revision },
			expect.any(Function),
		);
		harness.surface.dispose();
	});

	it("does not apply when the operator declines", async () => {
		const harness = await createHarness();
		const pending = harness.handle(applyCommand(harness));
		const dialog = await harness.nextConfirm();
		harness.answer(String(dialog.id), false);

		const response = await pending;
		expect(response.success).toBe(false);
		expect((response as { code?: string }).code).toBe("actor_tool_approval_declined");
		expect(harness.apply).not.toHaveBeenCalled();
		harness.surface.dispose();
	});

	it("keeps the read-only API when the host cannot present an approval", async () => {
		const harness = await createHarness({ supportsUi: false, touch: async () => {} });
		const read = await harness.handle({ id: "read-2", type: "get_actor_tools" });
		expect(read.success).toBe(true);

		const response = await harness.handle(applyCommand(harness));
		expect(response.success).toBe(false);
		expect((response as { code?: string }).code).toBe("actor_tool_approval_unavailable");
		expect(harness.apply).not.toHaveBeenCalled();
		harness.surface.dispose();
	});
});
