import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	process.stderr.write("\nmail-consent-demo: this demo needs a real terminal (stdin and stdout must be a TTY).\n\n");
	process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mail-consent-demo-"));
const keep = process.env.MAIL_CONSENT_DEMO_KEEP === "1";
const cleanup = (): void => {
	if (keep) return;
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {}
};
process.on("exit", cleanup);

// Pass only terminal settings: the fixture must not borrow a real socket,
// provider key, service endpoint or host identity from the invoking session.
const env = {
	PATH: process.env.PATH,
	TERM: process.env.TERM,
	COLORTERM: process.env.COLORTERM,
	LANG: process.env.LANG,
	HOME: path.join(root, "home"),
	PI_CODING_AGENT_DIR: path.join(root, "agent"),
	OMP_RUN_DIR: path.join(root, "run"),
	MAIL_CONSENT_DEMO_ROOT: root,
	MAIL_CONSENT_DEMO_KEEP: keep ? "1" : "0",
};

const child = Bun.spawn({
	cmd: [process.execPath, path.join(import.meta.dir, "mail-consent-demo-child.ts")],
	cwd: root,
	env,
	stdio: ["inherit", "inherit", "inherit"],
});
const code = await child.exited;
if (!keep) process.stdout.write(`\nmail-consent-demo: removed ${root}\n`);
process.exit(code);
