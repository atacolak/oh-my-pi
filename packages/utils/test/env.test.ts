import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$envExact,
	$otelEnv,
	claimOmpOtelEnvFileEntry,
	filterChildShellEnv,
	filterProcessEnv,
	getDbBusyTimeoutMs,
	parseEnvFile,
	setInteractiveHost,
	stripGitRepoLocationEnv,
	withOmpOtelEnv,
} from "@oh-my-pi/pi-utils/env";

const tempDirs: string[] = [];

// Every variable `dirs.ts` consults to pick the profile, agent dir or config/state roots. A probe child
// must not inherit any of them from the developer's shell (e.g. OMP_PROFILE beats PI_PROFILE, and a
// named profile ignores PI_CODING_AGENT_DIR), or it would read a different agent dir than its fixture.
const DIR_RESOLUTION_ENV_RESET = {
	OMP_PROFILE: undefined,
	PI_PROFILE: undefined,
	PI_CONFIG_DIR: undefined,
	XDG_DATA_HOME: undefined,
	XDG_STATE_HOME: undefined,
	XDG_CACHE_HOME: undefined,
};

const runtimeProbePath = path.join(import.meta.dir, "fixtures", "test-runtime-probe.ts");

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function writeTempEnv(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-"));
	tempDirs.push(dir);
	const filePath = path.join(dir, ".env");
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("getDbBusyTimeoutMs", () => {
	it("defaults to the bounded headless timeout", () => {
		const previous = setInteractiveHost(false);
		try {
			expect(getDbBusyTimeoutMs()).toBe(1000);
		} finally {
			setInteractiveHost(previous);
		}
	});

	it("keeps the interactive timeout for interactive hosts", () => {
		const previous = setInteractiveHost(true);
		try {
			expect(getDbBusyTimeoutMs()).toBe(5000);
		} finally {
			setInteractiveHost(previous);
		}
	});
});
async function runRuntimeProbe(
	env: Record<string, string | undefined>,
	probePath = runtimeProbePath,
): Promise<boolean> {
	const cwd = path.dirname(writeTempEnv(""));
	const proc = Bun.spawn([process.execPath, probePath], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as boolean;
}

describe("parseEnvFile", () => {
	it("ignores malformed names and nul-containing values", () => {
		const filePath = writeTempEnv(
			[
				"GOOD=value",
				"_ALSO_GOOD='quoted value'",
				"1BAD=value",
				"BAD-NAME=value",
				"BAD NAME=value",
				"BAD_VALUE=before\0after",
				"# comment",
				"NO_EQUALS",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			GOOD: "value",
			_ALSO_GOOD: "quoted value",
		});
	});

	it("mirrors valid OMP_ variables to PI_ variables", () => {
		const filePath = writeTempEnv("OMP_FEATURE=enabled\nOMP_BAD=before\0after\n");

		expect(parseEnvFile(filePath)).toEqual({
			OMP_FEATURE: "enabled",
			PI_FEATURE: "enabled",
		});
	});

	it("matches Bun dotenv syntax for export prefixes and inline comments", () => {
		const filePath = writeTempEnv(
			[
				"export EXPORTED=value",
				"COMMENTED=secret # trailing comment",
				'QUOTED_HASH="keep # this"',
				"NO_SPACE=http://host/path#frag",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			EXPORTED: "value",
			COMMENTED: "secret",
			QUOTED_HASH: "keep # this",
			NO_SPACE: "http://host/path",
		});
	});

	it("keeps escaped quotes inside quoted values literal, matching Bun", () => {
		const filePath = writeTempEnv(['JSON="{\\"a\\":1}"', "SINGLE='it\\'s'"].join("\n"));

		expect(parseEnvFile(filePath)).toEqual({
			JSON: '{\\"a\\":1}',
			SINGLE: "it\\'s",
		});
	});

	it("decodes bun double-quoted \\n and \\r while leaving other escapes literal", () => {
		const filePath = writeTempEnv(
			[
				'DQ_NL="./attacker\\n-dir"',
				'DQ_CR="a\\rb"',
				'DQ_TAB="a\\tb"',
				'DQ_BSN="a\\\\n-b"',
				"SQ_NL='attacker\\n-dir'",
				"UNQUOTED_NL=attacker\\n-dir",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			DQ_NL: "./attacker\n-dir",
			DQ_CR: "a\rb",
			DQ_TAB: "a\\tb",
			DQ_BSN: "a\\\\n-b",
			SQ_NL: "attacker\\n-dir",
			UNQUOTED_NL: "attacker\\n-dir",
		});
	});

	it("keeps bun quoted values that span literal newlines", () => {
		const filePath = writeTempEnv(
			['DQ="./attacker', '-dir"', "SQ='./attacker", "-dir'", "BT=`./attacker", "-dir`", "NEXT=yes"].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			DQ: "./attacker\n-dir",
			SQ: "./attacker\n-dir",
			BT: "./attacker\n-dir",
			NEXT: "yes",
		});
	});

	it("preserves trailing whitespace on the first bun quoted multiline line", () => {
		const filePath = writeTempEnv(['DQ="./attacker ', '-dir"', "SQ='./attacker ", "-dir'"].join("\n"));

		expect(parseEnvFile(filePath)).toEqual({
			DQ: "./attacker \n-dir",
			SQ: "./attacker \n-dir",
		});
	});

	it("parses leftover-after-close quotes as unquoted, matching bun", () => {
		const filePath = writeTempEnv(['UNCLOSED="./attacker', '-dir" leftover', "NEXT=yes"].join("\n"));

		expect(parseEnvFile(filePath)).toEqual({
			UNCLOSED: '"./attacker',
			NEXT: "yes",
		});
	});

	it("closes bun quoted values after an even-length backslash run", () => {
		const filePath = writeTempEnv(
			['EVEN="./attacker\\\\"', 'WIN=".\\attacker\\\\"', 'ODD="./attacker\\""', "NEXT=yes"].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			EVEN: "./attacker\\\\",
			WIN: ".\\attacker\\\\",
			ODD: './attacker\\"',
			NEXT: "yes",
		});
	});

	it("parses quoted multiline and escaped-newline values across the whole file", () => {
		const filePath = writeTempEnv(
			['MULTILINE="first', 'second"', 'ESCAPED_NEWLINE="first\\nsecond"', "BACKTICK=`first", "second`"].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			MULTILINE: "first\nsecond",
			ESCAPED_NEWLINE: "first\nsecond",
			BACKTICK: "first\nsecond",
		});
	});
});

