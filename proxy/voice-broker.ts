// Voice-session broker — load-balances browser voice sessions across one or more
// streaming-TTS endpoints, with overflow queuing.
//
// WHY HERE: the metering proxy is the only always-on backend, so the broker rides
// along instead of standing up a second service. The leases are IN-MEMORY and
// EPHEMERAL — they track concurrency, not money, so a proxy restart simply resets
// the counts (every browser re-leases on its next mic-on). Nothing is persisted.
//
// CAPACITY MODEL: the leased resource is a TTS endpoint. A voice-engaged browser
// holds ONE lease on one endpoint for the duration of its engagement, kept alive by
// a periodic heartbeat, and that lease is the whole admission control. STT is a
// shared, stateless HTTP endpoint holding no per-session resource, so it is neither
// leased nor counted.
//
// `capacity` is OPERATOR-DECLARED and enforced HERE and nowhere else: it is how many
// simultaneous voice sessions the operator judges one TTS endpoint can carry. No
// upstream service reports or negotiates a limit, so the number cannot be derived
// from a backend setting — set it too high and sessions queue behind each other on
// the TTS server (slower speech), never a refusal.
//
// Multiple endpoints in one deploy differ only by URL PATH on the same origin (so
// the frontend CSP's connect-src is untouched); the broker hands back the `ttsUrl`
// it assigned.

import { randomBytes } from "node:crypto";

export interface TtsEndpoint {
	ttsUrl: string;
}

export interface VoiceBrokerConfig {
	endpoints: TtsEndpoint[];
	// Max concurrent voice sessions per TTS endpoint (see CAPACITY MODEL above).
	capacity: number;
	// How often the browser should heartbeat (seconds). A lease is TTL-reclaimed
	// once its last beat is older than 3x this (covers tabs that closed without a
	// clean release).
	heartbeatSec: number;
	// Absolute lease lifetime (seconds). A lease older than this is reclaimed even if
	// still heartbeating, so a slot can't be held forever. 0 → no absolute cap.
	maxLeaseSec?: number;
	// Injectable clock (ms) — tests drive the TTL sweeper through it.
	now?: () => number;
}

interface Lease {
	endpointIdx: number;
	lastBeat: number;
	createdAt: number;
}

export type LeaseResult =
	| { granted: true; leaseId: string; ttsUrl: string; heartbeatSec: number }
	| { granted: false; queued: true; position: number };

export class VoiceBroker {
	private readonly leases = new Map<string, Lease>();
	// Per-endpoint active lease count, indexed like cfg.endpoints.
	private readonly active: number[];
	// Timestamps of recent overflow (202) responses, swept on the heartbeat TTL.
	// Used only to give a queued caller an approximate "position" — the broker keeps
	// no real waiter list (a refused caller is told to type instead, not parked).
	private queuedAt: number[] = [];
	private readonly now: () => number;

	constructor(private readonly cfg: VoiceBrokerConfig) {
		if (cfg.endpoints.length === 0) throw new Error("VoiceBroker needs at least one TTS endpoint");
		if (cfg.capacity < 1) throw new Error("VoiceBroker capacity must be >= 1");
		this.active = cfg.endpoints.map(() => 0);
		this.now = cfg.now ?? Date.now;
	}

	private ttlMs(): number {
		return this.cfg.heartbeatSec * 1000 * 3;
	}

	private maxLeaseMs(): number {
		return (this.cfg.maxLeaseSec ?? 0) * 1000;
	}

	/** Reclaim leases whose last heartbeat is older than the TTL OR whose absolute age
	 *  exceeds the max-lease cap, and expire stale queue markers. Idempotent; called
	 *  lazily at the head of every public op. */
	sweep(): void {
		const t = this.now();
		const leaseCutoff = t - this.ttlMs();
		const ageCap = this.maxLeaseMs();
		for (const [id, l] of this.leases) {
			const expired = l.lastBeat < leaseCutoff || (ageCap > 0 && t - l.createdAt >= ageCap);
			if (expired) {
				this.leases.delete(id);
				this.active[l.endpointIdx]!--;
			}
		}
		const queueCutoff = t - this.cfg.heartbeatSec * 1000;
		this.queuedAt = this.queuedAt.filter((ts) => ts >= queueCutoff);
	}

	/** Pick the least-loaded endpoint with a free slot and assign a lease, or queue
	 *  (202) when every endpoint is full. */
	lease(): LeaseResult {
		this.sweep();
		let best = -1;
		for (let i = 0; i < this.cfg.endpoints.length; i++) {
			if (this.active[i]! >= this.cfg.capacity) continue;
			if (best === -1 || this.active[i]! < this.active[best]!) best = i;
		}
		if (best === -1) {
			this.queuedAt.push(this.now());
			return { granted: false, queued: true, position: this.queuedAt.length };
		}
		const leaseId = randomBytes(16).toString("hex");
		this.active[best]!++;
		const t = this.now();
		this.leases.set(leaseId, { endpointIdx: best, lastBeat: t, createdAt: t });
		const inst = this.cfg.endpoints[best]!;
		return {
			granted: true,
			leaseId,
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
		this.active[l.endpointIdx]!--;
	}

	/** Snapshot for diagnostics/tests. */
	stats(): { capacity: number; endpoints: { active: number }[]; totalLeases: number } {
		return {
			capacity: this.cfg.capacity,
			endpoints: this.active.map((a) => ({ active: a })),
			totalLeases: this.leases.size,
		};
	}
}

// --- HTTP wiring -------------------------------------------------------------
// Registered on the shared Hono app by server.ts. Routes are NOT principal-gated (a
// lease is concurrency state, not spend, and CORS scopes who can reach the proxy) but
// /voice/lease IS per-IP rate-limited so a script can't drain every TTS slot by
// hammering the mint. The IP comes from server.ts's trust-aware resolver.

import type { Hono } from "hono";
import type { Context } from "hono";

// Per-IP sliding-window limiter on /voice/lease. In-memory, ephemeral (a restart
// resets it), and size-capped so a flood of distinct IPs can't grow it without bound.
const LEASE_WINDOW_MS = 60_000;
const LEASE_MAX = 30; // leases/min per IP — generous for a normal re-lease cadence
const LEASE_MAP_CAP = 10_000;
const leaseHits = new Map<string, number[]>();
function leaseRateLimited(ip: string): boolean {
	const now = Date.now();
	const cutoff = now - LEASE_WINDOW_MS;
	if (leaseHits.size > LEASE_MAP_CAP) {
		for (const [k, v] of leaseHits) {
			const live = v.filter((t) => t > cutoff);
			if (live.length) leaseHits.set(k, live);
			else leaseHits.delete(k);
		}
	}
	const hits = (leaseHits.get(ip) ?? []).filter((t) => t > cutoff);
	hits.push(now);
	leaseHits.set(ip, hits);
	return hits.length > LEASE_MAX;
}

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

export function registerVoiceRoutes(
	app: Hono,
	broker: VoiceBroker,
	clientIp: (c: Context) => string,
): void {
	app.post("/voice/lease", (c) => {
		if (leaseRateLimited(clientIp(c))) {
			return c.json({ error: "rate limit — slow down" }, 429);
		}
		const r = broker.lease();
		if (r.granted) {
			return c.json({
				leaseId: r.leaseId,
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
