import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { getRpcRuntimeRestartReceipt } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-refresh-preflight";
import { createAgentSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

await initTheme();
await Settings.init({ inMemory: true, cwd: process.cwd() });
const auth = await AuthStorage.create(":memory:");
const registry = new ModelRegistry(auth, path.join(process.cwd(), "models.yml"), { ignoreLocalModelConfig: true });
const model = createMockModel({ handler: { content: ["unused"] } });
const manager = SessionManager.create(process.cwd(), path.join(process.cwd(), "sessions"));
manager.appendMessage({ role: "user", content: "preserve this conversation", timestamp: 1 });
await manager.ensureOnDisk();
const { session } = await createAgentSession({
	cwd: process.cwd(),
	agentDir: path.join(process.cwd(), "agent"),
	authStorage: auth,
	modelRegistry: registry,
	model: model.model,
	sessionManager: manager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
});
const mode = new InteractiveMode(session, "owner exit fixture");
mode.ui.requestRender = () => {};
mode.ui.terminal.drainInput = async () => {};
const endpointDir = path.join(process.cwd(), "run");
await mode.attachSessionSocket(createAgentSessionSocket(session, { endpointDir }));
const receipt = await getRpcRuntimeRestartReceipt(session);
if (!receipt) throw new Error("fixture lacks an owned journal");
process.stdout.write(
	`${JSON.stringify({ ...receipt, socketPath: path.join(endpointDir, `${session.sessionId}.sock`) })}\n`,
);
await Promise.withResolvers<void>().promise;
