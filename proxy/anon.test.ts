// Integration tests for the anonymous free-tier grant flow (/anon-init) and the
// spend-only guard on /v1/chat/completions. Runs the Hono app in-process via
// app.request() against an in-memory SQLite DB — no port, no network. The forward
// path (the real OpenRouter call) is intentionally NOT exercised; these cover the
// resolve / grant / adopt / continuity / gate / 401 branches that return before it.

import { test, expect, beforeAll } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.OWNER_OPENROUTER_KEY = "sk-test-owner";

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
