/** Profile skill visibility. Omitted discoverable preserves the discovered catalog; [] closes it. */
export interface SkillLoadPolicy {
	eager: string[];
	discoverable?: string[];
}

/** Select by canonical discovered name; eager skills remain readable even in a closed catalog. */
export function selectSkills<T extends { name: string }>(skills: T[], policy?: SkillLoadPolicy): T[] {
	if (policy?.discoverable === undefined) return skills;
	const allowed = new Set([...policy.eager, ...policy.discoverable]);
	const selected = skills.filter(skill => allowed.has(skill.name));
	return selected.length === skills.length ? skills : selected;
}
