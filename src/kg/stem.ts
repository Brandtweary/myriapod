// Porter stemming utilities — port of cymbiont/cymbiont/kg/stemming.py.
//
// Python uses NLTK's PorterStemmer (NLTK_EXTENSIONS mode). We use the `stemmer`
// npm package (original Porter 1980). Measured divergence on the real corpus
// (scripts/goldens, 387 tokens): 2 differ — both the terminal-"y" rule where
// NLTK keeps "...ay" but original Porter writes "...ai" (e.g. replay→replai).
// term_match is unaffected (18/18 golden match) since most nodes are no_stem.
// If Stage B seed-testing shows this matters, vendor NLTK's exact stemmer.

import { stemmer } from "stemmer";

// Python: string.punctuation
const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const PUNCT_SET = new Set(PUNCT.split(""));

// Python: word.lower().strip(string.punctuation) — strip leading/trailing punct.
function cleanWord(word: string): string {
	let s = word.toLowerCase();
	let start = 0;
	let end = s.length;
	while (start < end && PUNCT_SET.has(s[start])) start++;
	while (end > start && PUNCT_SET.has(s[end - 1])) end--;
	return s.slice(start, end);
}

export function stemWord(word: string): string {
	return stemmer(cleanWord(word));
}

// Port of stemming.py depluralize — the ONE normalization applied unconditionally
// in term/seed matching (independent of the per-node no_stem Porter opt-in, which
// defaults to exact). Conservative: leaves non-plurals alone. Spoken S-plurals
// ("knowledge graphs") still find the singular label ("knowledge-graph").
export function depluralize(word: string): string {
	const w = word.toLowerCase();
	if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
	if (
		w.length > 4 &&
		w.endsWith("es") &&
		["s", "x", "z", "ch", "sh"].some((suf) => w.slice(0, -2).endsWith(suf))
	) {
		return w.slice(0, -2);
	}
	if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
	return w;
}

// Python: re.findall(r"\b\w+\b", text.lower()). \w is [A-Za-z0-9_].
export function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

export function stemText(text: string): string {
	return tokenize(text)
		.map((tok) => stemmer(tok))
		.join(" ");
}
