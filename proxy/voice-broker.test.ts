// Unit tests for the voice-session broker: assign → fill to capacity → 202-queue →
// release frees a slot → a stale lease is TTL-reclaimed. The broker is exercised
// directly (it's pure in-memory state) with an injected clock so the TTL sweeper is
// deterministic — no port, no timers, no network.

import { test, expect } from "bun:test";
import { VoiceBroker } from "./voice-broker";

const ONE = [{ ttsUrl: "ws://x/tts" }];
const TWO = [{ ttsUrl: "ws://x/tts" }, { ttsUrl: "ws://x/tts-2" }];

function brokerWithClock(endpoints: { ttsUrl: string }[], capacity: number) {
	let t = 0;
	const b = new VoiceBroker({
		endpoints,
		capacity,
		heartbeatSec: 60,
		now: () => t,
	});
	return { b, advance: (ms: number) => (t += ms), at: (ms: number) => (t = ms) };
}

test("lease grants and returns the endpoint URL + heartbeat interval", () => {
	const { b } = brokerWithClock(ONE, 1);
	const r = b.lease();
	expect(r.granted).toBe(true);
	if (r.granted) {
		expect(r.leaseId).toBeTruthy();
		expect(r.ttsUrl).toBe("ws://x/tts");
		expect(r.heartbeatSec).toBe(60);
	}
});

test("fill to capacity → the next request 202-queues", () => {
	const { b } = brokerWithClock(ONE, 1);
	const first = b.lease();
	expect(first.granted).toBe(true);

	const overflow = b.lease();
	expect(overflow.granted).toBe(false);
	if (!overflow.granted) {
		expect(overflow.queued).toBe(true);
		expect(overflow.position).toBeGreaterThanOrEqual(1);
	}
});

test("release frees a slot so the next request is granted again", () => {
	const { b } = brokerWithClock(ONE, 1);
	const first = b.lease();
	expect(first.granted).toBe(true);
	expect(b.lease().granted).toBe(false); // full

	if (first.granted) b.release(first.leaseId);

	const after = b.lease();
	expect(after.granted).toBe(true);
});

test("a stale lease is TTL-reclaimed (no heartbeat past 3x interval)", () => {
	const { b, advance } = brokerWithClock(ONE, 1);
	const first = b.lease();
	expect(first.granted).toBe(true);
	expect(b.lease().granted).toBe(false); // full

	// 3x heartbeat (60s) = 180s TTL. Just under → still held; just over → reclaimed.
	advance(179_000);
	expect(b.lease().granted).toBe(false);
	advance(2_000); // now > 180s since the (un-beaten) first lease
	const reclaimed = b.lease();
	expect(reclaimed.granted).toBe(true);
});

test("heartbeat keeps a lease alive past the TTL window", () => {
	const { b, advance } = brokerWithClock(ONE, 1);
	const first = b.lease();
	expect(first.granted).toBe(true);

	advance(100_000);
	if (first.granted) expect(b.heartbeat(first.leaseId)).toBe(true);
	advance(100_000); // 200s since lease, but only 100s since the beat → still alive
	expect(b.lease().granted).toBe(false);
});

test("heartbeat on an unknown lease returns false", () => {
	const { b } = brokerWithClock(ONE, 1);
	expect(b.heartbeat("nope")).toBe(false);
});

test("a lease is reclaimed past the absolute max-age even while heartbeating", () => {
	let t = 0;
	const b = new VoiceBroker({ endpoints: ONE, capacity: 1, heartbeatSec: 60, maxLeaseSec: 300, now: () => t });
	const first = b.lease();
	expect(first.granted).toBe(true);
	// Beat every 100s to stay inside the 3x-heartbeat (180s) TTL...
	t = 100_000;
	if (first.granted) expect(b.heartbeat(first.leaseId)).toBe(true);
	t = 200_000;
	if (first.granted) expect(b.heartbeat(first.leaseId)).toBe(true);
	// ...but cross the 300s absolute age cap (last beat only 105s ago → not TTL-stale).
	t = 305_000;
	// Capacity is 1: a granted re-lease proves the still-heartbeating lease was reclaimed
	// by the age cap (otherwise this would 202-queue).
	const after = b.lease();
	expect(after.granted).toBe(true);
});

test("two endpoints load-balance: the second lease lands on the empty endpoint", () => {
	const { b } = brokerWithClock(TWO, 1);
	const a = b.lease();
	const c = b.lease();
	expect(a.granted).toBe(true);
	expect(c.granted).toBe(true);
	if (a.granted && c.granted) {
		// least-loaded pick → distinct endpoints, distinct URLs
		expect(a.ttsUrl).not.toBe(c.ttsUrl);
	}
	// both full now → 202
	expect(b.lease().granted).toBe(false);
});

test("capacity > 1 admits that many leases per endpoint before queuing", () => {
	const { b } = brokerWithClock(ONE, 3);
	expect(b.lease().granted).toBe(true);
	expect(b.lease().granted).toBe(true);
	expect(b.lease().granted).toBe(true);
	expect(b.lease().granted).toBe(false); // 4th overflows
});

test("release is tolerant of unknown / double releases", () => {
	const { b } = brokerWithClock(ONE, 1);
	const first = b.lease();
	expect(first.granted).toBe(true);
	if (first.granted) {
		b.release(first.leaseId);
		b.release(first.leaseId); // double release — must not underflow
		b.release("never-existed");
	}
	// capacity intact: exactly one slot, grant then overflow
	expect(b.lease().granted).toBe(true);
	expect(b.lease().granted).toBe(false);
});
