import { expect, test } from "bun:test";
import { Db } from "./db";

test("telemetry reports one row per session with ip, calls, and credits", () => {
	const db = new Db(":memory:");
	db.createPrincipal({ id: "tok-a", type: "anon", upstreamKey: null, credit: 10, tier: "free" });
	db.bindIp("203.0.113.7", "tok-a");
	db.reconcileUsage({
		principalId: "tok-a",
		model: "moonshotai/kimi-k3",
		promptTokens: 100,
		completionTokens: 50,
		cost: 0.004,
		reserved: 0,
	});

	const t = db.telemetry();
	expect(t.summary.sessions).toBe(1);
	expect(t.summary.uniqueIps).toBe(1);
	expect(t.summary.spendTodayUsd).toBeCloseTo(0.004, 6);

	const row = t.sessions[0]!;
	// The session label is a sha256-derived hex digest, never the raw bearer token.
	expect(row.session).toMatch(/^[0-9a-f]{12}$/);
	expect(row.session).not.toBe("tok-a");
	// Stable per principal — the same token hashes to the same label.
	expect(db.telemetry().sessions[0]!.session).toBe(row.session);
	expect(row.ip).toBe("203.0.113.7");
	expect(row.calls).toBe(1);
	expect(row.creditsUsedUsd).toBeCloseTo(0.004, 6);
	expect(row.minutes).toBeGreaterThanOrEqual(0);
});

test("telemetry sums spend across sessions and never invents rows", () => {
	const db = new Db(":memory:");
	db.createPrincipal({ id: "a", type: "anon", upstreamKey: null, credit: 10, tier: "free" });
	db.createPrincipal({ id: "b", type: "token", upstreamKey: "sk-x", credit: 100, tier: "family" });
	db.reconcileUsage({ principalId: "a", model: "m", promptTokens: 1, completionTokens: 1, cost: 0.01, reserved: 0 });
	db.reconcileUsage({ principalId: "b", model: "m", promptTokens: 1, completionTokens: 1, cost: 0.02, reserved: 0 });

	const t = db.telemetry();
	expect(t.summary.sessions).toBe(2);
	expect(t.summary.spendMonthUsd).toBeCloseTo(0.03, 6);
	// No IPs bound → nothing invented.
	expect(t.summary.uniqueIps).toBe(0);
	expect(t.sessions.every((s) => s.ip === null)).toBe(true);
	// Every session label is a 12-char hex digest, never the raw token, and distinct per principal.
	expect(t.sessions.every((s) => /^[0-9a-f]{12}$/.test(s.session))).toBe(true);
	expect(t.sessions.every((s) => s.session !== "a" && s.session !== "b")).toBe(true);
	expect(new Set(t.sessions.map((s) => s.session)).size).toBe(t.sessions.length);
});

test("telemetry is empty on a fresh db", () => {
	const db = new Db(":memory:");
	const t = db.telemetry();
	expect(t.summary.sessions).toBe(0);
	expect(t.summary.uniqueIps).toBe(0);
	expect(t.summary.spendTodayUsd).toBe(0);
	expect(t.sessions).toEqual([]);
});
