import type { KnowledgeNode } from "./client";

export function flattenKnowledgeTree(roots: readonly KnowledgeNode[]): KnowledgeNode[] {
	const out: KnowledgeNode[] = [];
	const walk = (nodes: readonly KnowledgeNode[]) => {
		for (const node of nodes) {
			out.push(node);
			if (node.children?.length) walk(node.children);
		}
	};
	walk(roots);
	return out;
}

/** Mental-model ids that back Knowledge Pages and must not be boot-injected. */
export function knowledgePageBackingModelIds(roots: readonly KnowledgeNode[]): Set<string> {
	const ids = new Set<string>();
	for (const node of flattenKnowledgeTree(roots)) {
		if (node.kind === "page" && node.mental_model_id) ids.add(node.mental_model_id);
	}
	return ids;
}
