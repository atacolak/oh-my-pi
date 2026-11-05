/**
 * Minimal live `RpcCommandSurface` for command-level tests: one stub session,
 * one collector for the frames the surface originates, and no transport.
 *
 * The surface is the single implementation both transports run
 * (`runRpcMode`'s stdio dispatcher and a session socket's per-connection
 * surface), so a test that drives `handleCommand` here proves the command
 * itself; `test/rpc-mcp-control.test.ts` additionally serves the same surface
 * over a real `RpcSessionSocket` to prove the transport wiring.
 */
import { type Mock, vi } from "bun:test";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	RpcCommandSurface,
	RpcPendingExtensionRequests,
	type RpcOutput,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-surface";
import { RpcClientConnection, RpcClientRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/client-connection";
import { MAX_RPC_FRAME_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { CompactMode } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSessionStub, type SessionOverrides } from "./interactive-mode-context";

/** One recorded frame the surface originated (responses, UI requests, notifications). */
export type RecordedFrame = { type?: string; [key: string]: unknown };

function isRecordFrame(frame: object): frame is RecordedFrame {
	return !Array.isArray(frame);
}

export interface RpcSurfaceHarness {
	readonly surface: RpcCommandSurface;
	readonly session: AgentSession;
	/** The stub session's compaction entry point, for argument assertions. */
	readonly compact: CompactMock;
	/** Every frame the surface sent to its own sink. */
	readonly frames: RecordedFrame[];
	/** Send one command and return its response, as the stdio dispatcher does. */
	handle(command: RpcCommand): Promise<RpcResponse>;
	/** Frames the surface originated so far, filtered by `type`. */
	framesOfType(type: string): RecordedFrame[];
	dispose(): void;
}

/** The session compaction signature the `compact` command drives. */
export type CompactMock = Mock<(instructions?: string, options?: { mode: CompactMode }) => Promise<CompactionResult>>;

export interface RpcSurfaceHarnessOptions {
	session?: SessionOverrides;
	mcpManager?: MCPManager;
}

export function createRpcSurfaceHarness(options: RpcSurfaceHarnessOptions = {}): RpcSurfaceHarness {
	const compact: CompactMock = vi.fn(async (): Promise<CompactionResult> => ({
		summary: "compacted",
		firstKeptEntryId: "entry-1",
		tokensBefore: 1,
	}));
	const session = createSessionStub(SessionManager.inMemory(process.cwd()), Settings.isolated(), {
		compact,
		...options.session,
	});
	const frames: RecordedFrame[] = [];
	const output: RpcOutput = frame => {
		if (isRecordFrame(frame)) frames.push(frame);
	};
	const clients = new RpcClientRegistry();
	const defaultConn = new RpcClientConnection({ id: "stdio", send: () => {} });
	const promptResults = new RpcPromptResults(session, () => {});
	const surface = new RpcCommandSurface({
		session,
		output,
		clients,
		defaultConn,
		maxResponseBytes: () => MAX_RPC_FRAME_BYTES,
		pendingExtensionRequests: new RpcPendingExtensionRequests(),
		promptResults,
		extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		...(options.mcpManager ? { mcpManager: options.mcpManager } : {}),
	});

	return {
		surface,
		session,
		compact,
		frames,
		handle: command => surface.handleCommand(command),
		framesOfType: type => frames.filter(frame => frame.type === type),
		dispose: () => {
			surface.dispose();
		},
	};
}
