// Voice-session broker — load-balances browser voice sessions across one or more
// moshi instances, with overflow queuing.
//
// WHY HERE: the metering proxy is the only always-on backend, so the broker rides
// along instead of standing up a second service. The leases are IN-MEMORY and
// EPHEMERAL — they track concurrency, not money, so a proxy restart simply resets
// the counts (every browser re-leases on its next mic-on). Nothing is persisted.
//
// CAPACITY MODEL: the binding resource is the moshi STT slot. moshi serves a fixed
// `batch_size` of concurrent STT streams per instance; that number is the
// per-instance capacity. A voice-engaged browser holds ONE lease (one STT slot) for
// the duration of its engagement, kept alive by a periodic heartbeat. TTS is
// short-lived (one session per sentence) and, as long as the TTS batch_size is >=
// the STT batch_size, never independently overflows — so a single STT-slot lease is
// the whole admission control.
//
// The two moshi instances in prod differ only by URL PATH on the same origin (so the
// frontend CSP's connect-src is untouched); the broker just hands back whichever
// instance's {sttUrl, ttsUrl} pair it assigned.

import { randomBytes } from "node:crypto";

export interface VoiceInstance {
	sttUrl: string;
	ttsUrl: string;
}

export interface VoiceBrokerConfig {
	instances: VoiceInstance[];
	// Per-instance max concurrent leases — set to the moshi STT batch_size.
	capacity: number;
	// How often the browser should heartbeat (seconds). A lease is TTL-reclaimed
	// once its last beat is older than 3x this (covers tabs that closed without a
	// clean release).
	heartbeatSec: number;
	// Injectable clock (ms) — tests drive the TTL sweeper through it.
	now?: () => number;
}

interface Lease {
	instanceIdx: number;
	lastBeat: number;
}

export type LeaseResult =
	| { granted: true; leaseId: string; sttUrl: string; ttsUrl: string; heartbeatSec: number }
	| { granted: false; queued: true; position: number };

export class VoiceBroker {
	private readonly leases = new Map<string, Lease>();
	// Per-instance active lease count, indexed like config.instances.
	private readonly active: number[];
	// Timestamps of recent overflow (202) responses, swept on the heartbeat TTL.
	// Used only to give a queued caller an approximate "position" — the broker keeps
	// no real waiter list (a refused caller is told to type instead, not parked).
	private queuedAt: number[] = [];
	private readonly now: () => number;

	constructor(private readonly cfg: VoiceBrokerConfig) {
		if (cfg.instances.length === 0) throw new Error("VoiceBroker needs at least one instance");
		if (cfg.capacity < 1) throw new Error("VoiceBroker capacity must be >= 1");
		this.active = cfg.instances.map(() => 0);
		this.now = cfg.now ?? Date.now;
	}

	private ttlMs(): number {
		return this.cfg.heartbeatSec * 1000 * 3;
	}

	/** Reclaim leases whose last heartbeat is older than the TTL, and expire stale
	 *  queue markers. Idempotent; called lazily at the head of every public op. */
	sweep(): void {
		const t = this.now();
		const leaseCutoff = t - this.ttlMs();
		for (const [id, l] of this.leases) {
			if (l.lastBeat < leaseCutoff) {
				this.leases.delete(id);
				this.active[l.instanceIdx]!--;
			}
		}
		const queueCutoff = t - this.cfg.heartbeatSec * 1000;
		this.queuedAt = this.queuedAt.filter((ts) => ts >= queueCutoff);
	}

	/** Pick the least-loaded instance with a free slot and assign a lease, or queue
	 *  (202) when every instance is full. */
	lease(): LeaseResult {
		this.sweep();
		let best = -1;
		for (let i = 0; i < this.cfg.instances.length; i++) {
			if (this.active[i]! >= this.cfg.capacity) continue;
			if (best === -1 || this.active[i]! < this.active[best]!) best = i;
		}
		if (best === -1) {
			this.queuedAt.push(this.now());
			return { granted: false, queued: true, position: this.queuedAt.length };
		}
		const leaseId = randomBytes(16).toString("hex");
		this.active[best]!++;
		this.leases.set(leaseId, { instanceIdx: best, lastBeat: this.now() });
		const inst = this.cfg.instances[best]!;
		return {
			granted: true,
			leaseId,
			sttUrl: inst.sttUrl,
			ttsUrl: inst.ttsUrl,
			heartbeatSec: this.cfg.heartbeatSec,
		};
	}

	/** Refresh a lease's keepalive. Returns false for an unknown/expired lease (the
	 *  caller should re-lease). */
	heartbeat(leaseId: string): boolean {
		this.sweep();
		const l = this.leases.get(leaseId);
		if (!l) return false;
		l.lastBeat = this.now();
		return true;
	}

	/** Drop a lease and free its slot. Tolerant of unknown ids (double release, or a
	 *  release racing a TTL reclaim). */
	release(leaseId: string): void {
		const l = this.leases.get(leaseId);
		if (!l) return;
		this.leases.delete(leaseId);
		this.active[l.instanceIdx]!--;
	}

	/** Snapshot for diagnostics/tests. */
	stats(): { capacity: number; instances: { active: number }[]; totalLeases: number } {
		return {
			capacity: this.cfg.capacity,
			instances: this.active.map((a) => ({ active: a })),
			totalLeases: this.leases.size,
		};
	}
}

// --- HTTP wiring -------------------------------------------------------------
// Registered on the shared Hono app by server.ts. Routes are intentionally NOT
// principal-gated: a lease is concurrency state, not spend, and CORS already scopes
// who can reach the proxy. (If abuse ever shows up, gate these the same way
// /v1/web-search resolves a bearer.)

import type { Hono } from "hono";
import type { Context } from "hono";

/** Extract a leaseId from a request, tolerating navigator.sendBeacon — whose body
 *  may arrive as text/plain or a Blob, not JSON. Checks the query param first, then
 *  a JSON body, then a bare text body. */
async function leaseIdFrom(c: Context): Promise<string> {
	const q = c.req.query("leaseId");
	if (q) return q.trim();
	const raw = await c.req.text().catch(() => "");
	if (!raw) return "";
	try {
		const o = JSON.parse(raw) as { leaseId?: unknown };
		if (typeof o.leaseId === "string") return o.leaseId.trim();
	} catch {
		// not JSON — a sendBeacon text/plain body may be the bare leaseId
	}
	return raw.trim();
}

export function registerVoiceRoutes(app: Hono, broker: VoiceBroker): void {
	app.post("/voice/lease", (c) => {
		const r = broker.lease();
		if (r.granted) {
			return c.json({
				leaseId: r.leaseId,
				sttUrl: r.sttUrl,
				ttsUrl: r.ttsUrl,
				heartbeatSec: r.heartbeatSec,
			});
		}
		return c.json({ queued: true, position: r.position }, 202);
	});

	app.post("/voice/heartbeat", async (c) => {
		const leaseId = await leaseIdFrom(c);
		if (!leaseId) return c.json({ error: "missing leaseId" }, 400);
		if (!broker.heartbeat(leaseId)) {
			return c.json({ error: "unknown or expired lease" }, 404);
		}
		return c.json({ ok: true });
	});

	app.post("/voice/release", async (c) => {
		const leaseId = await leaseIdFrom(c);
		if (leaseId) broker.release(leaseId);
		// Always 200 — release is best-effort cleanup (often a fire-and-forget beacon
		// on unload), and the TTL sweeper is the backstop for anything missed.
		return c.json({ ok: true });
	});
}
