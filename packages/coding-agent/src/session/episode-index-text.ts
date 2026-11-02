/**
 * Plain-text episode index for the snapcompact summary's EPISODES section.
 *
 * The section is orientation: which runs led here, what prompted them, and how
 * they settled. It is assembled here, in the coding agent — snapcompact takes
 * it as an option string, so the package never learns about sessions or
 * episode rows.
 */
import type { SessionEpisode } from "./session-index";

const MAX_EPISODES = 12;
const TRIGGER_MAX = 120;
const RECAP_MAX = 160;
const TARGETS_MAX = 200;

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The newest episodes as one bounded line each, oldest first; undefined when there are none. */
export function formatEpisodeIndex(episodes: readonly SessionEpisode[]): string | undefined {
	if (episodes.length === 0) return undefined;
	return episodes
		.slice(-MAX_EPISODES)
		.map(episode => {
			const fields = [
				`- ${episode.episodeId}`,
				new Date(episode.startedAtMs).toISOString(),
				episode.outcome,
				`${episode.stepCount} ${episode.stepCount === 1 ? "step" : "steps"}`,
			];
			const label = episode.focusTitle ?? episode.triggerSummary;
			if (label) fields.push(oneLine(label, TRIGGER_MAX));
			if (episode.focusTitle && episode.triggerSummary) {
				fields.push(`trigger: ${oneLine(episode.triggerSummary, TRIGGER_MAX)}`);
			}
			if (episode.recap) fields.push(`recap: ${oneLine(episode.recap, RECAP_MAX)}`);
			if (episode.toolTargets) fields.push(`tools: ${oneLine(episode.toolTargets, TARGETS_MAX)}`);
			return fields.join(" · ");
		})
		.join("\n");
}
