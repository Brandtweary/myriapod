// Seed extraction — port of server.py extract_seed_labels.
//
// DIVERGENCE (accepted): Python uses nltk.word_tokenize + nltk.pos_tag and keeps
// only NN/VB/JJ tags minus _POS_STOPWORDS. We can't POS-tag in the browser, so we
// approximate "content words" by dropping SEED_STOPWORDS (POS_STOPWORDS ∪ NLTK
// english stopwords) from \w+ tokens. The bigram/trigram phrase matching is kept
// verbatim — it's load-bearing (without it ~53% of queries get no seeds).

import { depluralize, stemWord, tokenize } from "./stem";
import { SEED_STOPWORDS } from "./stopwords";
import type { Graph } from "./graph";

export function extractSeedLabels(text: string, graph: Graph): string[] {
	if (!text.trim()) return [];

	// POS approximation: content words = non-stopword tokens, in order.
	const contentWords = tokenize(text).filter((w) => !SEED_STOPWORDS.has(w));

	const matchedIds = new Set<string>();

	for (const word of contentWords) {
		// Word + depluralized form against exact labels, so a spoken S-plural
		// still seeds the singular node.
		for (const variant of new Set([word.toLowerCase(), depluralize(word)])) {
			const tid = graph.labelIndex.get(variant);
			if (tid) matchedIds.add(tid);
		}
		const stemmed = stemWord(word);
		const ids = graph.stemIndex.get(stemmed);
		if (ids) for (const id of ids) matchedIds.add(id);
	}

	// Multi-word phrases: bigrams and trigrams, hyphen- and space-joined.
	for (const n of [2, 3]) {
		for (let i = 0; i <= contentWords.length - n; i++) {
			const window = contentWords.slice(i, i + n);
			// Raw + depluralized windows ("knowledge graphs" -> "knowledge graph").
			const variants = [
				window.map((w) => w.toLowerCase()),
				window.map((w) => depluralize(w)),
			];
			for (const wordsVariant of variants) {
				for (const joiner of ["-", " "]) {
					const tid = graph.labelIndex.get(wordsVariant.join(joiner));
					if (tid) matchedIds.add(tid);
				}
			}
			const stemmedPhrase = window.map((w) => stemWord(w)).join("-");
			const ids = graph.stemIndex.get(stemmedPhrase);
			if (ids) for (const id of ids) matchedIds.add(id);
		}
	}

	const labels: string[] = [];
	for (const tid of matchedIds) {
		const t = graph.thoughts.get(tid);
		if (t && !graph.isLink(t)) labels.push(t.label);
	}
	return labels;
}
