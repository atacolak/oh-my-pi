import * as fs from "node:fs";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
	cfgStartupQuiet,
	cfgUpdateAuto,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { assignSessionIdentity } from "@oh-my-pi/pi-coding-agent/session/session-identity";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AGENT_MAIL_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-mail";
import { NativeSessionService } from "@oh-my-pi/pi-coding-agent/session/session-service";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { isRecord } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const START_MARKER = "MAIL-CONSENT-DEMO READY";
const TYPED_PROMPT = "send the release note to games";
const MAIL_BODY = "Release note: the demo fixture is ready for review.";
const APPROVAL_DEADLINE_MS = 180_000;

function failClosed(message: string): never {
	process.stderr.write(`\nmail-consent-demo: ${message}\n\n`);
	process.exit(2);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	failClosed("this demo needs a real terminal (stdin and stdout must be a TTY).");
}
const demoRoot =
	process.env.MAIL_CONSENT_DEMO_ROOT ??
	failClosed("run this through mail-consent-demo.ts so it gets a disposable agent home.");
const keep = process.env.MAIL_CONSENT_DEMO_KEEP === "1";
const agentDir = path.join(demoRoot, "agent");
const workDir = path.join(demoRoot, "project");
const recipientDir = path.join(demoRoot, "recipient");
const senderDir = path.join(demoRoot, "sender");
for (const dir of [agentDir, workDir, recipientDir, senderDir]) fs.mkdirSync(dir, { recursive: true });

const resolvedAgentDir = path.resolve(dirs.getAgentDir());
if (resolvedAgentDir !== path.resolve(agentDir)) {
	failClosed(`agent directory escaped the disposable root: ${resolvedAgentDir}`);
}
const sessionsRoot = dirs.getSessionsDir();
if (!path.resolve(sessionsRoot).startsWith(path.resolve(demoRoot) + path.sep)) {
	failClosed(`sessions directory escaped the disposable root: ${sessionsRoot}`);
}
fs.mkdirSync(sessionsRoot, { recursive: true });
dirs.setProjectDir(workDir);

resetSettingsForTest();
await initTheme();
await Settings.init({ inMemory: true, cwd: workDir });
cfgStartupQuiet.override(Settings.instance, true);

const recipientManager = SessionManager.create(recipientDir, sessionsRoot);
await recipientManager.ensureOnDisk();
const recipientSessionId = recipientManager.getSessionId();
const recipientSessionFile = recipientManager.getSessionFile() ?? failClosed("the saved recipient has no journal");
await assignSessionIdentity(recipientManager, { actorHandle: "games" }, { sessionsRoot });
await recipientManager.close();
const recipientBefore = await new NativeSessionService().resolve("games");
if (recipientBefore.sessionId !== recipientSessionId || recipientBefore.availability !== "offline") {
	failClosed(`saved recipient is not the disposable offline session (${recipientBefore.availability})`);
}

const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("anthropic", "fixture-key");
const model = getBundledModel("anthropic", "claude-sonnet-4-5") ?? failClosed("fixture model is unavailable");

const senderManager = SessionManager.create(senderDir, sessionsRoot);
await senderManager.ensureOnDisk();

