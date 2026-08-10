import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
const ompaltPath = path.join(scriptsDir, "ompalt");

describe("scripts/ompalt launcher", () => {
	it("is executable and injects --alt before forwarded args from any cwd", async () => {
		const stat = fs.statSync(ompaltPath);
		expect(stat.mode & 0o111).not.toBe(0);

		const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ompalt-probe-"));
		const fakeBun = path.join(probeDir, "bun");
		const argvLog = path.join(probeDir, "argv.log");
		const cwdLog = path.join(probeDir, "cwd.log");

		// Capture the argv and cwd Bun would have seen. The launcher `exec`s bun,
		// so a PATH-shadowing shell script is enough to observe the call without
		// starting the real CLI.
		fs.writeFileSync(
			fakeBun,
			`#!/bin/sh
printf '%s\\n' "$PWD" > ${JSON.stringify(cwdLog)}
printf '%s\\0' "$@" > ${JSON.stringify(argvLog)}
`,
			{ mode: 0o755 },
		);

		const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ompalt-cwd-"));
		const proc = Bun.spawn(["sh", ompaltPath, "--model", "opus", "hello world", "--print"], {
			cwd: foreignCwd,
			env: {
				...process.env,
				PATH: `${probeDir}:${process.env.PATH ?? ""}`,
				HOME: probeDir,
				OMP_DEV_LAUNCH_DIR: path.join(probeDir, "launch"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, `stdout=${stdout} stderr=${stderr}`).toBe(0);

		const argvRaw = fs.readFileSync(argvLog);
		const argv = argvRaw
			.toString("utf8")
			.split("\0")
			.filter(part => part.length > 0);
		// Preload + entrypoint, then --alt, then the forwarded user args.
		const altIndex = argv.indexOf("--alt");
		expect(altIndex).toBeGreaterThan(-1);
		expect(argv.slice(altIndex)).toEqual(["--alt", "--model", "opus", "hello world", "--print"]);

		const launchCwd = fs.readFileSync(cwdLog, "utf8").trim();
		expect(launchCwd).toBe(path.join(probeDir, "launch"));
		// Launcher must not depend on the caller's cwd for resolving itself.
		expect(fs.existsSync(path.join(scriptsDir, "ompalt"))).toBe(true);
	});
});
