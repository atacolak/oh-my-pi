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
		const homeLog = path.join(probeDir, "home.log");

		// Capture the argv and cwd Bun would have seen. `ompalt` delegates to the
		// canonical `scripts/omp` launcher, whose final exec resolves `bun` from PATH,
		// so a PATH-shadowing shell script observes the call without starting the CLI.
		fs.writeFileSync(
			fakeBun,
			`#!/bin/sh
printf '%s\\n' "$PWD" > ${JSON.stringify(cwdLog)}
printf '%s\\n' "$HOME" > ${JSON.stringify(homeLog)}
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
				OMPALT_HOME: path.join(probeDir, "alt-home"),
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
		expect(fs.readFileSync(homeLog, "utf8").trim()).toBe(path.join(probeDir, "alt-home"));
		// Launcher must not depend on the caller's cwd for resolving itself.
		expect(fs.existsSync(path.join(scriptsDir, "ompalt"))).toBe(true);
	});

	it("defaults HOME, XDG state, and the bunfig-free launch directory outside the caller home", async () => {
		const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ompalt-home-probe-"));
		const fakeBun = path.join(probeDir, "bun");
		const envLog = path.join(probeDir, "env.log");
		fs.writeFileSync(
			fakeBun,
			`#!/bin/sh
printf '%s\\n' "$PWD" "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" > ${JSON.stringify(envLog)}
`,
			{ mode: 0o755 },
		);

		const isolatedTmp = path.join(probeDir, "tmp");
		fs.mkdirSync(isolatedTmp);
		const env = { ...process.env };
		delete env.OMP_DEV_LAUNCH_DIR;
		delete env.OMPALT_HOME;
		delete env.OMPALT_XDG_CONFIG_HOME;
		delete env.OMPALT_XDG_DATA_HOME;
		delete env.OMPALT_XDG_STATE_HOME;
		delete env.OMPALT_XDG_CACHE_HOME;
		const proc = Bun.spawn(["sh", ompaltPath, "--version"], {
			env: {
				...env,
				PATH: `${probeDir}:${env.PATH ?? ""}`,
				HOME: probeDir,
				TMPDIR: isolatedTmp,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);

		const [launchCwd, altHome, xdgConfig, xdgData, xdgState, xdgCache] = fs
			.readFileSync(envLog, "utf8")
			.trim()
			.split("\n");
		const expectedHome = path.join(isolatedTmp, `ompalt-home-${process.getuid?.() ?? 0}`);
		expect(altHome).toBe(expectedHome);
		expect(launchCwd).toBe(path.join(expectedHome, ".dev-cwd"));
		expect(xdgConfig).toBe(path.join(expectedHome, ".config"));
		expect(xdgData).toBe(path.join(expectedHome, ".local/share"));
		expect(xdgState).toBe(path.join(expectedHome, ".local/state"));
		expect(xdgCache).toBe(path.join(expectedHome, ".cache"));
		expect(fs.existsSync(path.join(probeDir, ".omp"))).toBe(false);
	});
});
