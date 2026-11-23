import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { RpcCommandBody } from "../modes/rpc/rpc-client";
import { runNamedSessionAttach } from "../launch/named-session-attach";
import { findCompactMode } from "../session/compact-modes";
import { formatSessionDumpText } from "../session/session-dump-format";
import { NativeSessionService, type NativeSessionSelector } from "../session/session-service";
import { discoverAgents } from "../task/discovery";
import { getEditorCommand, openEditorOnPath } from "../utils/external-editor";

export interface SockCommandArgs {
	action: string;
	target?: string;
	value?: string;
	json?: boolean;
	all?: boolean;
	live?: boolean;
	query?: string;
	pid?: number;
	lines?: number;
	full?: boolean;
	follow?: boolean;
	compact?: boolean;
	force?: boolean;
	graceful?: boolean;
	mode?: string;
}

const ACTIONS = new Set([
	"list",
	"status",
	"where",
	"context",
	"name",
	"rename",
	"read",
	"open",
	"wake",
	"attach",
	"stop",
	"abort",
	"sleep",
	"compact",
	"restart",
	"kill",
	"raw",
	"tap",
]);

function output(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function cell(value: string | null, width: number): string {
	return truncateToWidth(sanitizeText(replaceTabs(value ?? "-")), width).padEnd(width);
}

async function follow(service: NativeSessionService, target: NativeSessionSelector, raw: boolean): Promise<void> {
	const { client } = await service.connect(target);
	const done = Promise.withResolvers<void>();
	const onInterrupt = () => done.resolve();
	process.once("SIGINT", onInterrupt);
	const stopEvents = client.onSessionEvent(event => {
		if (raw) process.stdout.write(`${JSON.stringify(event)}\n`);
	});
	const stopCore = client.onEvent(event => {
		if (raw) process.stdout.write(`${JSON.stringify(event)}\n`);
		else if (event.type === "message_end") {
			process.stdout.write(
				`${sanitizeText(replaceTabs(formatSessionDumpText({ messages: [event.message], includeHeader: false })))}\n`,
			);
		}
	});
	try {
		await Promise.race([done.promise, client.waitForDisconnect()]);
	} finally {
		process.off("SIGINT", onInterrupt);
		stopEvents();
		stopCore();
		await client.stop();
	}
}

export async function runSockCommand(args: SockCommandArgs): Promise<void> {
	if (!ACTIONS.has(args.action)) throw new Error(`Unknown omp sock action: ${args.action}`);
	if (args.graceful && args.action !== "restart") throw new Error("--graceful is only valid with restart");
	if (args.pid !== undefined && args.target !== undefined)
		throw new Error("Choose a session name/UUID or --pid, not both");
	if (args.pid !== undefined && (!Number.isSafeInteger(args.pid) || args.pid < 1))
		throw new Error("--pid must be a positive integer");
	const service = new NativeSessionService(args.action === "list" ? { timeoutMs: 750 } : {});
	if (args.action === "list") {
		if (args.pid !== undefined || args.target !== undefined || args.value !== undefined)
			throw new Error("Use status to select one session; list accepts --query or --live");
		const result = await service.list({
			query: args.query,
			liveOnly: args.live,
			unnamedLimit: args.all ? undefined : 8,
		});
		if (args.json) output(result);
		else {
			process.stdout.write(
				`${cell("name", 22)} ${cell("state", 10)} ${cell("model", 34)} ${cell("pid", 9)} session\n`,
			);
			for (const session of result.sessions) {
				process.stdout.write(
					`${cell(session.handle, 22)} ${cell(session.state, 10)} ${cell(session.model, 34)} ${cell(session.pid === null ? null : String(session.pid), 9)} ${session.sessionId}\n`,
				);
			}
			process.stdout.write(
				`${result.attachableSockets ?? 0} attachable sockets; ${result.sessions.length} sessions shown${
					result.unverifiedSockets ? `; ${result.unverifiedSockets} sockets unverified` : ""
				}${result.omittedUnnamed ? `; ${result.omittedUnnamed} older unnamed sessions hidden (use --all)` : ""}\n`,
			);
		}
		return;
	}
	const target: NativeSessionSelector = args.pid === undefined ? (args.target ?? "") : { pid: args.pid };
	if (target === "") throw new Error(`omp sock ${args.action} requires a saved name, UUID, UUID prefix or --pid`);
	switch (args.action) {
		case "context": {
			const { client } = await service.connect(target);
			try {
				output(await client.getState());
			} finally {
				await client.stop();
			}
			return;
		}
		case "name":
		case "rename": {
			if (!args.value?.trim()) throw new Error("A new native session name is required");
			const { client, owner } = await service.connect(target, { wake: true });
			try {
				output(await client.setSessionIdentity(owner, { actorHandle: args.value }));
			} finally {
				await client.stop();
			}
			return;
		}
		case "status":
			output(await service.inspect(target));
			return;
		case "where":
			output(await service.resolve(target));
			return;
		case "wake":
			output(await service.wake(target));
			return;
		case "attach": {
			const selected = await service.resolve(target);
			await runNamedSessionAttach(selected.sessionId);
			return;
		}
		case "read": {
			const read = await service.read(target, { limit: args.full ? Number.MAX_SAFE_INTEGER : args.lines });
			if (args.json) output(read);
			else
				process.stdout.write(
					`${sanitizeText(replaceTabs(formatSessionDumpText({ messages: read.messages, includeHeader: false })))}\n`,
				);
			if (args.follow) await follow(service, target, args.json === true);
			return;
		}
		case "tap":
			await follow(service, target, true);
			return;
		case "open": {
			const selected = await service.resolve(target);
			let file = selected.sessionFile;
			if (args.value === "folder") file = selected.cwd;
			else if (args.value === "profile") {
				if (!selected.rootAgent || !selected.cwd) throw new Error("Session has no named profile");
				const { agents } = await discoverAgents(selected.rootAgentCwd ?? selected.cwd);
				file = agents.find(agent => agent.name === selected.rootAgent)?.filePath ?? null;
			} else if (args.value !== undefined && args.value !== "transcript")
				throw new Error("Open destination must be transcript, profile or folder");
			if (!file) throw new Error("Selected resource is unavailable");
			const editor = getEditorCommand();
			if (!editor) throw new Error("Set VISUAL or EDITOR to open this resource; use omp sock where for its path");
			const code = await openEditorOnPath(editor, file);
			if (code !== 0) throw new Error(`Editor exited with code ${code}`);
			return;
		}
		case "raw": {
			const command: unknown = args.value === undefined ? { type: "get_state" } : JSON.parse(args.value);
			if (!isRecord(command) || typeof command.type !== "string")
				throw new Error("Raw command must be a JSON object with a type");
			const response = await service.request(target, command as RpcCommandBody);
			output(response);
			if (!response.success) process.exitCode = 1;
			return;
		}
		default: {
			const mode = args.mode === undefined ? undefined : findCompactMode(args.mode)?.name;
			if (args.mode !== undefined && mode !== args.mode) throw new Error(`Unknown compaction mode: ${args.mode}`);
			const action = args.action === "stop" ? "abort" : args.action;
			if (
				action !== "abort" &&
				action !== "sleep" &&
				action !== "compact" &&
				action !== "restart" &&
				action !== "kill"
			)
				throw new Error(`Unsupported lifecycle action: ${action}`);
			output(
				await service.control(target, action, {
					force: args.force,
					graceful: args.graceful,
					compactBeforeRestart: args.compact,
					mode,
				}),
			);
		}
	}
}
