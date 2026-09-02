import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import envelope from "./envelope.md" with { type: "text" };
import { HANDOFF_CONTRACT_FILENAME, type HotHandoffActivation, type HotHandoffContract } from "./types";

const HANDOFF_DIR = ".omp";

export function projectHandoffPath(cwd: string): string {
	return path.join(cwd, HANDOFF_DIR, HANDOFF_CONTRACT_FILENAME);
}

export function hashHandoffPrompt(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function isBlank(text: string): boolean {
	return text.trim().length === 0;
}

export function wrapHandoffPrompt(projectContract: string): string {
	return `${envelope.trim()}\n\n${projectContract.trim()}\n`;
}

export async function loadHotHandoffActivation(cwd: string): Promise<HotHandoffActivation> {
	const contractPath = projectHandoffPath(cwd);
	try {
		const text = await Bun.file(contractPath).text();
		if (isBlank(text)) {
			return { cwd, contract: undefined, disabledReason: "empty" };
		}
		const contract: HotHandoffContract = {
			path: contractPath,
			text,
			hash: hashHandoffPrompt(text),
		};
		return { cwd, contract };
	} catch (err) {
		if (isEnoent(err)) {
			return { cwd, contract: undefined, disabledReason: "missing" };
		}
		throw err;
	}
}
