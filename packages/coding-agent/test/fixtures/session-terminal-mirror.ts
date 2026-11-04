// Process fixture — real timers are required (ts-no-test-timers exception): it
// runs the terminal mirror against a real broker over a real PTY, and its death
// is delivered by the kernel. Control signals are sockets, file markers and
// process liveness, never fixed delays.
import * as fs from "node:fs";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { runTerminalMirror, type TerminalMirrorResult } from "../../src/launch/terminal-mirror";

interface MirrorConfig {
	projectDir: string;
	runtimeDir: string;
	name: string;
	id: string;
	subscriptionId: string;
	statusFile: string;
	endpoint?: string;
	sessionId?: string;
	generation?: string;
	refresh?: boolean;
	columns?: number;
	rows?: number;
}

const [configFile] = process.argv.slice(2);
if (!configFile) throw new Error("usage: session-terminal-mirror <config.json>");
const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as MirrorConfig;

const status = (name: string, data: Record<string, unknown> = {}): void => {
	fs.writeFileSync(config.statusFile, JSON.stringify({ name, ...data }));
};

async function refreshRenderer(): Promise<void> {
	if (!config.endpoint || !config.sessionId || !config.generation) {
		throw new Error("refresh requires endpoint, sessionId and generation");
	}
	const conn = await IpcConnection.connect(config.endpoint, { framing: "lines", timeoutMs: 5_000 });
	try {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		conn.start(
			line => {
				let frame: { id?: string; type?: string; message?: string };
				try {
					frame = JSON.parse(line);
				} catch {
					return;
				}
				if (frame.id !== "mirror-refresh") return;
				if (frame.type === "terminal_refreshed") resolve();
				else reject(new Error(frame.message ?? "terminal refresh failed"));
			},
			reason => reject(new Error(`refresh connection closed: ${reason}`)),
		);
		conn.send(
			JSON.stringify({
				type: "terminal_refresh",
				id: "mirror-refresh",
				sessionId: config.sessionId,
				generation: config.generation,
			}),
		);
		await withTimeout(promise, 10_000, "terminal refresh timed out");
	} finally {
		conn.destroy();
	}
}

const client = await createDaemonBrokerClient(config.projectDir, { runtimeDir: config.runtimeDir });
status("connecting");
let result: TerminalMirrorResult;
try {
	result = await runTerminalMirror({
		client,
		name: config.name,
		id: config.id,
		subscriptionId: config.subscriptionId,
		size: () => ({ columns: config.columns ?? 120, rows: config.rows ?? 40 }),
		refresh: config.refresh ? refreshRenderer : undefined,
	});
} catch (error) {
	status("failed", { message: error instanceof Error ? error.message : String(error) });
	process.exit(1);
}
status("exited", { ...result });
process.exit(result.detached ? 0 : (result.exitCode ?? 0));
