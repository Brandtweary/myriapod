// Shared regex-construction helpers for interpolating a runtime-computed
// string into a pattern. Extracted here because the same edge-aware
// word-boundary fix was independently needed by stt-lexicon.ts and kg/graph.ts.

export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHAR_RE = /\w/;

function isWordChar(ch: string): boolean {
	return ch.length > 0 && WORD_CHAR_RE.test(ch);
}

/**
 * The (leading, trailing) zero-width assertions that stand in for a bare
 * `\b` around a runtime-computed key.
 *
 * `\b` asserts a transition between a `\w` char and a non-`\w` char, which is
 * the right test only when the edge it guards IS a word character. When the
 * key's edge is punctuation (plausible for anything derived from speech —
 * an STT garble, a user-entered term), `\b` inverts: it fires mid-token where
 * it shouldn't and refuses to fire exactly at a legitimate punctuation-bounded
 * edge (e.g. sentence-final). `(?<!\w)` / `(?!\w)` do not have that failure
 * mode — each degrades to no assertion at all once the edge is punctuation,
 * never an inverted one — so the guard is applied only when the edge is a
 * word character, and omitted otherwise.
 */
export function boundaryAssertions(key: string): [string, string] {
	const lead = isWordChar(key[0]) ? "(?<!\\w)" : "";
	const trail = isWordChar(key[key.length - 1]) ? "(?!\\w)" : "";
	return [lead, trail];
}
