// Integration test — real child processes and a real broker are required
// (ts-no-test-timers exception): the CLI attaches to a live owner over the
// broker's PTY stream, and the assertion counts real session files. Awaited
// signals are child exits and socket frames, never fixed delays.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { readSessionInfo } from "../../src/session/session-listing";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const CLI_ENTRY = path.join(import.meta.dir, "../../src/cli.ts");
const LAUNCHER = path.join(import.meta.dir, "../fixtures/session-attach-cli-broker.ts");
const CLI_TIMEOUT_MS = 45_000;

interface OwnerReport {
	readonly name: string;
	readonly id: string;
	readonly pid: number;
}

interface RefreshEndpoint {
	readonly frames: Array<Record<string, unknown>>;
	close(): Promise<void>;
}

function sessionDirNames(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.sort();
}

async function createSession(sessionsDir: string, cwd: string): Promise<{ sessionId: string; sessionPath: string }> {
	const manager = SessionManager.create(cwd, sessionsDir, new FileSessionStorage());
	await manager.ensureOnDisk();
	manager.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
	await manager.flush();
	const sessionPath = manager.getSessionFile();
	if (!sessionPath) throw new Error("expected a session file");
	await manager.close();
	const session = await readSessionInfo(sessionPath);
	if (!session) throw new Error("expected a readable session header");
	return { sessionId: session.id, sessionPath };
}

async function waitForJson<T>(file: string, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8")) as T;
		} catch {}
		await Bun.sleep(20);
	}
	throw new Error(`timed out waiting for ${file}`);
}

function cliEnvironment(homeDir: string, agentDir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key === "HOME" || key === "USERPROFILE" || key === "PI_CODING_AGENT_DIR") continue;
		if (key === "OMP_SESSION_OWNER_CONTEXT") continue;
		if (key.startsWith("XDG_")) continue;
		env[key] = value;
	}
	env.HOME = homeDir;
	env.USERPROFILE = homeDir;
	env.PI_CODING_AGENT_DIR = agentDir;
	return env;
}

interface CliResult {
	readonly exitCode: number;
	readonly output: string;
}

