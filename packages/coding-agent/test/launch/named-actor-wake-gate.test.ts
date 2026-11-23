import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { parseArgs } from "../../src/cli/args";
import * as profileOwner from "../../src/cli/flag-tables";
import { Settings } from "../../src/config/settings";
import {
	consumeSessionOwnerContext,
	resetSessionOwnerContextForTest,
	SESSION_OWNER_CONTEXT_ENV,
	SESSION_OWNER_WAKE_TARGET_ENV,
} from "../../src/launch/session-owner";
import { createSessionManager } from "../../src/main";
import { findSessionContinuation } from "../../src/session/session-listing";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

afterEach(() => {
	vi.restoreAllMocks();
	resetSessionOwnerContextForTest();
});

it.skipIf(typeof Reflect.get(profileOwner, "assertActorProfileBinding") !== "function")(
	"refuses unbound profiles, mismatched profiles, wrong sessions, and wrong directories without modifying the transcript",
	async () => {
		using temp = TempDir.createSync("@omp-wake-gate-");
		const cwd = temp.path();
		for (const scenario of ["unbound", "mismatch", "session", "cwd"] as const) {
			const session = SessionManager.create(cwd, path.join(cwd, "sessions"));
			if (scenario !== "unbound") {
				const bind: unknown = Reflect.get(session, "setRootAgent");
				if (typeof bind !== "function") throw new Error("profile owner missing");
				await bind.call(session, scenario === "mismatch" ? "other" : "expected");
			}
			await session.ensureOnDisk();
			const file = session.getSessionFile();
			if (!file) throw new Error("fixture session missing");
			const id = session.getSessionId();
			await session.close();
			const before = fs.readFileSync(file, "utf8");
			consumeSessionOwnerContext({
				[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({ projectDir: cwd, name: "fixture", id: "broker" }),
				[SESSION_OWNER_WAKE_TARGET_ENV]: JSON.stringify({
					sessionId: scenario === "session" ? `${id}-wrong` : id,
					sessionFile: file,
					profile: "expected",
				}),
			});
			const parsed = parseArgs(["--agent", "expected", "--resume", file]);
			const launchCwd = scenario === "cwd" ? path.dirname(cwd) : cwd;
			await expect(createSessionManager(parsed, launchCwd, Settings.isolated())).rejects.toThrow();
			expect(fs.readFileSync(file, "utf8")).toBe(before);
			resetSessionOwnerContextForTest();
		}
	},
);

it.skipIf(typeof Reflect.get(profileOwner, "assertActorProfileBinding") !== "function")(
	"wakes the selected transcript rather than following a newer continuation or creating a fork",
	async () => {
		using temp = TempDir.createSync("@omp-wake-continuation-");
		const cwd = temp.path();
		const source = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const bind: unknown = Reflect.get(source, "setRootAgent");
		if (typeof bind !== "function") throw new Error("profile owner missing");
		await bind.call(source, "expected");
		source.appendMessage({ role: "user", content: "before", timestamp: 1 });
		await source.ensureOnDisk();
		await source.flush();
		const file = source.getSessionFile();
		if (!file) throw new Error("fixture session missing");
		const id = source.getSessionId();
		await source.close();
		const records = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const header = records.find(record => record.type === "session");
		if (!header) throw new Error("fixture header missing");
		const continuedId = crypto.randomUUID();
		const movedAt = Date.now() + 1000;
		Object.assign(header, {
			id: continuedId,
			timestamp: new Date(movedAt).toISOString(),
			parentSession: id,
			continuationOf: id,
		});
		records.push({
			type: "message",
			id: "later",
			parentId: records.at(-1)?.id,
			timestamp: new Date(movedAt + 1000).toISOString(),
			message: { role: "user", content: "later", timestamp: movedAt + 1000 },
		});
		const sibling = path.join(
			path.dirname(file),
			`${new Date(movedAt).toISOString().replace(/[:.]/g, "-")}_${continuedId}.jsonl`,
		);
		fs.writeFileSync(sibling, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		expect((await findSessionContinuation(file))?.session.path).toBe(sibling);
		const before = fs.readdirSync(path.dirname(file)).sort();
		consumeSessionOwnerContext({
			[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({ projectDir: cwd, name: "fixture", id: "broker" }),
			[SESSION_OWNER_WAKE_TARGET_ENV]: JSON.stringify({ sessionId: id, sessionFile: file, profile: "expected" }),
		});
		const parsed = parseArgs(["--agent", "expected", "--resume", file]);
		const manager = await createSessionManager(parsed, cwd, Settings.isolated());
		if (!manager) throw new Error("exact wake refused");
		try {
			expect(manager.getSessionId()).toBe(id);
			expect(manager.getSessionFile()).toBe(file);
			expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(before);
		} finally {
			await manager.close();
		}
	},
);

it.skipIf(typeof Reflect.get(profileOwner, "assertActorProfileBinding") !== "function")(
	"refuses a profile replaced between the preliminary and fresh session reads",
	async () => {
		using temp = TempDir.createSync("@omp-wake-replaced-");
		const cwd = temp.path();
		const source = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const bind: unknown = Reflect.get(source, "setRootAgent");
		if (typeof bind !== "function") throw new Error("profile owner missing");
		await bind.call(source, "expected");
		await source.ensureOnDisk();
		const file = source.getSessionFile();
		if (!file) throw new Error("fixture session missing");
		const id = source.getSessionId();
		await source.close();
		const records = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const header = records.find(record => record.type === "session");
		if (!header) throw new Error("fixture header missing");
		header.rootAgent = "different";
		const replacement = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
		const stat = FileSessionStorage.prototype.statSync;
		let reads = 0;
		vi.spyOn(FileSessionStorage.prototype, "statSync").mockImplementation(
			function (this: FileSessionStorage, target) {
				if (target === file && ++reads === 2) fs.writeFileSync(file, replacement);
				return stat.call(this, target);
			},
		);
		consumeSessionOwnerContext({
			[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({ projectDir: cwd, name: "fixture", id: "broker" }),
			[SESSION_OWNER_WAKE_TARGET_ENV]: JSON.stringify({ sessionId: id, sessionFile: file, profile: "expected" }),
		});
		const parsed = parseArgs(["--agent", "expected", "--resume", file]);
		await expect(createSessionManager(parsed, cwd, Settings.isolated())).rejects.toThrow();
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(fs.readFileSync(file, "utf8")).toBe(replacement);
	},
);

it.each(["plain", "unexpected-profile"] as const)(
	"revives a plain session only while its saved profile remains plain: %s",
	async scenario => {
		using temp = TempDir.createSync("@omp-plain-wake-gate-");
		const cwd = temp.path();
		const source = SessionManager.create(cwd, path.join(cwd, "sessions"));
		if (scenario === "unexpected-profile") await source.setRootAgent("other");
		source.appendMessage({ role: "user", content: "keep this conversation", timestamp: 1 });
		await source.ensureOnDisk();
		await source.flush();
		const file = source.getCanonicalSessionFile();
		if (!file) throw new Error("fixture session missing");
		const id = source.getSessionId();
		await source.close();
		const before = await Bun.file(file).text();
		consumeSessionOwnerContext({
			[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({ projectDir: cwd, name: "fixture", id: "broker" }),
			[SESSION_OWNER_WAKE_TARGET_ENV]: JSON.stringify({ sessionId: id, sessionFile: file, profile: null }),
		});
		const pending = createSessionManager(parseArgs(["--resume", file]), cwd, Settings.isolated());
		if (scenario === "unexpected-profile") {
			await expect(pending).rejects.toThrow();
			expect(await Bun.file(file).text()).toBe(before);
			return;
		}
		const reopened = await pending;
		if (!reopened) throw new Error("plain wake refused");
		try {
			expect(reopened.getSessionId()).toBe(id);
			expect(reopened.getHeader()?.rootAgent).toBeUndefined();
			expect(reopened.getEntries().some(entry =>
				entry.type === "message" && entry.message.role === "user" &&
				entry.message.content === "keep this conversation",
			)).toBe(true);
		} finally {
			await reopened.close();
		}
	},
);
