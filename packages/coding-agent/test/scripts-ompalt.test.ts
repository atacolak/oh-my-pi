import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
const ompaltPath = path.join(scriptsDir, "ompalt");

describe("scripts/ompalt launcher", () => {
	it("injects --alt and preserves the normal OMP environment from any cwd", async () => {
		const stat = fs.statSync(ompaltPath);
		expect(stat.mode & 0o111).not.toBe(0);

		const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ompalt-probe-"));
		const fakeBun = path.join(probeDir, "bun");
		const argvLog = path.join(probeDir, "argv.log");
		const cwdLog = path.join(probeDir, "cwd.log");
		const envLog = path.join(probeDir, "env.log");

		// `ompalt` delegates to the canonical launcher, whose final exec resolves
		// `bun` from PATH. Shadow it so the test observes argv/cwd/environment
		// without starting the interactive CLI.
		fs.writeFileSync(
			fakeBun,
			`#!/bin/sh
printf '%s\n' "$PWD" > ${JSON.stringify(cwdLog)}
printf '%s\n' "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$PI_CODING_AGENT_DIR" "$PI_CODING_AGENT_SESSION_DIR" "$PI_CONFIG_DIR" "$OMP_PROFILE" "$PI_PROFILE" > ${JSON.stringify(envLog)}
printf '%s\\0' "$@" > ${JSON.stringify(argvLog)}
`,
			{ mode: 0o755 },
		);

		const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ompalt-cwd-"));
		const launchDir = path.join(probeDir, "launch");
		const expectedEnv = {
			HOME: path.join(probeDir, "home"),
			XDG_CONFIG_HOME: path.join(probeDir, "config"),
			XDG_DATA_HOME: path.join(probeDir, "data"),
			XDG_STATE_HOME: path.join(probeDir, "state"),
			XDG_CACHE_HOME: path.join(probeDir, "cache"),
			PI_CODING_AGENT_DIR: path.join(probeDir, "agent"),
			PI_CODING_AGENT_SESSION_DIR: path.join(probeDir, "sessions"),
			PI_CONFIG_DIR: path.join(probeDir, "pi-config"),
			OMP_PROFILE: "work",
			PI_PROFILE: "legacy",
		};
		const proc = Bun.spawn(["sh", ompaltPath, "--model", "opus", "hello world", "--print"], {
			cwd: foreignCwd,
			env: {
				...process.env,
				...expectedEnv,
				PATH: `${probeDir}:${process.env.PATH ?? ""}`,
				OMP_DEV_LAUNCH_DIR: launchDir,
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

		const argv = fs
			.readFileSync(argvLog)
			.toString("utf8")
			.split("\0")
			.filter(part => part.length > 0);
		const altIndex = argv.indexOf("--alt");
		expect(altIndex).toBeGreaterThan(-1);
		expect(argv.slice(altIndex)).toEqual(["--alt", "--model", "opus", "hello world", "--print"]);
		expect(fs.readFileSync(cwdLog, "utf8").trim()).toBe(launchDir);
		expect(fs.readFileSync(envLog, "utf8").trim().split("\n")).toEqual(Object.values(expectedEnv));
	});
});
