// Porter stemming utilities. Uses the `stemmer` npm package (original Porter
// 1980). Term-match is largely unaffected by stemmer choice since most nodes are
// no_stem.

import { stemmer } from "stemmer";

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const PUNCT_SET = new Set(PUNCT.split(""));

// word.lower().strip(punctuation) — strip leading/trailing punct.
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

// depluralize — the ONE normalization applied unconditionally
// in term/seed matching (independent of the per-node no_stem Porter opt-in, which
// defaults to exact). Conservative: leaves non-plurals alone. Spoken S-plurals
// ("term stores") still find the singular label ("term-store").
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

// Tokenize on word boundaries: lowercase, then runs of Unicode letters/digits
// plus `_`. Unicode-aware so accented/non-ASCII single-word terms (café, São)
// survive as whole tokens rather than being split on the accent.
export function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function stemText(text: string): string {
	return tokenize(text)
		.map((tok) => stemmer(tok))
		.join(" ");
}
