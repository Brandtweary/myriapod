// Unit tests for the voice-session broker: assign → fill to capacity → 202-queue →
// release frees a slot → a stale lease is TTL-reclaimed. The broker is exercised
// directly (it's pure in-memory state) with an injected clock so the TTL sweeper is
// deterministic — no port, no timers, no network.

import { test, expect } from "bun:test";
import { VoiceBroker } from "./voice-broker";

const ONE = [{ sttUrl: "ws://x/asr", ttsUrl: "ws://x/tts" }];
const TWO = [
	{ sttUrl: "ws://x/asr", ttsUrl: "ws://x/tts" },
	{ sttUrl: "ws://x/asr-2", ttsUrl: "ws://x/tts-2" },
];

function brokerWithClock(instances: { sttUrl: string; ttsUrl: string }[], capacity: number) {
	let t = 0;
	const b = new VoiceBroker({
		instances,
		capacity,
		heartbeatSec: 60,
		now: () => t,
	});
	return { b, advance: (ms: number) => (t += ms), at: (ms: number) => (t = ms) };
}

test("lease grants and returns the instance URLs + heartbeat interval", () => {
	const { b } = brokerWithClock(ONE, 1);
	const r = b.lease();
	expect(r.granted).toBe(true);
	if (r.granted) {
		expect(r.leaseId).toBeTruthy();
		expect(r.sttUrl).toBe("ws://x/asr");
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

test("two instances load-balance: the second lease lands on the empty instance", () => {
	const { b } = brokerWithClock(TWO, 1);
	const a = b.lease();
	const c = b.lease();
	expect(a.granted).toBe(true);
	expect(c.granted).toBe(true);
	if (a.granted && c.granted) {
		// least-loaded pick → distinct instances, distinct URLs
		expect(a.sttUrl).not.toBe(c.sttUrl);
	}
	// both full now → 202
	expect(b.lease().granted).toBe(false);
});

test("capacity > 1 admits that many leases per instance before queuing", () => {
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
