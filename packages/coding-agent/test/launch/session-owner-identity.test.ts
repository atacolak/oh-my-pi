// Integration test — real timers are required (ts-no-test-timers exception): every broker
// assertion observes the environment a real broker process spawned into a real child, and the
// awaited signal is that child's report file, never a fixed delay.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { SESSION_OWNER_IDENTITY_KEYS, sessionOwnerIdentity, sessionOwnerSpec } from "../../src/launch/session-owner";
import { terminalSpec } from "./terminal-fixture";

const IDENTITY_CHILD = path.join(import.meta.dir, "../fixtures/session-owner-identity-child.ts");
const IDENTITY_BROKER = path.join(import.meta.dir, "../fixtures/session-owner-identity-broker.ts");

const BROKER_IDENTITY: Record<(typeof SESSION_OWNER_IDENTITY_KEYS)[number], string> = {
	HCOM_PROCESS_ID: "broker-process-id",
	HCOM_INSTANCE_NAME: "memory_lead",
	HCOM_NAME: "memory_lead",
	HCOM_OMP_IDENTITY_OWNER: "memory_lead",
	HCOM_LAUNCHED: "1",
};

interface IdentityReport {
	identity: Record<string, string>;
	probe: string | null;
}

interface ScenarioEntry {
	mode: "terminal" | "daemon";
	reportFile: string;
	spec: DaemonSpec;
}

function foreignBrokerEnv(): Record<string, string> {
	const identityKeys = new Set<string>(SESSION_OWNER_IDENTITY_KEYS);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (identityKeys.has(key)) continue;
		if (key === DAEMON_PROJECT_DIR_ENV || key === DAEMON_RUNTIME_DIR_ENV || key === DAEMON_IDLE_GRACE_ENV) continue;
		env[key] = value;
	}
	for (const key of SESSION_OWNER_IDENTITY_KEYS) env[key] = BROKER_IDENTITY[key];
	return env;
}