describe("filterProcessEnv", () => {
	it("drops entries that cannot be passed to process spawn env", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				EMPTY: "",
				"BAD=NAME": "value",
				BAD_VALUE: "before\0after",
				MISSING: undefined,
			}),
		).toEqual({
			GOOD: "value",
			EMPTY: "",
		});
	});

	it("drops macOS malloc stack logging toggles instead of forwarding disabled values", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				MallocStackLogging: "0",
				MallocStackLoggingNoCompact: "0",
			}),
		).toEqual({
			GOOD: "value",
		});
	});

	it("preserves Windows-style variable names containing parentheses", () => {
		// `ProgramFiles(x86)` and friends are standard on Windows and must
		// survive the scrub so Git Bash discovery in procmgr.ts can resolve
		// 32-bit Program Files installations.
		expect(
			filterProcessEnv({
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
			}),
		).toEqual({
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
		});
	});
});

describe("filterChildShellEnv", () => {
	it("removes quoted multiline project values without a launch snapshot", () => {
		const cwd = path.dirname(
			writeTempEnv(['MULTILINE="first', 'second"', 'ESCAPED_NEWLINE="first\\nsecond"'].join("\n")),
		);

		expect(
			filterChildShellEnv(
				{
					MULTILINE: "first\nsecond",
					ESCAPED_NEWLINE: "first\nsecond",
					UNCHANGED: "parent-value",
				},
				cwd,
			),
		).toEqual({ UNCHANGED: "parent-value" });
	});

	it("uses the supplied mode for an isolated environment and cwd", async () => {
		const cwd = path.dirname(writeTempEnv(""));
		fs.writeFileSync(
			path.join(cwd, ".env.development.local"),
			"OMP_DOTENV_REPRO_MARKER=synthetic-mode-local-value\n",
		);
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv(",
			'  { OMP_DOTENV_REPRO_MARKER: "synthetic-mode-local-value", UNCHANGED: "parent-value" },',
			`  ${JSON.stringify(cwd)},`,
			");",
			"process.stdout.write(JSON.stringify(child));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			env: { ...process.env, NODE_ENV: "test", OMP_DOTENV_REPRO_MARKER: undefined },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ UNCHANGED: "parent-value" });
	});

	it("drops launch-cwd values expanded from bun ${" + "VAR:-fallback} syntax", async () => {
		const cwd = path.dirname(writeTempEnv("PI_CODING_AGENT_DIR=${" + "UNSET:-./attacker-dir}\n"));
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv(",
			'  { PI_CODING_AGENT_DIR: "./attacker-dir", UNCHANGED: "parent-value" },',
			`  ${JSON.stringify(cwd)},`,
			");",
			"process.stdout.write(JSON.stringify(child));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			env: { ...process.env, NODE_ENV: "test", PI_CODING_AGENT_DIR: undefined },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ UNCHANGED: "parent-value" });
	});

	it("drops inherited git repo-location overrides", () => {
		const cwd = path.dirname(writeTempEnv(""));
		// A bash call with `cwd` in a secondary worktree must not mutate the
		// primary one: forwarding the agent's own repo-location variables makes
		// child `git` ignore the command's cwd (issue #11082).
		expect(
			filterChildShellEnv(
				{
					GIT_DIR: "/primary/.git",
					GIT_COMMON_DIR: "/primary/.git",
					GIT_WORK_TREE: "/primary",
					GIT_INDEX_FILE: "/primary/.git/index",
					GIT_OBJECT_DIRECTORY: "/primary/.git/objects",
					GIT_ALTERNATE_OBJECT_DIRECTORIES: "/primary/.git/objects",
					GIT_EDITOR: "true",
					GIT_AUTHOR_NAME: "Agent",
				},
				cwd,
			),
		).toEqual({ GIT_EDITOR: "true", GIT_AUTHOR_NAME: "Agent" });
	});

	it("uses the launch mode when dotenv changes NODE_ENV", async () => {
		const cwd = path.dirname(writeTempEnv("NODE_ENV=production\n"));
		fs.writeFileSync(
			path.join(cwd, ".env.development.local"),
			"OMP_DOTENV_REPRO_MARKER=synthetic-mode-local-value\n",
		);
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv(process.env, process.cwd());",
			"process.stdout.write(JSON.stringify({",
			"  processValue: process.env.OMP_DOTENV_REPRO_MARKER ?? null,",
			"  childValue: child.OMP_DOTENV_REPRO_MARKER ?? null,",
			"  nodeEnv: process.env.NODE_ENV ?? null,",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: { ...process.env, NODE_ENV: undefined, OMP_DOTENV_REPRO_MARKER: undefined },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			processValue: "synthetic-mode-local-value",
			childValue: null,
			nodeEnv: "production",
		});
	});

	it.skipIf(process.platform === "win32")(
		"keeps filtering after the process working directory is deleted",
		async () => {
			const cwd = path.dirname(writeTempEnv(""));
			const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
			const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
			const script = [
				'import * as fs from "node:fs";',
				`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
				`import { getProjectDir } from ${JSON.stringify(dirsModulePath)};`,
				"getProjectDir();",
				"fs.rmSync(process.cwd(), { recursive: true });",
				'const child = filterChildShellEnv({ UNCHANGED: "parent-value" });',
				"process.stdout.write(JSON.stringify(child));",
			].join("\n");
			const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual({ UNCHANGED: "parent-value" });
		},
	);
});

describe("isEnvOwnedByProjectDotenv", () => {
	const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");

	async function probeProjectDotenvOwnership(
		dotenv: string,
		env: Record<string, string | undefined>,
		name = "PI_CODING_AGENT_DIR",
	): Promise<boolean> {
		const cwd = path.dirname(writeTempEnv(dotenv));
		const script = [
			`import { isEnvOwnedByProjectDotenv } from ${JSON.stringify(envModulePath)};`,
			`process.stdout.write(JSON.stringify(isEnvOwnedByProjectDotenv(${JSON.stringify(name)})));`,
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout) as boolean;
	}

	it("treats PI_CODING_AGENT_DIR from the launch project dotenv as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership("PI_CODING_AGENT_DIR=./attacker-dir\n", {
				PI_CODING_AGENT_DIR: undefined,
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(true);
	});

	it("treats an unspaced unquoted dotenv # comment as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership("PI_CODING_AGENT_DIR=./attacker#ignored\n", {
				PI_CODING_AGENT_DIR: undefined,
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(true);
	});

	it("keeps a launcher-provided PI_CODING_AGENT_DIR trusted even if dotenv repeats it", async () => {
		expect(
			await probeProjectDotenvOwnership("PI_CODING_AGENT_DIR=./attacker-dir\n", {
				PI_CODING_AGENT_DIR: "/trusted-agent",
			}),
		).toBe(false);
	});

	it("treats PI_CONFIG_DIR from the launch project dotenv as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership(
				"PI_CONFIG_DIR=./attacker-config\n",
				{
					PI_CONFIG_DIR: undefined,
					OMP_CONFIG_DIR: undefined,
				},
				"PI_CONFIG_DIR",
			),
		).toBe(true);
	});

	it("keeps a launcher-provided PI_CONFIG_DIR trusted even if dotenv repeats it", async () => {
		expect(
			await probeProjectDotenvOwnership(
				"PI_CONFIG_DIR=./attacker-config\n",
				{
					PI_CONFIG_DIR: ".trusted-config",
				},
				"PI_CONFIG_DIR",
			),
		).toBe(false);
	});

	it("treats a bun-overwritten empty launcher PI_CODING_AGENT_DIR as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership("PI_CODING_AGENT_DIR=./attacker-dir\n", {
				PI_CODING_AGENT_DIR: "",
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(true);
	});

	it("treats a bun-overwritten empty launcher PI_CONFIG_DIR as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership(
				"PI_CONFIG_DIR=./attacker-config\n",
				{
					PI_CONFIG_DIR: "",
					OMP_CONFIG_DIR: undefined,
				},
				"PI_CONFIG_DIR",
			),
		).toBe(true);
	});

	it("treats a bun-decoded escaped-newline PI_CODING_AGENT_DIR as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership('PI_CODING_AGENT_DIR="./attacker\\n-dir"\n', {
				PI_CODING_AGENT_DIR: "",
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(true);
	});

	it("treats a bun-expanded ${" + "VAR:-fallback} PI_CODING_AGENT_DIR as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership("PI_CODING_AGENT_DIR=${" + "UNSET:-./attacker-dir}\n", {
				PI_CODING_AGENT_DIR: "",
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(true);
	});

	it("treats a bun-expanded ${" + "VAR:-fallback} PI_CONFIG_DIR as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership(
				"PI_CONFIG_DIR=${" + "UNSET:-./attacker-config}\n",
				{
					PI_CONFIG_DIR: "",
					OMP_CONFIG_DIR: undefined,
				},
				"PI_CONFIG_DIR",
			),
		).toBe(true);
	});

	it("treats a bun-quoted multiline PI_CODING_AGENT_DIR as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership('PI_CODING_AGENT_DIR="./attacker\n-dir"\n', {
				PI_CODING_AGENT_DIR: "",
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(true);
	});

	it("treats a bun-quoted multiline PI_CODING_AGENT_DIR with first-line trailing space as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership('PI_CODING_AGENT_DIR="./attacker \n-dir"\n', {
				PI_CODING_AGENT_DIR: "",
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(true);
	});

	it("treats a bun-quoted multiline PI_CONFIG_DIR as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership(
				'PI_CONFIG_DIR="./attacker\n-config"\n',
				{
					PI_CONFIG_DIR: "",
					OMP_CONFIG_DIR: undefined,
				},
				"PI_CONFIG_DIR",
			),
		).toBe(true);
	});

	it("treats unrecognized bun $ syntax in PI_CODING_AGENT_DIR as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership("PI_CODING_AGENT_DIR=${" + "UNSET:=./attacker-dir}\n", {
				PI_CODING_AGENT_DIR: "",
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(true);
	});

	it("treats a bun-quoted PI_CODING_AGENT_DIR closed after an even-length backslash run as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership('PI_CODING_AGENT_DIR="./attacker\\\\"\n', {
				PI_CODING_AGENT_DIR: "",
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(true);
	});

	it("treats a bun-quoted PI_CONFIG_DIR closed after an even-length backslash run as project-owned", async () => {
		expect(
			await probeProjectDotenvOwnership(
				'PI_CONFIG_DIR="./attacker\\\\"\n',
				{
					PI_CONFIG_DIR: "",
					OMP_CONFIG_DIR: undefined,
				},
				"PI_CONFIG_DIR",
			),
		).toBe(true);
	});

	it("does not treat an explicit --profile selection as project-owned", async () => {
		const cwd = path.dirname(writeTempEnv("OMP_PROFILE=evil\nPI_PROFILE=evil\n"));
		const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
		const script = [
			`import { setProfile } from ${JSON.stringify(dirsModulePath)};`,
			`import { isEnvOwnedByProjectDotenv } from ${JSON.stringify(envModulePath)};`,
			'setProfile("work", { fromArgv: true });',
			"process.stdout.write(JSON.stringify({",
			'  omp: isEnvOwnedByProjectDotenv("OMP_PROFILE"),',
			'  pi: isEnvOwnedByProjectDotenv("PI_PROFILE"),',
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ omp: false, pi: false });
	});

	it("does not treat an explicit --profile default selection as project-owned", async () => {
		const cwd = path.dirname(writeTempEnv("OMP_PROFILE=evil\nPI_PROFILE=evil\n"));
		const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
		const script = [
			`import { isProfileSelectedFromArgv, setProfile } from ${JSON.stringify(dirsModulePath)};`,
			`import { isEnvOwnedByProjectDotenv } from ${JSON.stringify(envModulePath)};`,
			'setProfile("default", { fromArgv: true });',
			"process.stdout.write(JSON.stringify({",
			'  omp: isEnvOwnedByProjectDotenv("OMP_PROFILE"),',
			'  pi: isEnvOwnedByProjectDotenv("PI_PROFILE"),',
			"  fromArgv: isProfileSelectedFromArgv(),",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ omp: false, pi: false, fromArgv: true });
	});

	it("still treats a dotenv-selected profile as project-owned after setProfile", async () => {
		const cwd = path.dirname(writeTempEnv("OMP_PROFILE=evil\nPI_PROFILE=evil\n"));
		const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
		const script = [
			`import { setProfile } from ${JSON.stringify(dirsModulePath)};`,
			`import { isEnvOwnedByProjectDotenv } from ${JSON.stringify(envModulePath)};`,
			'setProfile("evil");',
			"process.stdout.write(JSON.stringify({",
			'  omp: isEnvOwnedByProjectDotenv("OMP_PROFILE"),',
			'  pi: isEnvOwnedByProjectDotenv("PI_PROFILE"),',
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ omp: true, pi: true });
	});

	it("treats a dotenv-selected default profile as project-owned without a launch snapshot", async () => {
		const cwd = path.dirname(writeTempEnv("OMP_PROFILE=default\n"));
		const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
		const script = [
			'Object.defineProperty(process, "platform", { value: "darwin" });',
			`const { setProfile } = await import(${JSON.stringify(dirsModulePath)});`,
			"setProfile(undefined);",
			`const { isEnvOwnedByProjectDotenv } = await import(${JSON.stringify(envModulePath)});`,
			"process.stdout.write(JSON.stringify({",
			'  omp: isEnvOwnedByProjectDotenv("OMP_PROFILE"),',
			'  pi: isEnvOwnedByProjectDotenv("PI_PROFILE"),',
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ omp: true, pi: true });
	});

	it("treats a dotenv PI_PROFILE default as project-owned without a launch snapshot", async () => {
		const cwd = path.dirname(writeTempEnv("PI_PROFILE=default\n"));
		const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
		const script = [
			'Object.defineProperty(process, "platform", { value: "darwin" });',
			`const { setProfile } = await import(${JSON.stringify(dirsModulePath)});`,
			"setProfile(undefined);",
			`const { isEnvOwnedByProjectDotenv } = await import(${JSON.stringify(envModulePath)});`,
			"process.stdout.write(JSON.stringify({",
			'  omp: isEnvOwnedByProjectDotenv("OMP_PROFILE"),',
			'  pi: isEnvOwnedByProjectDotenv("PI_PROFILE"),',
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ omp: false, pi: true });
	});

	it("trusts parent env profile over dotenv default profile without a launch snapshot", async () => {
		const cwd = path.dirname(writeTempEnv("OMP_PROFILE=default\n"));
		const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
		const script = [
			'Object.defineProperty(process, "platform", { value: "darwin" });',
			'process.env.OMP_PROFILE = "work";',
			`const { setProfile } = await import(${JSON.stringify(dirsModulePath)});`,
			'setProfile("work");',
			`const { isEnvOwnedByProjectDotenv } = await import(${JSON.stringify(envModulePath)});`,
			"process.stdout.write(JSON.stringify({",
			'  omp: isEnvOwnedByProjectDotenv("OMP_PROFILE"),',
			'  pi: isEnvOwnedByProjectDotenv("PI_PROFILE"),',
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				OMP_PROFILE: "work",
				PI_PROFILE: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ omp: false, pi: false });
	});

	it("treats a .env.development redirect as project-owned when dotenv sets NODE_ENV", async () => {
		const cwd = path.dirname(writeTempEnv("NODE_ENV=production\n"));
		fs.writeFileSync(path.join(cwd, ".env.development"), "PI_CODING_AGENT_DIR=./attacker-dir\n");
		const script = [
			`import { isEnvOwnedByProjectDotenv } from ${JSON.stringify(envModulePath)};`,
			'process.stdout.write(JSON.stringify(isEnvOwnedByProjectDotenv("PI_CODING_AGENT_DIR")));',
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				NODE_ENV: undefined,
				PI_CODING_AGENT_DIR: undefined,
				OMP_CODING_AGENT_DIR: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toBe(true);
	});

	it("does not treat a differently cased dotenv key as owned on posix", async () => {
		expect(
			await probeProjectDotenvOwnership("pi_coding_agent_dir=./attacker-dir\n", {
				PI_CODING_AGENT_DIR: undefined,
				OMP_CODING_AGENT_DIR: undefined,
			}),
		).toBe(false);
	});

	it("treats a differently cased dotenv key as owned on windows", async () => {
		const cwd = path.dirname(writeTempEnv("pi_coding_agent_dir=./attacker-dir\n"));
		const script = [
			'Object.defineProperty(process, "platform", { configurable: true, value: "win32" });',
			// Platform must be win32 before env.ts caches launch-dotenv names.
			`const { isEnvOwnedByProjectDotenv } = await import(${JSON.stringify(envModulePath)});`,
			'process.stdout.write(JSON.stringify(isEnvOwnedByProjectDotenv("PI_CODING_AGENT_DIR")));',
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: undefined,
				OMP_CODING_AGENT_DIR: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toBe(true);
	});

	it("treats the last case-insensitive dotenv assignment as project-owned on Windows", async () => {
		const cwd = path.dirname(writeTempEnv("PI_CODING_AGENT_DIR=./benign-dir\npi_coding_agent_dir=./attacker-dir\n"));
		const script = [
			'Object.defineProperty(process, "platform", { configurable: true, value: "win32" });',
			'process.env.PI_CODING_AGENT_DIR = "./attacker-dir";',
			// Load after the Windows fake so /proc is not treated as a launch snapshot.
			`const { isEnvOwnedByProjectDotenv } = await import(${JSON.stringify(envModulePath)});`,
			'process.stdout.write(JSON.stringify(isEnvOwnedByProjectDotenv("PI_CODING_AGENT_DIR")));',
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: undefined,
				OMP_CODING_AGENT_DIR: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toBe(true);
	});
});

describe("stripGitRepoLocationEnv", () => {
	it("matches case-insensitively on win32 and exactly on POSIX", () => {
		// Windows env lookups are case-insensitive, so a `git_dir` block binds
		// there; POSIX names are case-sensitive and must not be over-stripped.
		const win32Env: Record<string, string> = { GIT_DIR: "a", git_dir: "b", GIT_WORK_TREE: "c", KEEP: "d" };
		stripGitRepoLocationEnv(win32Env, "win32");
		expect(win32Env).toEqual({ KEEP: "d" });

		const posixEnv: Record<string, string> = { GIT_DIR: "a", git_dir: "b", KEEP: "d" };
		stripGitRepoLocationEnv(posixEnv, "linux");
		expect(posixEnv).toEqual({ git_dir: "b", KEEP: "d" });
	});
});

describe("isBunTestRuntime", () => {
	it("does not treat shared application env names as a test runner signal", async () => {
		expect(await runRuntimeProbe({ NODE_ENV: "test", BUN_ENV: undefined, PI_TEST_RUNTIME: undefined })).toBe(false);
		expect(await runRuntimeProbe({ NODE_ENV: undefined, BUN_ENV: "test", PI_TEST_RUNTIME: undefined })).toBe(false);
	});

	it("honors the private test runner signal", async () => {
		expect(await runRuntimeProbe({ NODE_ENV: undefined, BUN_ENV: undefined, PI_TEST_RUNTIME: "1" })).toBe(true);
	});

	it("recognizes Bun's underscore test entrypoints", async () => {
		const dir = path.dirname(writeTempEnv(""));
		const underscoreProbePath = path.join(dir, "runtime_test.ts");
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		fs.writeFileSync(
			underscoreProbePath,
			`import { isBunTestRuntime } from ${JSON.stringify(envModulePath)};\nprocess.stdout.write(JSON.stringify(isBunTestRuntime()));\n`,
		);
		expect(
			await runRuntimeProbe(
				{ NODE_ENV: "test", BUN_ENV: undefined, PI_TEST_RUNTIME: undefined },
				underscoreProbePath,
			),
		).toBe(true);
	});
});

/**
 * Faithful model of Windows `process.env`: case-insensitive reads, but
 * enumeration (`ownKeys`) preserves the real key casing — exactly Node
 * (`uv_os_getenv` + `uv_os_environ`) and Bun (`CaseInsensitiveASCIIStringArrayHashMap`).
 */
function windowsLikeEnv(backing: Record<string, string>): Record<string, string | undefined> {
	return new Proxy(backing, {
		get(target, prop) {
			if (typeof prop !== "string") return Reflect.get(target, prop);
			for (const key in target) {
				if (key.toLowerCase() === prop.toLowerCase()) return target[key];
			}
			return undefined;
		},
		has(target, prop) {
			if (typeof prop !== "string") return Reflect.has(target, prop);
			for (const key in target) {
				if (key.toLowerCase() === prop.toLowerCase()) return true;
			}
			return false;
		},
	}) as Record<string, string | undefined>;
}

describe("$envExact", () => {
	it("does not hijack a literal via a case-differing Windows system var", () => {
		// Windows ships PUBLIC=C:\Users\Public and reads are case-insensitive, so
		// a bare `env["public"]` returns it — the /login #7361 401 root cause.
		const env = windowsLikeEnv({ PUBLIC: "C:\\Users\\Public" });
		expect(env.public).toBe("C:\\Users\\Public");
		expect($envExact("public", env)).toBeUndefined();
	});

	it("still resolves a genuine exact-case reference on a case-insensitive env", () => {
		const env = windowsLikeEnv({ MY_KEY: "secret" });
		expect($envExact("MY_KEY", env)).toBe("secret");
		expect($envExact("my_key", env)).toBeUndefined();
	});

	it("reads process.env by default", () => {
		const name = `PI_ENVEXACT_TEST_${Date.now()}`;
		process.env[name] = "value";
		try {
			expect($envExact(name)).toBe("value");
		} finally {
			delete process.env[name];
		}
		expect($envExact(name)).toBeUndefined();
	});
});

describe("OTEL_* from omp's own .env files", () => {
	interface ProbeResult {
		bunEnv: Record<string, string | null>;
		otelEnv: Record<string, string | null>;
		insideWindow: Record<string, string | null>;
		afterWindow: Record<string, string | null>;
		bashChildEnv: Record<string, string>;
	}

	// The dotenv loader runs at module load, so each case needs a fresh process
	// whose agent dir and HOME are temp dirs.
	async function runProbe(shellEnv: Record<string, string>): Promise<ProbeResult> {
		const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-utils-otel-home-"));
		const agentDir = path.join(home, "agent");
		const cwd = path.join(home, "project");
		tempDirs.push(home);
		await Bun.write(
			path.join(agentDir, ".env"),
			[
				"OTEL_PROBE_AGENT=agent",
				"OTEL_PROBE_SHELL=agent-file",
				"OTEL_PROBE_BOTH=agent",
				"PLAIN_PROBE_AGENT=plain",
			].join("\n"),
		);
		await Bun.write(
			path.join(home, ".env"),
			["OTEL_PROBE_HOME=home", "OTEL_PROBE_AGENT=home-loses", "OTEL_PROBE_CONFIG=home-loses"].join("\n"),
		);
		await Bun.write(path.join(home, ".omp", ".env"), ["OTEL_PROBE_CONFIG=config-root"].join("\n"));
		await Bun.write(path.join(cwd, ".env"), ["OTEL_PROBE_PROJECT=project", "OTEL_PROBE_BOTH=project"].join("\n"));
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const names = [
			"OTEL_PROBE_AGENT",
			"OTEL_PROBE_HOME",
			"OTEL_PROBE_SHELL",
			"OTEL_PROBE_BOTH",
			"OTEL_PROBE_PROJECT",
			"OTEL_PROBE_CONFIG",
			"PLAIN_PROBE_AGENT",
		];
		const script = [
			`import { $otelEnv, withOmpOtelEnv } from ${JSON.stringify(envModulePath)};`,
			`const names = ${JSON.stringify(names)};`,
			"const pick = read => Object.fromEntries(names.map(name => [name, read(name) ?? null]));",
			"const insideWindow = withOmpOtelEnv(() => pick(name => process.env[name]));",
			"const bash = Bun.spawn(['bash', '-c', 'env'], { env: process.env, stdout: 'pipe' });",
			"const bashText = await new Response(bash.stdout).text();",
			"const bashChildEnv = Object.fromEntries(bashText.split('\\n').filter(line => line.startsWith('OTEL_PROBE_') || line.startsWith('PLAIN_PROBE_')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));",
			"process.stdout.write(JSON.stringify({",
			"  bunEnv: pick(name => Bun.env[name]),",
			"  otelEnv: pick(name => $otelEnv(name)),",
			"  insideWindow,",
			"  afterWindow: pick(name => process.env[name]),",
			"  bashChildEnv,",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--eval", script], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: agentDir,
				...DIR_RESOLUTION_ENV_RESET,
				OTEL_PROBE_CONFIG: undefined,
				OTEL_PROBE_AGENT: undefined,
				OTEL_PROBE_HOME: undefined,
				OTEL_PROBE_SHELL: undefined,
				OTEL_PROBE_BOTH: undefined,
				OTEL_PROBE_PROJECT: undefined,
				PLAIN_PROBE_AGENT: undefined,
				...shellEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout);
	}

	it.skipIf(process.platform === "win32")(
		"keeps agent/home .env OTEL_* out of Bun.env and any child, but readable through $otelEnv",
		async () => {
			const result = await runProbe({});
			// Neither the agent nor the home file reaches the process environment;
			// the project .env keeps its existing behavior (loaded into Bun.env), and
			// non-OTEL names from the agent file are untouched.
			expect(result.bunEnv).toEqual({
				OTEL_PROBE_AGENT: null,
				OTEL_PROBE_HOME: null,
				OTEL_PROBE_SHELL: null,
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
				OTEL_PROBE_CONFIG: null,
				PLAIN_PROBE_AGENT: "plain",
			});
			// agent beats home; config root beats home; project beats agent.
			expect(result.otelEnv).toEqual({
				OTEL_PROBE_AGENT: "agent",
				OTEL_PROBE_HOME: "home",
				OTEL_PROBE_SHELL: "agent-file",
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
				OTEL_PROBE_CONFIG: "config-root",
				PLAIN_PROBE_AGENT: "plain",
			});
			// The SDK-facing window exposes the file values, then removes them.
			expect(result.insideWindow).toMatchObject({
				OTEL_PROBE_AGENT: "agent",
				OTEL_PROBE_HOME: "home",
				OTEL_PROBE_SHELL: "agent-file",
				OTEL_PROBE_BOTH: "project",
			});
			expect(result.afterWindow).toEqual(result.bunEnv);
			// A bash child handed the live environment sees none of the file-owned values.
			expect(result.bashChildEnv).toEqual({
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
				PLAIN_PROBE_AGENT: "plain",
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"lets a shell-exported OTEL_* win in Bun.env and $otelEnv",
		async () => {
			const result = await runProbe({ OTEL_PROBE_SHELL: "from-shell" });
			expect(result.bunEnv.OTEL_PROBE_SHELL).toBe("from-shell");
			expect(result.otelEnv.OTEL_PROBE_SHELL).toBe("from-shell");
			expect(result.insideWindow.OTEL_PROBE_SHELL).toBe("from-shell");
			expect(result.afterWindow.OTEL_PROBE_SHELL).toBe("from-shell");
			// Still visible to children, as any exported variable is.
			expect(result.bashChildEnv.OTEL_PROBE_SHELL).toBe("from-shell");
			// The agent-file-only names stay private.
			expect(result.bashChildEnv.OTEL_PROBE_AGENT).toBeUndefined();
		},
		20_000,
	);

	describe("claimOmpOtelEnvFileEntry", () => {
		it("claims only OTEL_* names and applies the live value first", () => {
			expect(claimOmpOtelEnvFileEntry("PLAIN_CLAIM_PROBE", "x", "linux")).toBe(false);
			expect(claimOmpOtelEnvFileEntry("otel_lower_claim_probe", "x", "linux")).toBe(false);
			expect($otelEnv("PLAIN_CLAIM_PROBE")).toBeUndefined();

			process.env.OTEL_CLAIM_LIVE_PROBE = "live";
			try {
				expect(claimOmpOtelEnvFileEntry("OTEL_CLAIM_LIVE_PROBE", "file", "linux")).toBe(true);
				expect($otelEnv("OTEL_CLAIM_LIVE_PROBE")).toBe("live");
			} finally {
				delete process.env.OTEL_CLAIM_LIVE_PROBE;
			}
			// The file value was dropped, not deferred.
			expect($otelEnv("OTEL_CLAIM_LIVE_PROBE")).toBeUndefined();
		});

		it("keeps the first non-empty value across files", () => {
			claimOmpOtelEnvFileEntry("OTEL_CLAIM_ORDER_PROBE", "first", "linux");
			claimOmpOtelEnvFileEntry("OTEL_CLAIM_ORDER_PROBE", "second", "linux");
			expect($otelEnv("OTEL_CLAIM_ORDER_PROBE")).toBe("first");
		});

		it("folds a lowercase name to its upper-case form on win32 only", () => {
			expect(claimOmpOtelEnvFileEntry("otel_claim_win_probe", "win", "win32")).toBe(true);
			expect(Bun.env.otel_claim_win_probe).toBeUndefined();
			expect(Bun.env.OTEL_CLAIM_WIN_PROBE).toBeUndefined();
			withOmpOtelEnv(() => {
				expect(process.env.OTEL_CLAIM_WIN_PROBE).toBe("win");
			});
			expect(process.env.OTEL_CLAIM_WIN_PROBE).toBeUndefined();
		});
	});

	describe("withOmpOtelEnv", () => {
		it("exposes file values only inside the callback and returns its result", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_A", "a", "linux");
			expect(process.env.OTEL_WINDOW_PROBE_A).toBeUndefined();
			const result = withOmpOtelEnv(() => {
				expect(process.env.OTEL_WINDOW_PROBE_A).toBe("a");
				return 42;
			});
			expect(result).toBe(42);
			expect(process.env.OTEL_WINDOW_PROBE_A).toBeUndefined();
		});

		it("removes the values when the callback throws", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_THROW", "t", "linux");
			expect(() =>
				withOmpOtelEnv(() => {
					expect(process.env.OTEL_WINDOW_PROBE_THROW).toBe("t");
					throw new Error("boom");
				}),
			).toThrow("boom");
			expect(process.env.OTEL_WINDOW_PROBE_THROW).toBeUndefined();
		});

		it("restores a name that was set to the empty string instead of deleting it", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_EMPTY", "file", "linux");
			process.env.OTEL_WINDOW_PROBE_EMPTY = "";
			try {
				withOmpOtelEnv(() => {
					expect(process.env.OTEL_WINDOW_PROBE_EMPTY).toBe("file");
				});
				expect(process.env.OTEL_WINDOW_PROBE_EMPTY).toBe("");
			} finally {
				delete process.env.OTEL_WINDOW_PROBE_EMPTY;
			}
		});

		it("never overwrites or deletes a name that is already set", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_SET", "file", "linux");
			process.env.OTEL_WINDOW_PROBE_SET = "live";
			try {
				withOmpOtelEnv(() => {
					expect(process.env.OTEL_WINDOW_PROBE_SET).toBe("live");
				});
				expect(process.env.OTEL_WINDOW_PROBE_SET).toBe("live");
			} finally {
				delete process.env.OTEL_WINDOW_PROBE_SET;
			}
		});
	});
});
