// Voice recency pool — the working-memory layer for the streaming voice path.
//
// Why a pool instead of the InjectedLedger: the text path appends a hidden
// <kg-context> breadcrumb that ACCUMULATES in the transcript, so append-only dedup
// (the ledger) is correct — anything injected once stays visible. The voice path
// uses Unmute's session.update / updateInstructions, which REPLACES the system
// prompt every turn: anything not re-asserted simply vanishes. So the voice path
// keeps a decaying working set and re-injects the WHOLE set each VAD turn.
//
// Each entry carries a hit count; its time-to-live grows logarithmically with
// hits, so a concept that keeps coming up persists for several turns while a
// one-off fades after one. Caps bound the injected context; eviction drops the
// entries closest to expiring (the least durable). Port of the Cymbiont harness's
// recency_pool.py.

import { POOL_BASE_TTL, POOL_TERMS_CAP, POOL_TRIPLES_CAP } from "./config";
import { assembleKgContext, tripleKey } from "./retrieve";
import type { TermMatch, Triple } from "./types";

// ttl(hits) = 1 if hits<=1 else round(BASE_TTL*(1+ln hits)).
// BASE_TTL=2 → 1→1, 2→3, 3→4, 5→5, 10→7, 20→8 (self-caps ~11).
function ttl(hits: number): number {
	return hits <= 1 ? 1 : Math.round(POOL_BASE_TTL * (1 + Math.log(hits)));
}

interface TermEntry {
	match: TermMatch;
	hits: number;
	expiresAtTurn: number;
}
interface TripleEntry {
	triple: Triple;
	hits: number;
	expiresAtTurn: number;
}

export interface PooledRetrieval {
	terms: TermMatch[];
	triples: Triple[];
	injectionBlock: string | null;
}

export class RetrievalPool {
	private turn = 0;
	private terms = new Map<string, TermEntry>(); // key: term label
	private triples = new Map<string, TripleEntry>(); // key: tripleKey

	/** Fold one VAD turn's vacuum into the pool, then return the full pool as
	 *  gutter sets + a rendered <kg-context> block. Cadence per turn: advance the
	 *  clock → add/refresh hits → expire → cap → render. */
	update(vacuum: { terms: TermMatch[]; triples: Triple[] }): PooledRetrieval {
		this.turn++;

		// Add new / refresh existing. A re-seen entry bumps its hit count and resets
		// its expiry off the (longer) new TTL. Map.set on an existing key preserves
		// insertion order, so the rendered order stays stable across turns.
		for (const m of vacuum.terms) {
			const hits = (this.terms.get(m.label)?.hits ?? 0) + 1;
			this.terms.set(m.label, { match: m, hits, expiresAtTurn: this.turn + ttl(hits) });
		}
		for (const t of vacuum.triples) {
			const key = tripleKey(t);
			const hits = (this.triples.get(key)?.hits ?? 0) + 1;
			this.triples.set(key, { triple: t, hits, expiresAtTurn: this.turn + ttl(hits) });
		}

		// Expire. A just-refreshed entry has expiresAtTurn > turn, so it survives;
		// a ttl=1 entry not re-seen expires at the next turn.
		for (const [k, e] of this.terms) if (e.expiresAtTurn <= this.turn) this.terms.delete(k);
		for (const [k, e] of this.triples) if (e.expiresAtTurn <= this.turn) this.triples.delete(k);

		// Cap: evict entries closest to expiring (tiebreak: fewer hits).
		capMap(this.terms, POOL_TERMS_CAP);
		capMap(this.triples, POOL_TRIPLES_CAP);

		const terms = [...this.terms.values()].map((e) => e.match);
		const triples = [...this.triples.values()].map((e) => e.triple);
		return { terms, triples, injectionBlock: assembleKgContext(triples, terms) };
	}

	get sizes(): { terms: number; triples: number } {
		return { terms: this.terms.size, triples: this.triples.size };
	}
}

// Evict down to `cap`, dropping the entries that expire soonest (least durable),
// breaking ties by lowest hit count.
function capMap<T extends { expiresAtTurn: number; hits: number }>(
	m: Map<string, T>,
	cap: number,
): void {
	if (m.size <= cap) return;
	const excess = m.size - cap;
	const ranked = [...m.entries()].sort(
		(a, b) => a[1].expiresAtTurn - b[1].expiresAtTurn || a[1].hits - b[1].hits,
	);
	for (let i = 0; i < excess; i++) m.delete(ranked[i][0]);
}
