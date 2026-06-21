// SQLite metering layer for cymbiont-proxy.
//
// Three tables: principals (who can spend + how much is left), usage_log (every
// metered call), family_codes (redeemable codes → family principals). All money
// is USD; OpenRouter returns per-call `cost` in credits ≈ USD and we debit that.
//
// The two rate caps — N new IPs/day and the $/day global free ceiling — are
// DERIVED from queries over created_at / ts (UTC), not maintained as counters,
// so there's no counter to drift out of sync.

import { Database } from "bun:sqlite";

export type PrincipalType = "ip" | "token";
export type Tier = "free" | "family";

export interface Principal {
	id: string; // IP address (free) or opaque bearer token (family)
	type: PrincipalType;
	upstream_key: string | null; // family sub-key; null → proxy uses the owner key
	credit_remaining: number;
	tier: Tier;
	created_at: string;
	flagged: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS principals (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  upstream_key     TEXT,
  credit_remaining REAL NOT NULL,
  tier             TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  flagged          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id      TEXT NOT NULL,
  ts                TEXT NOT NULL,
  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost              REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_principal ON usage_log(principal_id);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
CREATE TABLE IF NOT EXISTS family_codes (
  code           TEXT PRIMARY KEY,
  redeemed_token TEXT,
  created_at     TEXT NOT NULL,
  redeemed_at    TEXT
);
`;

export class Db {
	private db: Database;

	private sGetPrincipal;
	private sNewIpsToday;
	private sFreeSpendToday;
	private sMonthlySpend;
	private sFamilyMonthlySpend;
	private sCreatePrincipal;
	private sInsertUsage;
	private sDebit;
	private sGetCode;
	private sInsertCode;
	private sClaimCode;
	private sReleaseCode;

	constructor(path: string) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA foreign_keys = ON;");
		this.db.exec(SCHEMA);

		this.sGetPrincipal = this.db.query<Principal, [string]>(
			"SELECT * FROM principals WHERE id = ?",
		);
		this.sNewIpsToday = this.db.query<{ n: number }, []>(
			"SELECT COUNT(*) AS n FROM principals WHERE type = 'ip' AND date(created_at) = date('now')",
		);
		this.sFreeSpendToday = this.db.query<{ total: number }, []>(
			`SELECT COALESCE(SUM(u.cost), 0) AS total
			 FROM usage_log u JOIN principals p ON p.id = u.principal_id
			 WHERE p.type = 'ip' AND date(u.ts) = date('now')`,
		);
		this.sMonthlySpend = this.db.query<{ total: number }, []>(
			"SELECT COALESCE(SUM(cost), 0) AS total FROM usage_log WHERE strftime('%Y-%m', ts) = strftime('%Y-%m', 'now')",
		);
		this.sFamilyMonthlySpend = this.db.query<{ total: number }, []>(
			`SELECT COALESCE(SUM(u.cost), 0) AS total
			 FROM usage_log u JOIN principals p ON p.id = u.principal_id
			 WHERE p.type = 'token' AND strftime('%Y-%m', u.ts) = strftime('%Y-%m', 'now')`,
		);
		this.sCreatePrincipal = this.db.query<
			unknown,
			[string, PrincipalType, string | null, number, Tier, string]
		>(
			`INSERT INTO principals (id, type, upstream_key, credit_remaining, tier, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.sInsertUsage = this.db.query<
			unknown,
			[string, string, string | null, number, number, number]
		>(
			`INSERT INTO usage_log (principal_id, ts, model, prompt_tokens, completion_tokens, cost)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.sDebit = this.db.query<unknown, [number, string]>(
			"UPDATE principals SET credit_remaining = credit_remaining - ? WHERE id = ?",
		);
		this.sGetCode = this.db.query<
			{ code: string; redeemed_token: string | null },
			[string]
		>("SELECT code, redeemed_token FROM family_codes WHERE code = ?");
		this.sInsertCode = this.db.query<unknown, [string, string]>(
			"INSERT INTO family_codes (code, created_at) VALUES (?, ?)",
		);
		// Atomic claim: only succeeds if the code exists and is still unredeemed.
		this.sClaimCode = this.db.query<unknown, [string, string, string]>(
			`UPDATE family_codes SET redeemed_token = ?, redeemed_at = ?
			 WHERE code = ? AND redeemed_token IS NULL`,
		);
		this.sReleaseCode = this.db.query<unknown, [string]>(
			"UPDATE family_codes SET redeemed_token = NULL, redeemed_at = NULL WHERE code = ?",
		);
	}

	getPrincipal(id: string): Principal | null {
		return this.sGetPrincipal.get(id) ?? null;
	}

	newIpGrantsToday(): number {
		return this.sNewIpsToday.get()?.n ?? 0;
	}

	freeSpendToday(): number {
		return this.sFreeSpendToday.get()?.total ?? 0;
	}

	/** Total metered spend (all tiers) in the current calendar month. */
	monthlySpend(): number {
		return this.sMonthlySpend.get()?.total ?? 0;
	}

	/** Family-tier spend in the current calendar month. */
	familyMonthlySpend(): number {
		return this.sFamilyMonthlySpend.get()?.total ?? 0;
	}

	createPrincipal(p: {
		id: string;
		type: PrincipalType;
		upstreamKey: string | null;
		credit: number;
		tier: Tier;
	}): void {
		this.sCreatePrincipal.run(
			p.id,
			p.type,
			p.upstreamKey,
			p.credit,
			p.tier,
			new Date().toISOString(),
		);
	}

	/** Record a metered call and debit the principal's balance in one transaction. */
	recordUsage(u: {
		principalId: string;
		model: string | null;
		promptTokens: number;
		completionTokens: number;
		cost: number;
	}): void {
		this.db.transaction(() => {
			this.sInsertUsage.run(
				u.principalId,
				new Date().toISOString(),
				u.model,
				u.promptTokens,
				u.completionTokens,
				u.cost,
			);
			this.sDebit.run(u.cost, u.principalId);
		})();
	}

	codeExists(code: string): boolean {
		return this.sGetCode.get(code) !== null;
	}

	insertCode(code: string): void {
		this.sInsertCode.run(code, new Date().toISOString());
	}

	/** Atomically claim an unredeemed code (reserves it before the async sub-key
	 *  mint). Returns false if the code is unknown or already redeemed. Pair with
	 *  releaseCode() if the subsequent mint fails. */
	claimCode(code: string, token: string): boolean {
		const res = this.sClaimCode.run(token, new Date().toISOString(), code);
		return res.changes === 1;
	}

	releaseCode(code: string): void {
		this.sReleaseCode.run(code);
	}
}
