/**
 * Agent frontmatter `tools:` / `mcps:` as a flat list or `{ eager, discoverable }`.
 *
 * Flat lists keep each name's default loadMode. Maps override presentation:
 * eager → essential (top-level schema), discoverable → xd://.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { normalizeToolNames } from "../tools/builtin-names";

export type NamedLoadSet = {
	/** True when the field was present, including an empty list. */
	declared: boolean;
	names: string[];
	eager: string[];
	discoverable: string[];
};

function asStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim());
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map(item => item.trim())
			.filter(Boolean);
	}
	return [];
}

function unique(names: string[]): string[] {
	return [...new Set(names)];
}

/**
 * Parse `tools:` or `mcps:`. `undefined` means the field was absent.
 * `normalize` applies built-in tool alias folding (`search` → `grep`, …).
 */
export function parseNamedLoadSet(
	value: unknown,
	opts: { agent: string; field: "tools" | "mcps"; normalize: boolean },
): NamedLoadSet | undefined {
	if (value == null) return undefined;
	const fold = (names: string[]): string[] => (opts.normalize ? normalizeToolNames(names) : unique(names));

	if (typeof value === "object" && !Array.isArray(value)) {
		const bag = value as Record<string, unknown>;
		const eager = fold(asStringList(bag.eager));
		const discoverable = fold(asStringList(bag.discoverable));
		const names = unique([...eager, ...discoverable]);
		if (names.length === 0 && eager.length === 0 && discoverable.length === 0) {
			logger.warn("Agent tools declaration names no tools; using an empty built-in allowlist", {
				agent: opts.agent,
				field: opts.field,
				valueType: "map",
			});
		}
		return { declared: true, names, eager, discoverable };
	}

	const names = fold(asStringList(value));
	if (names.length === 0 && !(Array.isArray(value) && value.length === 0) && value !== "") {
		const valueType = Array.isArray(value) ? "array" : typeof value;
		logger.warn("Agent tools declaration names no tools; using an empty built-in allowlist", {
			agent: opts.agent,
			field: opts.field,
			valueType,
		});
	}
	return { declared: true, names, eager: [], discoverable: [] };
}

/** Effective loadMode for one name given an agent's maps. Undefined = keep the tool default. */
export function loadModeOverride(set: NamedLoadSet | undefined, name: string): "essential" | "discoverable" | undefined {
	if (!set) return undefined;
	if (set.eager.includes(name)) return "essential";
	if (set.discoverable.includes(name)) return "discoverable";
	return undefined;
}

export function mcpServerAllowed(set: NamedLoadSet | undefined, serverName: string): boolean {
	if (!set?.declared) return true;
	if (set.names.length === 0) return false;
	return set.names.includes(serverName);
}
