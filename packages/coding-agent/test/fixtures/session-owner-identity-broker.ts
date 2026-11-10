import * as fs from "node:fs";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { createDaemonBrokerClient } from "../../src/launch/client";

const [projectDir, requestFile, resultFile] = process.argv.slice(2);
if (!projectDir || !requestFile || !resultFile) {
	throw new Error("usage: session-owner-identity-broker <projectDir> <requestFile> <resultFile>");
}

interface IdentityRequest {
	entries: { mode: "terminal" | "daemon"; reportFile: string; spec: DaemonSpec }[];
}

interface IdentityReport {
	identity: Record<string, string>;
	probe: string | null;
}

async function readReport(file: string): Promise<IdentityReport> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) {
			try {
				return JSON.parse(fs.readFileSync(file, "utf8")) as IdentityReport;
			} catch {}
		}
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${file}`);
}

const request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as IdentityRequest;
const client = await createDaemonBrokerClient(projectDir);
const subscriptions: (() => void)[] = [];
const names: string[] = [];
try {
	for (const entry of request.entries) {
		names.push(entry.spec.name);
		if (entry.mode === "daemon") {
			const started = await client.request({ op: "start", spec: entry.spec });
			if (started.op !== "start") throw new Error("start did not start the daemon");
			continue;
		}
		const subscriptionId = `identity-${crypto.randomUUID()}`;
		subscriptions.push(client.subscribeTerminal(subscriptionId, () => {}));
		const started = await client.request({
			op: "terminal_start",
			subscriptionId,
			spec: entry.spec,
			columns: 100,
			rows: 30,
		});
		if (started.op !== "terminal_start") throw new Error("terminal_start did not start the owner");
	}
	const reports: IdentityReport[] = [];
	for (const entry of request.entries) reports.push(await readReport(entry.reportFile));
	fs.writeFileSync(resultFile, JSON.stringify(reports));
} finally {
	for (const off of subscriptions) off();
	for (const name of names) await client.request({ op: "stop", name, timeoutMs: 1_000 }).catch(() => undefined);
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
}
