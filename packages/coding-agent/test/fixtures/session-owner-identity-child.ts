import * as fs from "node:fs";
import { SESSION_OWNER_IDENTITY_KEYS } from "../../src/launch/session-owner";

const [reportFile] = process.argv.slice(2);
if (!reportFile) throw new Error("usage: session-owner-identity-child <reportFile>");

const identity: Record<string, string> = {};
for (const key of SESSION_OWNER_IDENTITY_KEYS) {
	const value = process.env[key];
	if (value !== undefined) identity[key] = value;
}
fs.writeFileSync(reportFile, JSON.stringify({ identity, probe: process.env.OMP_SESSION_IDENTITY_PROBE ?? null }));

await Bun.stdin.text();
