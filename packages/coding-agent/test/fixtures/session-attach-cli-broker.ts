import * as fs from "node:fs";
import { createDaemonBrokerClient } from "../../src/launch/client";

const [projectDir, reportFile, stopFile] = process.argv.slice(2);
if (!projectDir || !reportFile || !stopFile) {
	throw new Error("usage: session-attach-cli-broker <projectDir> <reportFile> <stopFile>");
}

const name = `mind-${crypto.randomUUID()}`;
const subscriptionId = `bootstrap-${crypto.randomUUID()}`;
const script = [
	"process.stdin.resume();",
	'process.on("SIGTERM", () => { process.stdout.write("OWNER-BANNER\\r\\n"); setTimeout(() => process.exit(42), 150); });',
	'process.on("SIGINT", () => process.exit(42));',
].join("\n");

const client = await createDaemonBrokerClient(projectDir);
client.subscribeTerminal(subscriptionId, () => {});
const started = await client.request({
	op: "terminal_start",
	subscriptionId,
	spec: {
		name,
		application: process.execPath,
		args: ["-e", script],
		env: {},
		cwd: projectDir,
		pty: true,
		persist: true,
		detached: false,
		restart: "no",
	},
	columns: 100,
	rows: 30,
});
if (started.op !== "terminal_start") throw new Error("terminal_start did not start the owner");
await client.request({ op: "terminal_detach", subscriptionId, name, id: started.daemon.id });
fs.writeFileSync(reportFile, JSON.stringify({ name, id: started.daemon.id, pid: started.daemon.pid }));

while (!fs.existsSync(stopFile)) await Bun.sleep(20);
await client.request({ op: "shutdown" }).catch(() => undefined);
client.close();
