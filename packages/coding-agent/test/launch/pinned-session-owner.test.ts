import { afterEach, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	consumeSessionOwnerContext,
	resetSessionOwnerContextForTest,
	SESSION_OWNER_CONTEXT_ENV,
	SESSION_OWNER_WAKE_TARGET_ENV,
	sessionOwnerSpec,
} from "@oh-my-pi/pi-coding-agent/launch/session-owner";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolvePinnedCliEntryCmd } from "@oh-my-pi/pi-coding-agent/launch/runtime-generation";
import * as workerClient from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { TempDir } from "@oh-my-pi/pi-utils";

const GEN_A = "a".repeat(40);
const GEN_B = "b".repeat(40);

function entry(root: string, generation: string): string {
	return path.join(root, "generations", generation, "cli.ts");
}

async function image(file: string, native = true, reported?: string): Promise<void> {
	await Bun.write(
		file,
		[
			`const generation = ${reported === undefined ? "import.meta.path.match(/generations\\/([a-f0-9]{40})\\//)?.[1]" : JSON.stringify(reported)};`,
			'if (process.argv.includes("--restart-receiver-probe")) {',
			`process.stdout.write(JSON.stringify({ type: "restart_receiver", protocol: 1, nonce: process.argv.at(-1), version: "fixture", generation, nativeSessionIdentity: ${native} }));`,
			"} else { process.stdout.write(JSON.stringify({ generation, args: process.argv.slice(2) })); }",
		].join("\n"),
	);
}

afterEach(() => vi.restoreAllMocks());

it("launches the pinned image even when current and the launching image select another generation", async () => {
	using temp = TempDir.createSync("@omp-pinned-owner-");
	await image(entry(temp.path(), GEN_A));
	await image(entry(temp.path(), GEN_B));
	await fs.symlink(path.join(temp.path(), "generations", GEN_A), path.join(temp.path(), "generations", "current"));
	spyOn(workerClient, "resolveCliEntryCmd").mockReturnValue([process.execPath, entry(temp.path(), GEN_A)]);
	const spec = await sessionOwnerSpec({
		name: "fixture",
		projectDir: temp.path(),
		argv: ["--resume", "exact-journal"],
		identity: {},
		generation: GEN_B,
	});
	const child = Bun.spawn([spec.application, ...spec.args], {
		cwd: temp.path(),
		stdout: "pipe",
		stderr: "pipe",
		timeout: 5000,
	});
	const [output, code] = await Promise.all([new Response(child.stdout).json(), child.exited]);
	expect(code).toBe(0);
	expect(output).toMatchObject({
		generation: GEN_B,
		args: ["__omp_worker_session_owner", "--resume", "exact-journal"],
	});
});

it.each(["legacy", "wrong-generation"] as const)("refuses a %s receiver before launching an owner", async state => {
	using temp = TempDir.createSync("@omp-pinned-owner-");
	await image(entry(temp.path(), GEN_A));
	await image(entry(temp.path(), GEN_B), state !== "legacy", state === "wrong-generation" ? GEN_A : undefined);
	spyOn(workerClient, "resolveCliEntryCmd").mockReturnValue([process.execPath, entry(temp.path(), GEN_A)]);
	await expect(
		sessionOwnerSpec({ name: "fixture", projectDir: temp.path(), argv: [], identity: {}, generation: GEN_B }),
	).rejects.toThrow("cannot attest native session identity ownership");
});

it("refuses a generation entry symlink escaping its pinned directory", async () => {
	using temp = TempDir.createSync("@omp-pinned-owner-");
	await image(entry(temp.path(), GEN_A));
	await fs.mkdir(path.dirname(entry(temp.path(), GEN_B)), { recursive: true });
	await fs.symlink(entry(temp.path(), GEN_A), entry(temp.path(), GEN_B));
	expect(() => resolvePinnedCliEntryCmd([process.execPath, entry(temp.path(), GEN_A)], GEN_B)).toThrow("escapes");
});

it("refuses a journal pinned after an unpinned wake was selected", async () => {
	using temp = TempDir.createSync("@omp-wake-pin-race-");
	const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
	await manager.setRootAgent("fixture");
	await manager.ensureOnDisk();
	const sessionFile = manager.getCanonicalSessionFile();
	if (!sessionFile) throw new Error("Missing fixture journal");
	const selected = { sessionId: manager.getSessionId(), sessionFile, profile: "fixture" };
	manager.appendSessionIdentityMetadata({ version: 1, generation: GEN_B });
	await manager.flush();
	await manager.close();
	const before = await Bun.file(sessionFile).text();
	consumeSessionOwnerContext({
		[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({ projectDir: temp.path(), name: "fixture", id: "owner" }),
		[SESSION_OWNER_WAKE_TARGET_ENV]: JSON.stringify(selected),
	});
	let reopened: SessionManager | undefined;
	try {
		await expect(
			createSessionManager(
				parseArgs(["--agent", "fixture", "--resume", sessionFile]),
				temp.path(),
				Settings.isolated(),
			).then(value => {
				reopened = value;
				return value;
			}),
		).rejects.toThrow("generation changed before wake");
		expect(await Bun.file(sessionFile).text()).toBe(before);
	} finally {
		await reopened?.close();
		resetSessionOwnerContextForTest();
	}
});
