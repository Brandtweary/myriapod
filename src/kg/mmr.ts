// MMR diversity rerank — port of server.py mmr_rerank_triples + _cosine_sim_scalar.
// Greedy Maximal Marginal Relevance: each triple's embedding is the centroid of
// its subject+object MiniLM vectors; PPR weights are min-max normalized to [0,1]
// so lambda is scale-invariant. No query embedding — relevance is the PPR score,
// diversity is cosine to already-picked triples. Missing embedding => sim 0.

import type { Triple } from "./types";

function cosineSim(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	na = Math.sqrt(na);
	nb = Math.sqrt(nb);
	if (na === 0 || nb === 0) return 0;
	return dot / (na * nb);
}

export function mmrRerankTriples(
	triples: Triple[],
	nodeEmbeddings: Map<string, number[]>,
	labelIndex: Map<string, string>,
	topK: number,
	lambda: number,
): Triple[] {
	const n = triples.length;
	if (n <= topK || topK <= 0) return triples;

	// Triple centroid embedding from subject + object node vectors.
	const tripleEmb = (t: Triple): number[] | null => {
		const sId = labelIndex.get(t.subject.toLowerCase());
		const oId = labelIndex.get(t.object.toLowerCase());
		const sEmb = sId ? nodeEmbeddings.get(sId) : undefined;
		const oEmb = oId ? nodeEmbeddings.get(oId) : undefined;
		if (!sEmb && !oEmb) return null;
		if (!sEmb) return oEmb!;
		if (!oEmb) return sEmb;
		return sEmb.map((v, i) => (v + oEmb[i]) / 2.0);
	};

	const embs = triples.map(tripleEmb);
	const weights = triples.map((t) => t.weight);

	const wMin = Math.min(...weights);
	const wMax = Math.max(...weights);
	const span = wMax - wMin;
	const rels = span > 0 ? weights.map((w) => (w - wMin) / span) : weights.map(() => 1.0);

	const picked: number[] = [];
	const remaining: number[] = triples.map((_, i) => i);
	const maxSim = new Array(n).fill(0);

	while (picked.length < topK && remaining.length) {
		if (picked.length) {
			const last = picked[picked.length - 1];
			const lastEmb = embs[last];
			if (lastEmb) {
				for (const i of remaining) {
					const ei = embs[i];
					if (!ei) continue;
					const sim = cosineSim(ei, lastEmb);
					if (sim > maxSim[i]) maxSim[i] = sim;
				}
			}
		}

		let bestScore = -Infinity;
		let bestIdx = remaining[0];
		for (const i of remaining) {
			const score = lambda * rels[i] - (1.0 - lambda) * maxSim[i];
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		picked.push(bestIdx);
		remaining.splice(remaining.indexOf(bestIdx), 1);
	}

	return picked.map((i) => triples[i]);
}
