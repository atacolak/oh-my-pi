/** Root-session idle sleep policy: actor metadata wins over settings (`session.idleSleepSeconds`). */
import { register } from "../config/registry";
import type { Settings } from "../config/settings";

export const cfgSessionIdleSleepSeconds = register({
	id: "session.idleSleepSeconds",
	type: "number",
	default: 3600,
	validate: raw => {
		if (raw !== undefined && raw !== null) validateIdleSleepSeconds(raw);
	},
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Idle Session Sleep",
		description:
			"Sleep detached session owners after this many idle seconds; zero disables. Actor overrides take precedence.",
		options: [
			{ value: "0", label: "Off" },
			{ value: "900", label: "15 minutes" },
			{ value: "1800", label: "30 minutes" },
			{ value: "3600", label: "1 hour" },
			{ value: "7200", label: "2 hours" },
		],
	},
});

export function validateIdleSleepSeconds(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`Invalid session.idleSleepSeconds: expected a nonnegative whole number of seconds, got ${Bun.inspect(value)}.`,
		);
	}
	return value;
}

export function applyAgentIdleSleepPolicy(settings: Settings, seconds: number | undefined): void {
	if (seconds !== undefined) cfgSessionIdleSleepSeconds.override(settings, seconds);
}

export function getSessionIdleSleepSeconds(
	settings: Settings,
	metadata?: { idleSleepSeconds?: number | null },
): number {
	const override = metadata?.idleSleepSeconds;
	return override === undefined || override === null ? cfgSessionIdleSleepSeconds.get(settings) : override;
}
