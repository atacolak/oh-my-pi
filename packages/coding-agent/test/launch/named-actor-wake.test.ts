// Integration test: a real broker and PTY owner prove session and identity fencing.
import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsDir, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { loadSessionFile } from "../../src/session/session-loader";
import { SessionManager } from "../../src/session/session-manager";

const CLI_ENTRY = path.join(import.meta.dir, "../../src/cli.ts");
const CLI_COMMAND = process.env.OMP_TEST_CLI_BINARY ? [process.env.OMP_TEST_CLI_BINARY] : [process.execPath, CLI_ENTRY];

it.skipIf(process.platform !== "linux").each(["wake-probe", null])(
	"concurrent viewers wake one exact sleeping session with saved profile %s and no inherited caller identity",
	async profile => {
		using temp = TempDir.createSync("@omp-named-wake-");
		const home = path.join(temp.path(), "home");
		const agentDir = path.join(home, "agent");
		const cwd = path.join(temp.path(), "project");
		const profileCwd = path.join(temp.path(), "definitions");
		const sessionsDir = getSessionsDir(agentDir);
		const runDir = path.join(home, ".omp", "run");
		for (const dir of [agentDir, cwd, sessionsDir, runDir, path.join(profileCwd, ".omp", "agents")]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			"modelRoles:\n  default: anthropic/claude-sonnet-4-5\nmarketplace:\n  autoUpdate: off\n",
		);
		fs.writeFileSync(
			path.join(profileCwd, ".omp", "agents", "wake-probe.md"),
			"---\nname: wake-probe\ndescription: wake fixture\n---\nyou are the wake fixture.\n",
		);
		const session = SessionManager.create(cwd, sessionsDir);
		if (profile !== null) await session.setRootAgent(profile, profileCwd);
		await session.ensureOnDisk();
		session.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
		session.appendSessionIdentityMetadata({ version: 1, actorHandle: "worker.native" });
		await session.flush();
		const sessionId = session.getSessionId();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected fixture session");
		await session.close();
		const env: Record<string, string> = {
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: agentDir,
			TERM: "xterm-256color",
			ACTOR_NAME: "caller",
			HCOM_PROCESS_ID: "fixture-caller",
			ANTHROPIC_API_KEY: "fixture-not-a-real-key",
		};
		if (process.env.PATH) env.PATH = process.env.PATH;
		// A crashed/exited owner may leave a valid publication behind. Both
		// viewers must revive the saved conversation, not refuse that dead PID.
		const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
		await exited.exited;
		fs.writeFileSync(
			path.join(runDir, `${sessionId}.json`),
			JSON.stringify({ pid: exited.pid, sessionId, sessionFile }),
		);
		const chunks: Uint8Array[] = [];
		const secondChunks: Uint8Array[] = [];
		const painted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		await using terminal = new Bun.Terminal({
			cols: 100,
			rows: 30,
			data(_term, data) {
				chunks.push(data);
				if (Bun.stripANSI(Buffer.concat(chunks).toString("utf8")).includes("earlier")) painted[0]!.resolve();
			},
		});
		await using secondTerminal = new Bun.Terminal({
			cols: 100,
			rows: 30,
			data(_term, data) {
				secondChunks.push(data);
				if (Bun.stripANSI(Buffer.concat(secondChunks).toString("utf8")).includes("earlier")) painted[1]!.resolve();
			},
		});
		const viewer = Bun.spawn([...CLI_COMMAND, "--attach", "worker.native"], { cwd, env, terminal });
		const secondViewer = Bun.spawn([...CLI_COMMAND, "sock", "attach", sessionId], {
			cwd,
			env,
			terminal: secondTerminal,
		});
		const runtimeDir = path.join(
			home,
			".omp",
			"run",
			"daemons",
			Bun.hash.wyhash(path.resolve(cwd)).toString(16).padStart(16, "0"),
		);
		let owner:
			| {
					pid: number;
					terminal: { name: string; id: string };
					sessionDiagnostics?: { execution?: { profile?: string | null; profileBinding?: string | null } };
			  }
			| undefined;
		try {
			await withTimeout(
				Promise.race([
					Promise.all(painted.map(paint => paint.promise)),
					Promise.race([viewer.exited, secondViewer.exited]).then(code => {
						throw new Error(
							`viewer exited before painting (${code}): ${Buffer.concat([...chunks, ...secondChunks]).toString("utf8")}`,
						);
					}),
				]),
				30_000,
				"both viewers must display the saved conversation",
			);
			owner = JSON.parse(fs.readFileSync(path.join(runDir, `${sessionId}.json`), "utf8"));
			if (!owner?.terminal?.id) throw new Error("Woken owner did not publish terminal identity");
			expect(owner?.terminal?.id).toBeDefined();
			const loaded = await loadSessionFile(sessionFile);
			const header = loaded?.entries.find(entry => entry.type === "session");
			expect(header && Reflect.get(header, "id")).toBe(sessionId);
			expect(header && Reflect.get(header, "rootAgent")).toBe(profile ?? undefined);
			expect(header && Reflect.get(header, "rootAgentCwd")).toBe(profile === null ? undefined : profileCwd);
			expect(owner.sessionDiagnostics?.execution?.profile ?? null).toBe(profile);
			expect(owner.sessionDiagnostics?.execution?.profileBinding ?? null).toBe(profile);
			expect(
				loaded?.entries.some(
					entry =>
						entry.type === "message" && entry.message.role === "user" && entry.message.content === "earlier",
				),
			).toBe(true);
			const environ = fs.readFileSync(`/proc/${owner.pid}/environ`, "utf8").split("\0");
			expect(environ.includes("ACTOR_NAME=worker.native")).toBe(true);
			expect(environ.some(value => value.startsWith("HCOM_PROCESS_ID="))).toBe(false);
			const broker = await createDaemonBrokerClient(cwd, { runtimeDir, existingOnly: true });
			try {
				const listed = await broker.request({ op: "list" });
				if (listed.op !== "list") throw new Error("Expected broker list");
				expect(listed.daemons.filter(daemon => daemon.pid !== undefined)).toHaveLength(1);
				expect(listed.daemons.find(daemon => daemon.pid === owner?.pid)?.id).toBe(owner?.terminal.id);
			} finally {
				broker.close();
			}
		} finally {
			try {
				if (owner?.terminal?.id) {
					const broker = await createDaemonBrokerClient(cwd, { runtimeDir, existingOnly: true });
					try {
						await broker.request({
							op: "stop",
							name: owner.terminal.name,
							id: owner.terminal.id,
							timeoutMs: 2000,
						});
						await broker.request({ op: "shutdown" });
					} finally {
						broker.close();
					}
					await withTimeout(
						Promise.all([viewer.exited, secondViewer.exited]),
						10_000,
						"fixture viewers did not exit after owner stopped",
					);
				}
			} finally {
				if (viewer.exitCode === null) viewer.kill("SIGTERM");
				if (secondViewer.exitCode === null) secondViewer.kill("SIGTERM");
			}
		}
	},
	60_000,
);