async function runCli(homeDir: string, agentDir: string, projectDir: string, args: string[]): Promise<CliResult> {
	const chunks: Uint8Array[] = [];
	await using terminal = new Bun.Terminal({
		cols: 120,
		rows: 40,
		data(_terminal, data) {
			chunks.push(data);
		},
	});
	const child = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
		cwd: projectDir,
		env: cliEnvironment(homeDir, agentDir),
		terminal,
	});
	try {
		const exitCode = await withTimeout(child.exited, CLI_TIMEOUT_MS, `omp ${args.join(" ")} did not exit`);
		return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
	} catch (error) {
		child.kill("SIGKILL");
		const output = Buffer.concat(chunks).toString("utf8");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\n--- output ---\n${output.slice(-4000)}`,
		);
	}
}

function serveSessionEndpoint(
	endpoint: string,
	sessionId: string,
	generation: string,
	onRefresh: () => void,
): Promise<RefreshEndpoint> {
	const frames: Array<Record<string, unknown>> = [];
	const connections = new Set<IpcConnection>();
	const listening = IpcServer.listen(endpoint, { framing: "lines" }, connection => {
		connections.add(connection);
		connection.start(
			line => {
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}
				frames.push(frame);
				if (frame.type === "get_state") {
					connection.send(
						JSON.stringify({
							type: "response",
							id: frame.id,
							command: "get_state",
							success: true,
							data: { sessionId, isStreaming: false },
						}),
					);
					return;
				}
				if (frame.type === "terminal_refresh") {
					if (frame.sessionId !== sessionId || frame.generation !== generation) {
						connection.send(
							JSON.stringify({ type: "terminal_refresh_error", id: frame.id, message: "not this attachment" }),
						);
						return;
					}
					connection.send(JSON.stringify({ type: "terminal_refreshed", id: frame.id, sessionId, generation }));
					onRefresh();
				}
			},
			() => {
				connections.delete(connection);
			},
		);
		connection.send(JSON.stringify({ type: "ready", protocolVersion: 1 }));
	});
	return listening.then(server => ({
		frames,
		async close() {
			for (const connection of connections) connection.destroy();
			await server.close();
		},
	}));
}

describe("CLI --resume against a live owner", () => {
	it("attaches and never creates a sibling transcript, then refuses a stale publication", async () => {
		using tempDir = TempDir.createSync("@omp-cli-attach-");
		const homeDir = path.join(tempDir.path(), "home");
		const agentDir = path.join(homeDir, "agent");
		const projectDir = path.join(tempDir.path(), "project");
		const sessionsDir = path.join(tempDir.path(), "sessions");
		const runDir = path.join(homeDir, ".omp", "run");
		for (const dir of [agentDir, projectDir, sessionsDir, runDir]) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		const project = fs.realpathSync(projectDir);

		const { sessionId, sessionPath } = await createSession(sessionsDir, project);
		const before = sessionDirNames(sessionsDir);
		expect(before).toEqual([path.basename(sessionPath)]);

		const reportFile = path.join(tempDir.path(), "owner.json");
		const stopFile = path.join(tempDir.path(), "stop");
		const launcher = Bun.spawn([process.execPath, LAUNCHER, project, reportFile, stopFile], {
			cwd: project,
			env: cliEnvironment(homeDir, agentDir),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		let endpoint: RefreshEndpoint | undefined;
		let owner: OwnerReport | undefined;
		try {
			owner = await waitForJson<OwnerReport>(reportFile, 60_000);
			const endpointPath = ipcEndpoint(runDir, sessionId);
			endpoint = await serveSessionEndpoint(endpointPath, sessionId, owner.id, () => {
				setTimeout(() => {
					try {
						process.kill(owner!.pid, "SIGTERM");
					} catch {}
				}, 100);
			});
			fs.writeFileSync(
				path.join(runDir, `${sessionId}.json`),
				JSON.stringify({
					pid: process.pid,
					sessionId,
					sessionFile: sessionPath,
					terminal: { protocolVersion: 1, projectDir: project, name: owner.name, id: owner.id },
				}),
				{ mode: 0o600 },
			);

			const live = await runCli(homeDir, agentDir, project, ["--resume", sessionId, "--session-dir", sessionsDir]);

			expect(live.exitCode, live.output).toBe(42);
			expect(live.output).toContain("OWNER-BANNER");
			expect(endpoint.frames.some(frame => frame.type === "terminal_refresh")).toBe(true);
			expect(sessionDirNames(sessionsDir)).toEqual(before);

			const stale = await createSession(sessionsDir, project);
			const staleId = stale.sessionId;
			fs.writeFileSync(
				path.join(runDir, `${staleId}.json`),
				JSON.stringify({
					pid: process.pid,
					sessionId: staleId,
					sessionFile: null,
					terminal: { protocolVersion: 1, projectDir: project, name: "mind-stale", id: "generation-stale" },
				}),
				{ mode: 0o600 },
			);

			const refusal = await runCli(homeDir, agentDir, project, ["--resume", staleId, "--session-dir", sessionsDir]);

			expect(refusal.exitCode).not.toBe(0);
			expect(refusal.output).toContain("refusing to open a second transcript");
			expect(sessionDirNames(sessionsDir)).toEqual([...before, path.basename(stale.sessionPath)]);
		} finally {
			if (owner) {
				try {
					process.kill(owner.pid, "SIGTERM");
				} catch {}
			}
			fs.writeFileSync(stopFile, "");
			await withTimeout(launcher.exited, 20_000, "broker launcher did not stop").catch(() =>
				launcher.kill("SIGKILL"),
			);
			await endpoint?.close();
		}
	}, 180_000);
});
