/**
 * A named viewer verifies a session's transcript, then attaches. The pin is what keeps that
 * verification true: while a viewer holds it, no transition may replace, fork, branch into, or
 * switch to a different transcript, so input can never land in a conversation the viewer did not
 * verify. Same-transcript work (`reload`) stays allowed.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

const TEST_MODEL = getBundledModel("anthropic", "claude-sonnet-4-5")!;

interface Fixture {
	session: AgentSession;
	otherTranscript: string;
	cleanup: () => Promise<void>;
}

async function createFixture(temp: TempDir): Promise<Fixture> {
	const root = fs.realpathSync(temp.path());
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const sessionDir = path.join(root, "sessions");
	const manager = SessionManager.create(cwd, sessionDir, new FileSessionStorage());
	manager.appendMessage({ role: "user", content: "pinned transcript", timestamp: 1 });
	await manager.ensureOnDisk();
	await manager.flush();

	const other = SessionManager.create(cwd, sessionDir, new FileSessionStorage());
	other.appendMessage({ role: "user", content: "someone else's transcript", timestamp: 2 });
	await other.ensureOnDisk();
	await other.flush();
	const otherTranscript = other.getSessionFile();
	if (!otherTranscript) throw new Error("Expected a second persisted transcript");
	await other.close();

	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: TEST_MODEL, systemPrompt: ["test"], tools: [] },
		}),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: {} as never,
	});
	return {
		session,
		otherTranscript,
		cleanup: async () => {
			session.dispose();
			await manager.close();
		},
	};
}

describe("AgentSession transcript pin", () => {
	it("refuses to replace or switch away from a pinned transcript", async () => {
		using temp = TempDir.createSync("@omp-transcript-pin-");
		const { session, otherTranscript, cleanup } = await createFixture(temp);
		try {
			const sessionFile = session.sessionFile;
			const sessionId = session.sessionId;
			using _pin = await session.pinTranscript();

			for (const attempt of [
				() => session.newSession(),
				() => session.switchSession(otherTranscript),
				() => session.fork(),
			]) {
				const error = await rejectionOf(attempt());
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain("a named viewer pins this transcript");
			}

			expect(session.sessionFile).toBe(sessionFile);
			expect(session.sessionId).toBe(sessionId);
		} finally {
			await cleanup();
		}
	});

	it("still reloads the same transcript while pinned", async () => {
		using temp = TempDir.createSync("@omp-transcript-pin-reload-");
		const { session, cleanup } = await createFixture(temp);
		try {
			const sessionFile = session.sessionFile;
			using _pin = await session.pinTranscript();
			await session.reload();
			expect(session.sessionFile).toBe(sessionFile);
		} finally {
			await cleanup();
		}
	});

	it("allows a replacement once the last holder releases", async () => {
		using temp = TempDir.createSync("@omp-transcript-pin-release-");
		const { session, cleanup } = await createFixture(temp);
		try {
			const sessionFile = session.sessionFile;
			const first = await session.pinTranscript();
			const second = await session.pinTranscript();
			first[Symbol.dispose]();
			expect(await rejectionOf(session.newSession())).toBeInstanceOf(Error);
			second[Symbol.dispose]();

			expect(await session.newSession()).toBe(true);
			expect(session.sessionFile).not.toBe(sessionFile);
		} finally {
			await cleanup();
		}
	});
});
