// The speech-adaptation half of the lexicon: the mistranscription log and the
// auto-replace rules, persisted in IndexedDB and exported alongside the term
// glossary. Auto-replace rules rewrite Whisper transcripts client-side BEFORE
// they reach the display or the model — the same one-way mechanism as the
// harness's config.toml replacements, which is exactly why the audit agent's
// rules for creating them are conservative.

export interface MistranscriptionEntry {
	spoken: string; // what the user actually said
	transcribed: string; // what Whisper wrote
	kind: "phonetic" | "semantic" | "persistent_near_miss";
	notes?: string;
	ts: string;
}

export interface AutoReplaceRule {
	from: string; // the mistranscribed phrase (matched case-insensitively, whole-phrase)
	to: string; // the correct phrase
	ts: string;
}

export interface SttLexicon {
	mistranscriptions: MistranscriptionEntry[];
	autoReplace: AutoReplaceRule[];
}

export function emptySttLexicon(): SttLexicon {
	return { mistranscriptions: [], autoReplace: [] };
}

/** Count of logged occurrences of a (spoken, transcribed) pair — the signal the
 *  audit agent uses for the persistent-miss ≥2 → alias escalation. */
export function mistranscriptionCount(lex: SttLexicon, spoken: string, transcribed: string): number {
	const s = spoken.trim().toLowerCase();
	const t = transcribed.trim().toLowerCase();
	return lex.mistranscriptions.filter(
		(m) => m.spoken.trim().toLowerCase() === s && m.transcribed.trim().toLowerCase() === t,
	).length;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Apply every auto-replace rule to a fresh transcript (case-insensitive,
 *  whole-phrase word-boundary match). Voice turns only — typed input is the
 *  user's own keystrokes and is never rewritten. */
export function applyAutoReplace(text: string, rules: AutoReplaceRule[]): string {
	let out = text;
	for (const r of rules) {
		if (!r.from.trim()) continue;
		const pattern = new RegExp(`\\b${escapeRegExp(r.from)}\\b`, "gi");
		out = out.replace(pattern, r.to);
	}
	return out;
}
