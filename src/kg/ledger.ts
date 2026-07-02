// Per-session injected ledger.
//
// In the browser the Agent is long-lived and the memory breadcrumb messages
// persist in agent.state.messages (accumulating like Claude Code's
// additionalContext), so dedup is correct: once a term has shipped this session
// it stays in the transcript and re-injecting is pure waste. In-memory only
// (no disk) — a fresh page load starts a fresh session, which is the intended
// reset.

export class InjectedLedger {
	private terms = new Set<string>();

	hasTerm(key: string): boolean {
		return this.terms.has(key);
	}
	addTerm(key: string): void {
		this.terms.add(key);
	}

	get sizes(): { terms: number } {
		return { terms: this.terms.size };
	}
}