async function runBrokerScenario(tempDir: string, entries: ScenarioEntry[]): Promise<IdentityReport[]> {
	const projectDir = path.join(tempDir, "project");
	fs.mkdirSync(projectDir, { recursive: true });
	const requestFile = path.join(tempDir, "request.json");
	const resultFile = path.join(tempDir, "result.json");
	fs.writeFileSync(requestFile, JSON.stringify({ entries }));
	const child = Bun.spawn([process.execPath, IDENTITY_BROKER, projectDir, requestFile, resultFile], {
		cwd: projectDir,
		env: foreignBrokerEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`identity broker fixture exited ${exitCode}\n${stdout}\n${stderr}`);
	return JSON.parse(fs.readFileSync(resultFile, "utf8")) as IdentityReport[];
}

function ownerSpec(projectDir: string, reportFile: string, identity: Record<string, string>): DaemonSpec {
	return terminalSpec(projectDir, "", {
		name: `mind-${Snowflake.next()}`,
		args: [IDENTITY_CHILD, reportFile],
		identity,
		env: { OMP_SESSION_IDENTITY_PROBE: "kept" },
	});
}

describe("session owner identity", () => {
	it("declares exactly the identity its launcher carries", () => {
		const identity = sessionOwnerIdentity({
			HCOM_PROCESS_ID: "21b683ec",
			HCOM_INSTANCE_NAME: "argon",
			HCOM_NAME: "argon",
			HCOM_OMP_IDENTITY_OWNER: "midi",
			HCOM_LAUNCHED: "1",
		});

		expect(identity).toEqual({ HCOM_PROCESS_ID: "21b683ec", HCOM_INSTANCE_NAME: "argon", HCOM_LAUNCHED: "1" });
	});

	it("declares no identity for a launcher born without one", () => {
		expect(sessionOwnerIdentity({ HCOM_OMP_IDENTITY_OWNER: "midi", OMP_SESSION: "1" })).toEqual({});
	});

	it("carries the identity its launcher declares into the owner spec", () => {
		const identity = { HCOM_PROCESS_ID: "21b683ec", HCOM_INSTANCE_NAME: "argon", HCOM_LAUNCHED: "1" };

		const spec = sessionOwnerSpec({ name: "mind-a", projectDir: "/p", argv: ["--resume", "sess-1"], identity });

		expect(spec.identity).toEqual(identity);
		expect(spec.env).toEqual({});
	});
});

describe("session owner identity through the broker", () => {
	it("never stamps an owner with the broker's identity when the spec declares none", async () => {
		using tempDir = TempDir.createSync("@omp-owner-identity-");
		const projectDir = path.join(tempDir.path(), "project");
		const reportFile = path.join(tempDir.path(), "report.json");

		const [report] = await runBrokerScenario(tempDir.path(), [
			{ mode: "terminal", reportFile, spec: ownerSpec(projectDir, reportFile, {}) },
		]);

		expect(report?.identity).toEqual({});
		expect(report?.probe).toBe("kept");
	}, 60_000);

	it("keeps each owner's declared identity when one broker starts two of them", async () => {
		using tempDir = TempDir.createSync("@omp-owner-identities-");
		const projectDir = path.join(tempDir.path(), "project");
		const alphaReportFile = path.join(tempDir.path(), "alpha.json");
		const betaReportFile = path.join(tempDir.path(), "beta.json");
		const alphaIdentity = { HCOM_PROCESS_ID: "pid-alpha", HCOM_INSTANCE_NAME: "alpha", HCOM_LAUNCHED: "1" };
		const betaIdentity = { HCOM_PROCESS_ID: "pid-beta", HCOM_INSTANCE_NAME: "beta", HCOM_LAUNCHED: "1" };

		const [alphaReport, betaReport] = await runBrokerScenario(tempDir.path(), [
			{ mode: "terminal", reportFile: alphaReportFile, spec: ownerSpec(projectDir, alphaReportFile, alphaIdentity) },
			{ mode: "terminal", reportFile: betaReportFile, spec: ownerSpec(projectDir, betaReportFile, betaIdentity) },
		]);

		expect(alphaReport?.identity).toEqual(alphaIdentity);
		expect(betaReport?.identity).toEqual(betaIdentity);
		expect(alphaReport?.identity.HCOM_PROCESS_ID).toBe("pid-alpha");
		expect(betaReport?.identity.HCOM_PROCESS_ID).toBe("pid-beta");
		expect(alphaReport?.identity.HCOM_PROCESS_ID).not.toBe(betaReport?.identity.HCOM_PROCESS_ID);
	}, 60_000);

	it("passes a declared process id through unchanged even when another owner declares the same one", async () => {
		using tempDir = TempDir.createSync("@omp-owner-collision-");
		const projectDir = path.join(tempDir.path(), "project");
		const alphaReportFile = path.join(tempDir.path(), "alpha.json");
		const betaReportFile = path.join(tempDir.path(), "beta.json");
		const alphaIdentity = { HCOM_PROCESS_ID: "shared-pid", HCOM_INSTANCE_NAME: "alpha", HCOM_LAUNCHED: "1" };
		const betaIdentity = { HCOM_PROCESS_ID: "shared-pid", HCOM_INSTANCE_NAME: "beta", HCOM_LAUNCHED: "1" };

		const [alphaReport, betaReport] = await runBrokerScenario(tempDir.path(), [
			{ mode: "terminal", reportFile: alphaReportFile, spec: ownerSpec(projectDir, alphaReportFile, alphaIdentity) },
			{ mode: "terminal", reportFile: betaReportFile, spec: ownerSpec(projectDir, betaReportFile, betaIdentity) },
		]);

		expect(alphaReport?.identity).toEqual(alphaIdentity);
		expect(betaReport?.identity).toEqual(betaIdentity);
	}, 60_000);

	it("keeps inheriting the broker environment for daemons that declare no identity", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-inherit-");
		const projectDir = path.join(tempDir.path(), "project");
		const reportFile = path.join(tempDir.path(), "report.json");
		const spec = terminalSpec(projectDir, "", {
			name: `worker-${Snowflake.next()}`,
			args: [IDENTITY_CHILD, reportFile],
			pty: false,
			persist: false,
		});

		const [report] = await runBrokerScenario(tempDir.path(), [{ mode: "daemon", reportFile, spec }]);

		expect(report?.identity).toEqual(BROKER_IDENTITY);
	}, 60_000);
});
