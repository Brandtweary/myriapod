// Unit tests for the atomic spend-cap reservation (the fix for the TOCTOU where
// concurrent forwards all read "under limit" and all pass). Exercises the DB layer
// directly against an in-memory SQLite — the reservation IS the atomicity, so this is
// the honest test: reserve races through the DB's conditional UPDATE, then reconcile /
// refund settle it to the true cost. No port, no network, no OpenRouter.

import { test, expect } from "bun:test";
import { Db } from "./db";

function principal(db: Db, id: string, credit: number) {
	db.createPrincipal({ id, type: "anon", upstreamKey: null, credit, tier: "free" });
}

test("reserve is atomic: repeated reservations never overspend a balance", () => {
	const db = new Db(":memory:");
	principal(db, "p1", 1.0);
	const estimate = 0.3; // three fit in $1.00 (=$0.90); the fourth ($1.20) must fail
	let granted = 0;
	for (let i = 0; i < 10; i++) if (db.reserve("p1", estimate)) granted++;
	expect(granted).toBe(3);
	const p = db.getPrincipal("p1")!;
	expect(p.credit_remaining).toBeCloseTo(0.1, 6);
	expect(p.credit_remaining).toBeGreaterThanOrEqual(0);
});

test("reserve fails when the balance can't cover the estimate", () => {
	const db = new Db(":memory:");
	principal(db, "p2", 0.2);
	expect(db.reserve("p2", 0.5)).toBe(false);
	expect(db.getPrincipal("p2")!.credit_remaining).toBeCloseTo(0.2, 6);
});

test("reconcileUsage settles an over-reservation down to the true cost", () => {
	const db = new Db(":memory:");
	principal(db, "p3", 10);
	const estimate = 0.5;
	expect(db.reserve("p3", estimate)).toBe(true); // → 9.5
	db.reconcileUsage({
		principalId: "p3",
		model: "m",
		promptTokens: 100,
		completionTokens: 50,
		cost: 0.02,
		reserved: estimate,
	});
	// Net debit equals the true cost (0.02), not the reservation.
	expect(db.getPrincipal("p3")!.credit_remaining).toBeCloseTo(9.98, 6);
});

test("reconcileUsage can debit MORE than reserved (under-reservation)", () => {
	const db = new Db(":memory:");
	principal(db, "p4", 10);
	db.reserve("p4", 0.1);
	db.reconcileUsage({
		principalId: "p4",
		model: null,
		promptTokens: 0,
		completionTokens: 0,
		cost: 0.4,
		reserved: 0.1,
	});
	expect(db.getPrincipal("p4")!.credit_remaining).toBeCloseTo(9.6, 6);
});

test("refundReservation restores a reservation in full (upstream-error path)", () => {
	const db = new Db(":memory:");
	principal(db, "p5", 5);
	expect(db.reserve("p5", 0.5)).toBe(true); // → 4.5
	db.refundReservation("p5", 0.5);
	expect(db.getPrincipal("p5")!.credit_remaining).toBeCloseTo(5, 6);
});
