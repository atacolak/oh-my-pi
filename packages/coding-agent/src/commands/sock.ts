import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sockHelp } from "../cli/command-help";
import { runSockCommand } from "../cli/sock-cli";

export default class Sock extends Command {
	static description = sockHelp.description;
	static args = {
		action: Args.string({
			required: false,
			description:
				"list, status, context, where, name, rename, read, open, wake, attach, stop, abort, sleep, compact, restart, kill, raw, tap",
		}),
		target: Args.string({ required: false, description: "Saved name, full session UUID or unique UUID prefix" }),
		value: Args.string({
			required: false,
			description: "New native name, raw JSON command, or open destination (transcript/profile/folder)",
		}),
	};
	static flags = {
		json: Flags.boolean({ description: "Emit machine-readable JSON" }),
		all: Flags.boolean({ description: "Show every unnamed session instead of only the eight most recent" }),
		live: Flags.boolean({ description: "List only owners that prove their native session identity" }),
		query: Flags.string({ description: "Filter the native session catalog" }),
		pid: Flags.integer({ description: "Select a native session by its currently published owner PID" }),
		lines: Flags.integer({ char: "n", description: "Number of recent messages to read (default 40)" }),
		full: Flags.boolean({ description: "Read the full display transcript" }),
		follow: Flags.boolean({ char: "f", description: "Follow a live session without waking it; Ctrl-C detaches" }),
		compact: Flags.boolean({ description: "Compact before an admitted restart" }),
		graceful: Flags.boolean({
			description: "Ask the model to checkpoint, then restart after it acknowledges and all owned work settles",
		}),
		force: Flags.boolean({
			description:
				"Request force explicitly; unsupported force operations refuse. Kill always terminates the verified process.",
		}),
		mode: Flags.string({ description: "Compaction mode", options: ["soft", "remote", "snapcompact"] }),
	};
	static examples = [
		"omp sock list --json",
		"omp sock status atlas",
		"omp sock context atlas --json",
		"omp sock name atlas repository-owner",
		"omp sock wake atlas",
		"omp sock attach atlas",
		"omp sock read atlas -n 40",
		"omp sock stop --pid 12345",
		"omp sock sleep atlas",
		"omp sock restart atlas --compact",
		"omp sock restart atlas --graceful --compact",
		"omp sock kill --pid 12345",
	];
	async run(): Promise<void> {
		const { args, flags } = await this.parse(Sock);
		try {
			await runSockCommand({ action: args.action ?? "list", target: args.target, value: args.value, ...flags });
		} catch (error) {
			const message = sanitizeText(replaceTabs(error instanceof Error ? error.message : String(error)));
			process.stderr.write(`Error: omp sock: ${message}\n`);
			process.exitCode = 2;
		}
	}
}
