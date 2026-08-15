// Integration tests for the anonymous free-tier grant flow (/anon-init) and the
// spend-only guard on /v1/chat/completions. Runs the Hono app in-process via
// app.request() against an in-memory SQLite DB — no port, no network. The forward
// path (the real OpenRouter call) is intentionally NOT exercised; these cover the
// resolve / grant / adopt / continuity / gate / 401 branches that return before it.

import { test, expect, beforeAll } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.OWNER_OPENROUTER_KEY = "sk-test-owner";
// Trust XFF from any peer so the in-process test harness (no real socket peer) can
// drive distinct client IPs via the header — mirrors running behind a trusted proxy.
process.env.TRUSTED_PROXY = "*";
// A truthy provisioning key so /redeem gets past the "family tier not configured" 503
// and reaches the rate-limit path (no sub-key is minted for the unknown codes tested).
process.env.OPENROUTER_PROVISIONING_KEY = "sk-test-prov";

let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
let db: { newIpGrantsToday(): number };

beforeAll(async () => {
	const mod = (await import("./server")) as unknown as {
		app: typeof app;
		db: typeof db;
	};
	app = mod.app;
	db = mod.db;
});

const HUMAN = { honeypot: "", elapsedMs: 3000, botd: { bot: false } };

function anonInit(ip: string, body: Record<string, unknown> = HUMAN, token?: string) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"x-forwarded-for": ip,
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return app.request("/anon-init", { method: "POST", headers, body: JSON.stringify(body) });
}

test("new IP + human signals → fresh $10 grant", async () => {
	const res = await anonInit("10.0.0.1");
	expect(res.status).toBe(200);
	const data = (await res.json()) as { token: string; remaining: number };
	expect(data.token).toBeTruthy();
	expect(data.remaining).toBe(10);
});

test("honeypot filled → 403, no grant", async () => {
	const before = db.newIpGrantsToday();
	const res = await anonInit("10.0.0.2", { ...HUMAN, honeypot: "bot@spam.com" });
	expect(res.status).toBe(403);
	expect(db.newIpGrantsToday()).toBe(before);
});

test("submitted too fast (time-trap) → 403", async () => {
	const res = await anonInit("10.0.0.3", { ...HUMAN, elapsedMs: 200 });
	expect(res.status).toBe(403);
});

test("BotD says bot → 403", async () => {
	const res = await anonInit("10.0.0.4", { ...HUMAN, botd: { bot: true } });
	expect(res.status).toBe(403);
});

test("known token on a NEW IP → continuity, same token, no new grant", async () => {
	const first = await anonInit("10.0.0.5");
	const { token } = (await first.json()) as { token: string };
	const grantsAfterFirst = db.newIpGrantsToday();

	const second = await anonInit("10.0.0.6", HUMAN, token); // VPN hop
	expect(second.status).toBe(200);
	const data = (await second.json()) as { token: string };
	expect(data.token).toBe(token);
	expect(db.newIpGrantsToday()).toBe(grantsAfterFirst); // no extra mint
});

test("cleared browser on an already-granted IP → adopts the same principal", async () => {
	const first = await anonInit("10.0.0.7");
	const { token } = (await first.json()) as { token: string };
	const grants = db.newIpGrantsToday();

	const adopted = await anonInit("10.0.0.7"); // no token presented, same IP
	expect(adopted.status).toBe(200);
	const data = (await adopted.json()) as { token: string };
	expect(data.token).toBe(token);
	expect(db.newIpGrantsToday()).toBe(grants); // no extra mint
});

// Regression guard on clientIp(): a trusted reverse proxy APPENDS the real peer to
// any inbound X-Forwarded-For, so the rightmost entry is the only trustworthy one.
// Reading the leftmost would let a client pick its own identity per request and mint
// an unbounded number of fresh grants.
test("spoofed leftmost X-Forwarded-For entry is ignored; the rightmost wins", async () => {
	const first = await anonInit("203.0.113.9");
	const { token } = (await first.json()) as { token: string };
	const grants = db.newIpGrantsToday();

	// What the proxy sees when a client sends "X-Forwarded-For: 9.9.9.9" and the
	// reverse proxy appends the real peer.
	const spoofed = await anonInit("9.9.9.9, 203.0.113.9");
	expect(spoofed.status).toBe(200);
	const data = (await spoofed.json()) as { token: string };
	expect(data.token).toBe(token); // same principal → identity came from the rightmost entry
	expect(db.newIpGrantsToday()).toBe(grants); // no extra mint
});

test("5 new-IP grants/day cap → a later distinct IP gets 429", async () => {
	let saw429 = false;
	for (let i = 0; i < 10; i++) {
		const res = await anonInit(`172.16.0.${i}`);
		if (res.status === 429) {
			saw429 = true;
			break;
		}
	}
	expect(saw429).toBe(true);
});

test("chat without a bearer → 401", async () => {
	const res = await app.request("/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: "x", messages: [] }),
	});
	expect(res.status).toBe(401);
});

test("chat with an unknown bearer → 401", async () => {
	const res = await app.request("/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer deadbeef" },
		body: JSON.stringify({ model: "x", messages: [] }),
	});
	expect(res.status).toBe(401);
});

// Web search is no longer principal-gated — it's open (per-IP rate-limited). Without
// a bearer the request now sails past auth and hits the query check, so a missing q
// is a 400, not a 401.
test("web-search without a bearer → reaches the query check → 400 on missing q", async () => {
	const res = await app.request("/v1/web-search", { headers: { "x-forwarded-for": "198.51.100.1" } });
	expect(res.status).toBe(400);
});

test("web-search with an unknown bearer → no longer rejected; 400 on missing q", async () => {
	const res = await app.request("/v1/web-search", {
		headers: { Authorization: "Bearer deadbeef", "x-forwarded-for": "198.51.100.2" },
	});
	expect(res.status).toBe(400);
});

test("web-search per-IP rate limit → 429 once the window is exceeded", async () => {
	const ip = "203.0.113.9"; // a single IP fired repeatedly (no q → cheap 400s until limited)
	let saw429 = false;
	for (let i = 0; i < 50; i++) {
		const res = await app.request("/v1/web-search", { headers: { "x-forwarded-for": ip } });
		if (res.status === 429) {
			saw429 = true;
			break;
		}
	}
	expect(saw429).toBe(true);
});

function redeem(ip: string, code: string) {
	return app.request("/redeem", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
		body: JSON.stringify({ code }),
	});
}

test("/redeem brute-force: an unknown code is 404, and the backoff 429s the next try", async () => {
	const ip = "192.0.2.55";
	const first = await redeem(ip, "NOPE-AAAAAA");
	expect(first.status).toBe(404); // unknown code — failure noted
	const second = await redeem(ip, "NOPE-BBBBBB");
	expect(second.status).toBe(429); // escalating backoff engaged immediately
});

function embed(ip: string, inputs: unknown) {
	return app.request("/v1/embed", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
		body: JSON.stringify({ inputs }),
	});
}

test("/v1/embed rejects too many inputs (400, before touching the backend)", async () => {
	const res = await embed("192.0.2.60", Array.from({ length: 65 }, () => "x"));
	expect(res.status).toBe(400);
});

test("/v1/embed rejects an over-long input string (400)", async () => {
	const res = await embed("192.0.2.61", ["a".repeat(8193)]);
	expect(res.status).toBe(400);
});
