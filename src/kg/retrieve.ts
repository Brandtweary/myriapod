// Top-level retrieval orchestration — port of the server /retrieve + /term-match
// pipeline AND retriever.py's post-processing (predicate-hierarchy dedup, per-head
// cap, doc-node cap, ledger dedup, term cap, <kg-context> formatting).
//
// Returns BOTH:
//   - vacuum: the full per-turn retrieval (pre-ledger-dedup) for the gutter
//     display — the deliberate "small lie" where the panels show everything that
//     WOULD retrieve this turn even if some was deduped out of the injection.
//   - injectionBlock: the ledger-deduped, capped, formatted <kg-context> string
//     for the LLM (null when nothing fresh).
// Committing the deduped survivors to the ledger is a side effect.

import {
	COMMUTATIVE_TYPES,
	MAX_DOC_NODES,
	MAX_TRIPLES_PER_HEAD,
	MMR_CANDIDATES,
	MMR_LAMBDA,
	TERMS_PER_RETRIEVE,
	TRIPLES_PER_RETRIEVE,
} from "./config";
import { extractSeedLabels } from "./seeds";
import { mmrRerankTriples } from "./mmr";
import { queryPpr } from "./ppr";
import type { Graph } from "./graph";
import type { InjectedLedger } from "./ledger";
import type { Clause, TermMatch, Triple } from "./types";

const OVERFETCH = Math.max(MMR_CANDIDATES, TRIPLES_PER_RETRIEVE);

// retriever.py PREDICATE_SHADOWS: relates-to is shadowed by ANY other predicate
// between the same ordered (subject, object).
const SHADOWED_BY_ANY = new Set(["relates-to"]);

export interface RetrievalResult {
	vacuum: { terms: TermMatch[]; triples: Triple[] };
	injectionBlock: string | null;
	seeds: string[];
}

const tripleKey = (t: Triple) => `${t.subject} --${t.predicate}--> ${t.object}`;

// retriever.py _dedup_predicate_hierarchy
function dedupPredicateHierarchy(triples: Triple[]): Triple[] {
	if (!triples.length) return triples;

	// Pass 1: predicate-hierarchy shadowing.
	const pairPredicates = new Map<string, Set<string>>();
	for (const t of triples) {
		const key = `${t.subject} ${t.object}`;
		let set = pairPredicates.get(key);
		if (!set) pairPredicates.set(key, (set = new Set()));
		set.add(t.predicate);
	}
	const pass1: Triple[] = [];
	for (const t of triples) {
		if (SHADOWED_BY_ANY.has(t.predicate)) {
			const others = new Set(pairPredicates.get(`${t.subject} ${t.object}`));
			others.delete(t.predicate);
			if (others.size > 0) continue; // shadowed by any other predicate
		}
		pass1.push(t);
	}

	// Pass 2: commutative duplicate dedup (keep first-encountered direction).
	const seen = new Set<string>();
	const pass2: Triple[] = [];
	for (const t of pass1) {
		if (COMMUTATIVE_TYPES.has(t.predicate)) {
			const key = `${t.predicate} ${[t.subject, t.object].sort().join(" ")}`;
			if (seen.has(key)) continue;
			seen.add(key);
		}
		pass2.push(t);
	}
	return pass2;
}

// retriever.py _cap_per_head (rank-preserving)
function capPerHead(triples: Triple[], cap: number): Triple[] {
	const counts = new Map<string, number>();
	const out: Triple[] = [];
	for (const t of triples) {
		const n = counts.get(t.subject) ?? 0;
		if (n >= cap) continue;
		counts.set(t.subject, n + 1);
		out.push(t);
	}
	return out;
}

function formatClauses(clauses?: Clause[]): string {
	if (!clauses || !clauses.length) return "";
	return " " + clauses.map((c) => `[${c.type.toUpperCase()}: ${c.text}]`).join(" ");
}

// retriever.py _assemble
function assemble(triples: Triple[], terms: TermMatch[]): string | null {
	if (!triples.length && !terms.length) return null;
	const p: string[] = ["<kg-context>"];
	if (terms.length) {
		p.push("## Term Descriptions");
		for (const m of [...terms].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))) {
			p.push(`**${m.label}**: ${m.description}`);
		}
		p.push("");
	}
	if (triples.length) {
		p.push("## Knowledge Graph");
		triples.forEach((t, i) => {
			p.push(`[${i + 1}] ${t.subject} --${t.predicate}--> ${t.object}${formatClauses(t.clauses)}`);
		});
	}
	p.push("</kg-context>");
	return p.join("\n");
}

export function retrieve(
	graph: Graph,
	ledger: InjectedLedger,
	userText: string,
	agentText = "",
): RetrievalResult {
	// Seeds: user + agent (preserve order, user first), like server _handle_retrieve.
	const userSeeds = extractSeedLabels(userText, graph);
	const agentSeeds = agentText ? extractSeedLabels(agentText, graph) : [];
	const userSet = new Set(userSeeds);
	const seeds = [...userSeeds, ...agentSeeds.filter((s) => !userSet.has(s))];

	// PPR overfetch -> MMR rerank -> retriever.py triple post-processing.
	const ppr = queryPpr(graph, seeds, { topN: OVERFETCH });
	let triples = mmrRerankTriples(ppr, graph.embeddings, graph.labelIndex, TRIPLES_PER_RETRIEVE, MMR_LAMBDA);
	triples = capPerHead(dedupPredicateHierarchy(triples), MAX_TRIPLES_PER_HEAD);

	// Term match on combined text, then doc-node cap.
	const combined = agentText ? `${userText}\n${agentText}` : userText;
	let termMatches = graph.termMatch(combined);
	const docMatches = termMatches.filter((m) => m.label.startsWith("doc:"));
	const nonDoc = termMatches.filter((m) => !m.label.startsWith("doc:"));
	termMatches = nonDoc.concat(docMatches.slice(0, MAX_DOC_NODES));

	// Vacuum set (pre-ledger-dedup) for the gutters.
	const vacuum = { terms: termMatches, triples };

	// Injection: dedup against the per-session ledger.
	const freshTriples = triples.filter((t) => !ledger.hasTriple(tripleKey(t)));
	let freshTerms = termMatches.filter((m) => !ledger.hasTerm(`desc:${m.label}`));

	// Term cap (top-N by hit_count). Overflow is NOT committed to the ledger, so
	// a still-salient concept re-ships on a later turn.
	if (freshTerms.length > TERMS_PER_RETRIEVE) {
		freshTerms = [...freshTerms]
			.sort((a, b) => (b.hit_count ?? 0) - (a.hit_count ?? 0))
			.slice(0, TERMS_PER_RETRIEVE);
	}

	// Commit survivors so they won't ship again this session.
	for (const t of freshTriples) ledger.addTriple(tripleKey(t));
	for (const m of freshTerms) ledger.addTerm(`desc:${m.label}`);

	return { vacuum, injectionBlock: assemble(freshTriples, freshTerms), seeds };
}
