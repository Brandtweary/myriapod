// Per-session injected ledger.
//
// In the browser the Agent is long-lived and the KG breadcrumb messages persist
// in agent.state.messages (accumulating like Claude Code's additionalContext), so dedup
// is correct: once a triple/term has shipped this session it stays in the
// transcript and re-injecting is pure waste. In-memory only (no disk) — a fresh
// page load starts a fresh session, which is the intended reset.

export class InjectedLedger {
	private triples = new Set<string>();
	private terms = new Set<string>();

	hasTriple(key: string): boolean {
		return this.triples.has(key);
	}
	hasTerm(key: string): boolean {
		return this.terms.has(key);
	}
	addTriple(key: string): void {
		this.triples.add(key);
	}
	addTerm(key: string): void {
		this.terms.add(key);
	}

	get sizes(): { triples: number; terms: number } {
		return { triples: this.triples.size, terms: this.terms.size };
	}
}
