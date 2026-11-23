import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSessionHexSuffix } from "@oh-my-pi/pi-coding-agent/launch/session-attach";
import { TempDir } from "@oh-my-pi/pi-utils";

it("resolves a unique suffix to the exact session publication", async () => {
	using temp = TempDir.createSync("@omp-attach-suffix-");
	const sessionId = "01900000-0000-7000-8000-123456788e18";
	const sessionFile = path.join(temp.path(), "session.jsonl");
	fs.writeFileSync(
		path.join(temp.path(), `${sessionId}.json`),
		JSON.stringify({ pid: process.pid, sessionId, sessionFile }),
	);
	expect(await resolveSessionHexSuffix("8E18", temp.path())).toEqual({ sessionId, sessionFile });
	expect(await resolveSessionHexSuffix("ffff", temp.path())).toBeUndefined();
});

it("refuses ambiguous or invalid suffix publications", async () => {
	using temp = TempDir.createSync("@omp-attach-suffix-");
	const id = "01900000-0000-7000-8000-123456788e18";
	const sidecar = path.join(temp.path(), `${id}.json`);
	fs.writeFileSync(sidecar, JSON.stringify({ pid: process.pid, sessionId: id, sessionFile: "/tmp/session.jsonl" }));
	fs.writeFileSync(path.join(temp.path(), "01900000-0000-7000-8000-aaaaaaaa8e18.json"), "{}");
	await expect(resolveSessionHexSuffix("8e18", temp.path())).rejects.toThrow("ambiguous");
	fs.rmSync(path.join(temp.path(), "01900000-0000-7000-8000-aaaaaaaa8e18.json"));
	fs.writeFileSync(
		sidecar,
		JSON.stringify({ pid: process.pid, sessionId: "wrong", sessionFile: "/tmp/session.jsonl" }),
	);
	await expect(resolveSessionHexSuffix("8e18", temp.path())).rejects.toThrow("valid session publication");
	await expect(resolveSessionHexSuffix("../8e18", temp.path())).rejects.toThrow("hexadecimal");
});
