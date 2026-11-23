import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SESSION_OWNER_CONTEXT_ENV, SESSION_OWNER_WAKE_TARGET_ENV } from "../src/launch/session-owner";

it("removes consumed actor wake metadata from the actual native restart environment", async () => {
	using tempDir = TempDir.createSync("@omp-restart-wake-");
	const cwd = tempDir.path();
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/restart-profile.ts")], {
		cwd,
		env: {
			...process.env,
			HOME: cwd,
			USERPROFILE: cwd,
			OMP_PROFILE: undefined,
			PI_PROFILE: undefined,
			PI_CODING_AGENT_DIR: undefined,
			PI_CODING_AGENT_SESSION_DIR: undefined,
			PI_CONFIG_DIR: ".omp",
			XDG_DATA_HOME: undefined,
			XDG_STATE_HOME: undefined,
			XDG_CACHE_HOME: undefined,
			[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({ projectDir: cwd, name: "fixture", id: "generation" }),
			[SESSION_OWNER_WAKE_TARGET_ENV]: JSON.stringify({
				sessionId: "fixture",
				sessionFile: path.join(cwd, "fixture.jsonl"),
				profile: "fixture",
			}),
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(JSON.parse(stdout.trim()).wakeTarget).toBeNull();
}, 30_000);
