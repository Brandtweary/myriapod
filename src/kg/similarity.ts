// Similarity primitives for mint-time dedup: Jaro-Winkler string similarity
// over labels/aliases, cosine over stored description embeddings. The
// similar_terms pipeline tool unions both candidate sets (the same dual-
// candidate scheme the string+semantic dedup precompute used).

import type { Graph } from "./graph";
import type { Thought } from "./types";

export function jaroWinkler(s1: string, s2: string): number {
	if (s1 === s2) return 1;
	const len1 = s1.length;
	const len2 = s2.length;
	if (!len1 || !len2) return 0;

	const matchWindow = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
	const m1 = new Array<boolean>(len1).fill(false);
	const m2 = new Array<boolean>(len2).fill(false);

	let matches = 0;
	for (let i = 0; i < len1; i++) {
		const lo = Math.max(0, i - matchWindow);
		const hi = Math.min(i + matchWindow + 1, len2);
		for (let j = lo; j < hi; j++) {
			if (m2[j] || s1[i] !== s2[j]) continue;
			m1[i] = true;
			m2[j] = true;
			matches++;
			break;
		}
	}
	if (!matches) return 0;

	let transpositions = 0;
	let k = 0;
	for (let i = 0; i < len1; i++) {
		if (!m1[i]) continue;
		while (!m2[k]) k++;
		if (s1[i] !== s2[k]) transpositions++;
		k++;
	}
	const jaro =
		(matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

	// Winkler prefix boost (standard p=0.1, prefix cap 4).
	let prefix = 0;
	for (let i = 0; i < Math.min(4, len1, len2); i++) {
		if (s1[i] === s2[i]) prefix++;
		else break;
	}
	return jaro + prefix * 0.1 * (1 - jaro);
}

export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || !a.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom ? dot / denom : 0;
}

export interface SimilarCandidate {
	term: Thought;
	stringScore: number; // best JW over label + aliases
	semanticScore: number | null; // cosine over embeddings (null when unavailable)
}

const JW_THRESHOLD = 0.87;
const COSINE_THRESHOLD = 0.6;
const MAX_CANDIDATES = 8;

/** Union of string-similar and semantically-similar terms for a candidate
 *  label/description. `queryEmbedding` null → string-only (embed endpoint
 *  unreachable or the text hasn't been embedded). Excludes an exact label match
 *  (that's an upsert, not a duplicate). */
export function findSimilarTerms(
	graph: Graph,
	label: string,
	queryEmbedding: number[] | null,
): SimilarCandidate[] {
	const q = label.trim().toLowerCase();
	const out = new Map<string, SimilarCandidate>();

	for (const t of graph.thoughts.values()) {
		if (t.label.toLowerCase() === q) continue;
		let stringScore = jaroWinkler(q, t.label.toLowerCase());
		for (const a of t.aliases) {
			stringScore = Math.max(stringScore, jaroWinkler(q, a));
		}
		const semanticScore =
			queryEmbedding && t.embedding && t.embedding.length
				? cosineSimilarity(queryEmbedding, t.embedding)
				: null;
		if (stringScore >= JW_THRESHOLD || (semanticScore !== null && semanticScore >= COSINE_THRESHOLD)) {
			out.set(t.id, { term: t, stringScore, semanticScore });
		}
	}

	return [...out.values()]
		.sort(
			(a, b) =>
				Math.max(b.stringScore, b.semanticScore ?? 0) - Math.max(a.stringScore, a.semanticScore ?? 0),
		)
		.slice(0, MAX_CANDIDATES);
}
