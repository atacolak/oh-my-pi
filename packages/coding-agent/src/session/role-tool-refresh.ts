import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";

/** Startup role snapshot. Operator tool changes belong to the bound conversation. */
export interface RootAgentToolProfile {
	readonly filePath: string;
	readonly source: AgentSource;
	readonly name: string;
	readonly toolNames: readonly string[];
}
