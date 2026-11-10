import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { attestCliRestartReceiver } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { TempDir } from "@oh-my-pi/pi-utils";

it("the real CLI answers a receiver probe without creating an agent store or default config directory", async () => {
	using temp = TempDir.createSync("@omp-receiver-cli-");
	const nonce = Bun.randomUUIDv7();
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			path.resolve(import.meta.dir, "../src/cli.ts"),
			"--version",
			"--restart-receiver-probe",
			nonce,
		],
		cwd: temp.path(),
		env: {
			...process.env,
			HOME: temp.path(),
			USERPROFILE: temp.path(),
			OMP_PROFILE: undefined,
			PI_PROFILE: undefined,
			PI_CODING_AGENT_DIR: path.join(temp.path(), "agent"),
			PI_CODING_AGENT_SESSION_DIR: undefined,
			PI_CONFIG_DIR: ".omp",
			XDG_DATA_HOME: undefined,
			XDG_STATE_HOME: undefined,
			XDG_CACHE_HOME: undefined,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 5_000,
		killSignal: "SIGKILL",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(JSON.parse(stdout)).toMatchObject({ type: "restart_receiver", protocol: 1, nonce });
	const names = await fs.readdir(temp.path());
	expect(names).not.toContain("agent");
	expect(names).not.toContain(".omp");
});

it.each([
	["legacy version", 'process.stdout.write("omp/legacy\\n");'],
	[
		"replayed nonce",
		'process.stdout.write(JSON.stringify({type:"restart_receiver",protocol:1,nonce:"old-probe",version:"fixture"}));',
	],
	[
		"unsupported protocol",
		'process.stdout.write(JSON.stringify({type:"restart_receiver",protocol:99,nonce:process.argv.at(-1),version:"fixture"}));',
	],
	[
		"oversized attestation",
		'process.stdout.write(JSON.stringify({type:"restart_receiver",protocol:1,nonce:process.argv.at(-1),version:"fixture",padding:"x".repeat(16384)}));',
	],
])("refuses a replacement image returning a %s instead of a usable receiver", async (_name, content) => {
	using temp = TempDir.createSync("@omp-receiver-probe-");
	const entry = path.join(temp.path(), "candidate.ts");
	await Bun.write(entry, content);
	await expect(attestCliRestartReceiver([process.execPath, entry])).rejects.toThrow(/receiver|restart support/i);
});

it("bounds a hung receiver query and waits for its child to exit", async () => {
	using temp = TempDir.createSync("@omp-receiver-probe-");
	const entry = path.join(temp.path(), "hung.ts");
	await Bun.write(entry, "await Bun.sleep(60_000);\n");
	const started = performance.now();
	await expect(attestCliRestartReceiver([process.execPath, entry], 100)).rejects.toThrow(/timed out|attest/i);
	expect(performance.now() - started).toBeLessThan(2_000);
});

it("refuses an entry image that changes during its receiver query", async () => {
	using temp = TempDir.createSync("@omp-receiver-probe-");
	const entry = path.join(temp.path(), "changing.ts");
	await Bun.write(
		entry,
		[
			'await Bun.write(import.meta.path, "// image changed during query\\n");',
			'process.stdout.write(JSON.stringify({type:"restart_receiver",protocol:1,nonce:process.argv.at(-1),version:"fixture"}));',
		].join("\n"),
	);
	await expect(attestCliRestartReceiver([process.execPath, entry])).rejects.toThrow(
		/changed during receiver attestation/i,
	);
});
