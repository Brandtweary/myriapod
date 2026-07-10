// Top-level retrieval orchestration — the keyword router: term-match, ledger
// dedup, term cap, <memory> formatting.
//
// Returns BOTH:
//   - vacuum: the full per-turn retrieval (pre-ledger-dedup) for the gutter
//     display — the deliberate "small lie" where the panel shows everything that
//     WOULD retrieve this turn even if some was deduped out of the injection.
//   - injectionBlock: the ledger-deduped, capped, formatted <memory> string
//     for the LLM (null when nothing fresh).
// Committing the deduped survivors to the ledger is a side effect.

import { TERMS_PER_RETRIEVE } from "./config";
import type { Graph } from "./graph";
import type { InjectedLedger } from "./ledger";
import type { TermMatch } from "./types";

export interface RetrievalResult {
	vacuum: Vacuum;
	injectionBlock: string | null;
}

// Assemble the <memory> injection block that retrieve() appends to the agent's
// message history (the same accumulating-ledger path serves both voice and
// typed chat).
export function assembleMemoryContext(terms: TermMatch[]): string | null {
	if (!terms.length) return null;
	const p: string[] = ["<memory>", "## Term Descriptions"];
	for (const m of [...terms].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))) {
		p.push(`**${m.label}**: ${m.description}`);
	}
	p.push("</memory>");
	return p.join("\n");
}

export interface Vacuum {
	terms: TermMatch[];
}

// The raw per-turn retrieval (pre-ledger-dedup): term-match over the combined
// user + agent text. This is the "vacuum" — everything that WOULD retrieve
// this turn. retrieve() wraps it with per-session ledger dedup; the gutter
// renders the full vacuum.
export function retrieveVacuum(graph: Graph, userText: string, agentText = ""): Vacuum {
	const combined = agentText ? `${userText}\n${agentText}` : userText;
	const terms = graph.termMatch(combined);
	// Retrieval IS a hit: bump each matched term's hit_count + last_fired so the
	// hit_count-ranked orderings (the term cap here, memory_dump / memory_search in
	// kg-tools) reflect real usage instead of sorting all-zeros. The caller persists
	// the store after retrieval. (Mirrors the Python harness's retrieval-is-a-hit fix.)
	for (const m of terms) {
		const node = graph.get(m.label);
		if (node) graph.fire(node);
	}
	return { terms };
}

export function retrieve(
	graph: Graph,
	ledger: InjectedLedger,
	userText: string,
	agentText = "",
): RetrievalResult {
	const { terms: termMatches } = retrieveVacuum(graph, userText, agentText);

	// Vacuum set (pre-ledger-dedup) for the gutter.
	const vacuum = { terms: termMatches };

	// Injection: dedup against the per-session ledger.
	let freshTerms = termMatches.filter((m) => !ledger.hasTerm(`desc:${m.label}`));

	// Term cap (top-N by hit_count). Overflow is NOT committed to the ledger, so
	// a still-salient concept re-ships on a later turn.
	if (freshTerms.length > TERMS_PER_RETRIEVE) {
		freshTerms = [...freshTerms]
			.sort((a, b) => (b.hit_count ?? 0) - (a.hit_count ?? 0))
			.slice(0, TERMS_PER_RETRIEVE);
	}

	// Commit survivors so they won't ship again this session.
	for (const m of freshTerms) ledger.addTerm(`desc:${m.label}`);

	return { vacuum, injectionBlock: assembleMemoryContext(freshTerms) };
}
