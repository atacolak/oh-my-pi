import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";
import type { NativeSessionList } from "../src/session/session-service";

const CLI = process.env.OMP_TEST_CLI_BINARY
	? [process.env.OMP_TEST_CLI_BINARY]
	: [process.execPath, path.join(import.meta.dir, "../src/cli.ts")];

async function run(home: string, agentDir: string, cwd: string, args: string[]) {
	const child = Bun.spawn([...CLI, "sock", ...args], {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: agentDir,
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = new Response(child.stdout).text();
	const errors = new Response(child.stderr).text();
	try {
		const exitCode = await withTimeout(child.exited, 30_000, "sock fixture did not exit");
		return { exitCode, stdout: await output, stderr: await errors };
	} finally {
		if (child.exitCode === null) child.kill();
	}
}

describe("omp sock discovery CLI", () => {
	it("shows all durable names and only eight recent unnamed sessions unless --all is explicit", async () => {
		using temp = TempDir.createSync("@omp-sock-list-");
		const home = path.join(temp.path(), "home");
		const agentDir = path.join(home, "agent");
		const cwd = path.join(temp.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), "marketplace:\n  autoUpdate: off\n");
		const sessionsRoot = getSessionsDir(agentDir);
		const unnamed: string[] = [];
		const names = new Map<string, string>();
		for (let index = 0; index < 14; index++) {
			const manager = SessionManager.create(cwd, sessionsRoot, new FileSessionStorage());
			await manager.ensureOnDisk();
			if (index < 2) {
				const handle = index === 0 ? "zeta" : "alpha";
				manager.appendSessionIdentityMetadata({ version: 1, actorHandle: handle });
				names.set(handle, manager.getSessionId());
			} else unnamed.push(manager.getSessionId());
			await manager.flush();
			const file = manager.getCanonicalSessionFile();
			if (!file) throw new Error("fixture journal was not materialized");
			await manager.close();
			await fs.utimes(file, 1_700_000_000 + index, 1_700_000_000 + index);
		}
		const limited = await run(home, agentDir, cwd, ["list", "--json"]);
		expect(limited.exitCode, limited.stderr).toBe(0);
		const listing: NativeSessionList = JSON.parse(limited.stdout);
		expect(listing.sessions.filter(row => row.handle !== null).map(row => row.handle)).toEqual(["alpha", "zeta"]);
		expect(listing.sessions.filter(row => row.handle === null).map(row => row.sessionId)).toEqual(
			unnamed.slice(-8).reverse(),
		);
		expect(listing.total).toBe(14);
		expect(listing.omittedUnnamed).toBe(4);
		expect(listing.attachableSockets).toBe(0);
		const all = await run(home, agentDir, cwd, ["list", "--all", "--json"]);
		expect(all.exitCode, all.stderr).toBe(0);
		const expanded: NativeSessionList = JSON.parse(all.stdout);
		expect(expanded.sessions.map(row => row.sessionId).sort()).toEqual([...names.values(), ...unnamed].sort());
		const human = await run(home, agentDir, cwd, ["list"]);
		expect(human.exitCode, human.stderr).toBe(0);
		expect(human.stdout).toContain("0 attachable sockets");
		expect(human.stdout).toContain("4 older unnamed sessions hidden");
	}, 60_000);

	it("reports a missing native name without leaking a stack trace or starting an owner", async () => {
		using temp = TempDir.createSync("@omp-sock-missing-");
		const home = path.join(temp.path(), "home");
		const agentDir = path.join(home, "agent");
		const cwd = path.join(temp.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), "marketplace:\n  autoUpdate: off\n");
		const result = await run(home, agentDir, cwd, ["attach", "omp_lead"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('No session identity matches "omp_lead"');
		expect(result.stderr).not.toContain("SessionIdentityNotFoundError");
		expect(result.stderr).not.toMatch(/\bat (?:async |resolveSessionIdentityReference)/);
		expect(await fs.readdir(getSessionsDir(agentDir))).toEqual([]);
	});
});
