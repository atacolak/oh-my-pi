/**
 * Hindsight settings declare `HINDSIGHT_*` variables that override every configured layer, so an
 * ambient operator configuration (for example `HINDSIGHT_AUTO_RETAIN=false` in a host that retains
 * out-of-process) silently changes what the hindsight suites exercise. Clear those variables around
 * a test so the assertion covers the code path it names, and restore the operator's values after.
 */

/** Restores the environment snapshot captured by {@link isolateHindsightEnv}. */
export type RestoreHindsightEnv = () => void;

const HINDSIGHT_PREFIX = "HINDSIGHT_";

/** Delete every `HINDSIGHT_*` variable and return a disposer that puts the previous values back. */
export function isolateHindsightEnv(): RestoreHindsightEnv {
	const saved = new Map<string, string>();
	for (const key of Object.keys(Bun.env)) {
		if (!key.startsWith(HINDSIGHT_PREFIX)) continue;
		const value = Bun.env[key];
		if (value === undefined) continue;
		saved.set(key, value);
		delete Bun.env[key];
	}
	return () => {
		for (const key of Object.keys(Bun.env)) {
			if (key.startsWith(HINDSIGHT_PREFIX) && !saved.has(key)) delete Bun.env[key];
		}
		for (const [key, value] of saved) Bun.env[key] = value;
	};
}
