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
const TITLE_MAX = 120;
const TRIGGER_MAX = 120;
const RECAP_MAX = 160;
const TARGETS_MAX = 200;

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function episodeLine(episode: SessionEpisode): string {
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
}

/**
 * The newest episodes as one bounded line each, oldest first, with a chapter
 * header (`### <focus title>`) whenever consecutive episodes share a title.
 *
 * Grouping is by adjacency, not by title lookup: a title that returns later is
 * a new chapter, because the arc in between is what separates them. The title
 * is a retrieval key, so the header carries it verbatim (bounded, never
 * paraphrased).
 */
export function formatEpisodeIndex(episodes: readonly SessionEpisode[]): string | undefined {
	if (episodes.length === 0) return undefined;
	const out: string[] = [];
	let chapter: string | null = null;
	for (const episode of episodes.slice(-MAX_EPISODES)) {
		if (episode.focusTitle !== chapter) {
			chapter = episode.focusTitle;
			if (chapter) out.push(`### ${oneLine(chapter, TITLE_MAX)}`);
		}
		out.push(episodeLine(episode));
	}
	return out.join("\n");
}