const mock = createMockModel({
	handler: context => {
		if (!context.tools?.some(tool => tool.name === "agent_mail")) {
			return { content: [{ type: "text", text: "Mail demo fixture." }] };
		}
		const alreadyCalled = context.messages.some(
			message =>
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				message.content.some(block => isRecord(block) && block.type === "toolCall" && block.name === "agent_mail"),
		);
		if (alreadyCalled) {
			return { content: [{ type: "text", text: "The journal deposit was reported by agent_mail." }] };
		}
		const lastUser = [...context.messages].reverse().find(message => message.role === "user");
		const text =
			lastUser === undefined
				? ""
				: typeof lastUser.content === "string"
					? lastUser.content
					: lastUser.content
							.map(block => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
							.join("");
		if (!text.includes("games")) {
			return { content: [{ type: "text", text: `Type exactly: ${TYPED_PROMPT}` }] };
		}
		return {
			content: [
				{ type: "text", text: "Handing the release note to the games session through native mail." },
				{ type: "toolCall", name: "agent_mail", arguments: { op: "send", to: "games", message: MAIL_BODY } },
			],
		};
	},
});

const sender = await createAgentSession({
	cwd: workDir,
	agentDir,
	authStorage,
	modelRegistry: new ModelRegistry(authStorage),
	settings: Settings.isolated({
		"compaction.enabled": false,
		"async.enabled": false,
		"spelling.autocomplete": "off",
	}),
	model,
	sessionManager: senderManager,
	disableExtensionDiscovery: true,
	toolNames: ["agent_mail"],
	restrictToolNames: true,
	hasUI: true,
	interactivePrompts: true,
	tuiTranscript: true,
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: workDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
});
const session = sender.session;
session.agent.streamFn = mock.stream;
const senderSessionId = session.sessionId;
await assignSessionIdentity(senderManager, { actorHandle: "research" }, { sessionsRoot });

cfgStartupCheckUpdate.override(session.settings, false);
cfgStartupChangelogMode.override(session.settings, "hidden");
cfgStartupSetupWizard.override(session.settings, false);
cfgStartupShowSplash.override(session.settings, false);
cfgMarketplaceAutoUpdate.override(session.settings, "off");
cfgUpdateAuto.override(session.settings, false);

const bootInstructions = [
	"",
	"================================================================",
	"omp native mail consent demo (disposable agent home, mock model)",
	"================================================================",
	`agent home:   ${agentDir}`,
	`sender:       research (${senderSessionId})`,
	`recipient:    games (${recipientSessionId}), saved and offline`,
	"",
	`1. Type exactly:  ${TYPED_PROMPT}`,
	"   then press Enter.",
	"2. The real consent selector opens with Cancel highlighted:",
	"     Enter or Esc          -> Cancel (stores nothing)",
	"     Down then Enter       -> Send once",
	"     Down, Down then Enter -> Always allow",
	"",
	"The demo performs at most one send, reads the recipient journal once,",
	"prints stored=N and availability=offline, then exits.",
	"================================================================",
	"",
];
process.stdout.write(bootInstructions.join("\n"));

const mode = new InteractiveMode(
	session,
	dirs.VERSION,
	sender.setToolUIContext,
	undefined,
	sender.mcpManager,
	sender.eventBus,
	undefined,
	sender.subagentEventBus,
);
await mode.attachSessionSocket(undefined);
await mode.init({ suppressWelcomeIntro: true, clearInitialTerminalHistory: false, autoStartCollab: false });
await mode.renderInitialMessages({ preserveExistingChat: true });
mode.showStatus(`${START_MARKER}: type "${TYPED_PROMPT}" then Enter`);
process.stderr.write(bootInstructions.join("\n") + "\n");
mode.ui.requestRender(true);

const inputLoop = (async () => {
	for (;;) {
		const input = await mode.getUserInput();
		await submitInteractiveInput(mode, session, input);
	}
})();
inputLoop.catch(() => {});

let mailToolResult = "";
let sendStatus: unknown;
let refusalCode: unknown;
let timedOut = false;
const mailToolEnded = Promise.withResolvers<void>();
const deadline = setTimeout(() => {
	timedOut = true;
	mailToolEnded.resolve();
}, APPROVAL_DEADLINE_MS);
session.subscribe(event => {
	if (event.type !== "tool_execution_end" || event.toolName !== "agent_mail") return;
	const details: unknown = isRecord(event.result) ? event.result.details : undefined;
	if (isRecord(details) && details.op === "send" && isRecord(details.result)) {
		sendStatus = details.result.status;
		refusalCode = details.result.code;
	}
	const content: unknown = isRecord(event.result) ? event.result.content : undefined;
	mailToolResult = Array.isArray(content)
		? content.map(block => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join(" ")
		: "";
	mailToolEnded.resolve();
});

interface JournalMailFacts {
	stored: number;
	requests: number;
	messageIds: string[];
	senderHandles: string[];
	targetBootIdNull: boolean;
}

async function readJournalMail(): Promise<JournalMailFacts> {
	const manager = await SessionManager.open(recipientSessionFile);
	try {
		const facts: JournalMailFacts = { stored: 0, requests: 0, messageIds: [], senderHandles: [], targetBootIdNull: false };
		for (const entry of manager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== AGENT_MAIL_CUSTOM_TYPE) continue;
			const data: unknown = entry.data;
			if (!isRecord(data) || data.version !== 1) continue;
			if (data.state !== "stored" && data.state !== "admitted") continue;
			const mail = data.mail;
			if (!isRecord(mail) || !isRecord(mail.recipient) || !isRecord(mail.sender) || !isRecord(mail.target)) continue;
			if (mail.recipient.sessionId !== recipientSessionId) continue;
			if (mail.folder === "requests") {
				facts.requests += 1;
				continue;
			}
			facts.stored += 1;
			if (typeof mail.messageId === "string") facts.messageIds.push(mail.messageId);
			facts.senderHandles.push(typeof mail.sender.handle === "string" ? mail.sender.handle : "<unnamed>");
			facts.targetBootIdNull = mail.target.bootId === null;
		}
		return facts;
	} finally {
		await manager.close();
	}
}

await mailToolEnded.promise;
clearTimeout(deadline);
try {
	await Promise.race([session.waitForIdle(), Bun.sleep(10_000)]);
} catch {}

const recipient = await new NativeSessionService().resolve("games");
mode.stop();
await Bun.sleep(100);

const facts = await readJournalMail();
const approvalHostMissing = refusalCode === "mail_approval_required";
const accepted = sendStatus === "accepted" && facts.stored === 1 && facts.targetBootIdNull;
const cancelled = sendStatus === "refused" && refusalCode === "mail_approval_cancelled" && facts.stored === 0;
const ok = !timedOut && recipient.availability === "offline" && facts.requests === 0 && (accepted || cancelled);
const note = timedOut
	? "no mail tool settlement before the deadline"
	: facts.stored === 1
		? "one record stored after the local consent choice"
		: "zero records after a cancel/refusal";
const report = [
	"",
	"================ MAIL CONSENT DEMO RESULT ================",
	`stored=${facts.stored}`,
	`requests=${facts.requests}`,
	`recipient=games ${recipient.sessionId}`,
	`availability=${recipient.availability}`,
	`target_boot_id_null=${facts.targetBootIdNull}`,
	`sender=${facts.senderHandles.join(",") || "<none>"}`,
	`message_ids=${facts.messageIds.join(",") || "<none>"}`,
	`tool_result=${mailToolResult.replace(/\s+/g, " ").trim().slice(0, 300) || "<none>"}`,
	`warning=${approvalHostMissing ? "no approval host armed this submission" : "<none>"}`,
	`note=${note}`,
	`exit=${ok ? 0 : 1}`,
	`demo_root=${demoRoot}`,
	`cleanup=${keep ? "kept (MAIL_CONSENT_DEMO_KEEP=1)" : "removed automatically"}`,
	"==========================================================",
	"",
].join("\n");
process.stdout.write(report);
await Bun.sleep(50);

await session.dispose().catch(() => {});
authStorage.close();
AgentStorage.close();
HistoryStorage.close();
closeSessionIndex();
process.exit(ok ? 0 : 1);
