import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { consumeSessionOwnerContext, sessionOwnerContext } from "@oh-my-pi/pi-coding-agent/launch/session-owner";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { createOrOpenSessionIdentity, assignSessionIdentity } from "@oh-my-pi/pi-coding-agent/session/session-identity";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

consumeSessionOwnerContext(process.env);
if (!sessionOwnerContext()) throw new Error("Fixture must be launched by the native terminal broker");
const cwd = process.cwd();
const sessionsRoot = path.join(cwd, "sessions");
const opened = await createOrOpenSessionIdentity({
	cwd,
	actorHandle: "idle-fixture",
	rootAgent: "idle-probe",
	catalog: { sessionsRoot },
});
const manager = opened.manager;
manager.appendMessage({ role: "user", content: "retain this conversation", timestamp: 1 });
await manager.flush();
await assignSessionIdentity(manager, { idleSleepSeconds: 1 }, { sessionsRoot });
await initTheme();
await Settings.init({ inMemory: true, cwd });
const auth = await AuthStorage.create(":memory:");
const model = createMockModel({
	handler: () => {
		throw new Error("Idle retirement must not invoke a provider");
	},
});
const { session } = await createAgentSession({
	cwd,
	agentDir: path.join(cwd, "agent"),
	authStorage: auth,
	modelRegistry: new ModelRegistry(auth, path.join(cwd, "models.yml"), { ignoreLocalModelConfig: true }),
	model: model.model,
	sessionManager: manager,
	settings: Settings.isolated({
		"compaction.enabled": false,
		"composer.predictions": false,
		"recap.enabled": false,
		"memory.backend": "off",
	}),
	disableExtensionDiscovery: true,
	enableMCP: false,
	enableLsp: false,
	skills: [],
	contextFiles: [],
	rules: [],
	promptTemplates: [],
	slashCommands: [],
	deferSkillDescriptionCompression: true,
	cacheWarming: false,
});
const mode = new InteractiveMode(session, "automatic idle sleep fixture");
await mode.init({ suppressWelcomeIntro: true });
mode.editor.setText("retain this unsent draft");
await manager.saveDraft("retain this unsent draft");
const endpointDir = path.join(cwd, "run");
await mode.attachSessionSocket(createAgentSessionSocket(session, { endpointDir }));
await mode.detachForHangup();
await Bun.write(
	path.join(cwd, "idle-publication.json"),
	JSON.stringify({
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		socketPath: path.join(endpointDir, `${session.sessionId}.sock`),
	}),
);
session.recordIdleActivity();
await Promise.withResolvers<void>().promise;
