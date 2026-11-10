import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import restartDescription from "../../prompts/tools/runtime-restart.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import type { RpcUpgradeRuntimeResult } from "./rpc-types";

const parameters = type({ request: type("string > 0").describe("request id from the restart notice") });

export interface RuntimeRestartOptions {
	graceful?: boolean;
	compactBeforeRestart?: boolean;
}

/** Acknowledges an existing owner request; never chooses or launches an owner. */
export class ModelRuntimeUpgrade {
	#binding: { session: AgentSession; acknowledge: (request: string) => RpcUpgradeRuntimeResult } | undefined;

	readonly tool: CustomTool<typeof parameters, RpcUpgradeRuntimeResult> = {
		name: "upgrade_runtime",
		label: "restart",
		description: restartDescription,
		parameters,
		loadMode: "essential",
		execute: async (_id, params, _update, ctx, signal) => {
			signal?.throwIfAborted();
			const binding = this.#binding;
			if (
				!binding ||
				!this.isMounted(binding.session) ||
				ctx.sessionManager.getSessionId() !== binding.session.sessionId ||
				ctx.sessionManager.getSessionFile() !== binding.session.sessionFile
			) {
				throw new Error("no native restart request is available for this conversation");
			}
			const result = binding.acknowledge(params.request);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};

	isMounted(session: AgentSession): boolean {
		return (
			session.getToolByName(this.tool.name)?.parameters === parameters &&
			session.getEnabledToolNames().includes(this.tool.name)
		);
	}

	bind(session: AgentSession, acknowledge: (request: string) => RpcUpgradeRuntimeResult): () => void {
		const binding = { session, acknowledge };
		this.#binding = binding;
		return () => {
			if (this.#binding === binding) this.#binding = undefined;
		};
	}
}
