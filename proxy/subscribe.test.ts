// Integration tests for the feature-alert email capture (POST /subscribe). Runs the
// Hono app in-process via app.request() against an in-memory SQLite DB — no port, no
// network. Covers the validate / store / idempotent / rate-limit branches.

import { test, expect, beforeAll } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.OWNER_OPENROUTER_KEY = "sk-test-owner";
// Trust XFF from any peer so the in-process harness can drive distinct client IPs
// via the header — mirrors running behind a trusted proxy.
process.env.TRUSTED_PROXY = "*";

let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

beforeAll(async () => {
	const mod = (await import("./server")) as unknown as { app: typeof app };
	app = mod.app;
});

function subscribe(ip: string, email: unknown) {
	return app.request("/subscribe", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
		body: JSON.stringify({ email }),
	});
}

test("valid email → 200 ok", async () => {
	const res = await subscribe("20.0.0.1", "Person@Example.com");
	expect(res.status).toBe(200);
	const data = (await res.json()) as { ok: boolean };
	expect(data.ok).toBe(true);
});

test("malformed emails → 400", async () => {
	// One IP each — otherwise the per-IP rate limit trips before validation runs.
	const bads: unknown[] = ["nope", "a@b", "@example.com", "x@y.", "", 42];
	for (let i = 0; i < bads.length; i++) {
		const res = await subscribe(`20.1.0.${i}`, bads[i]);
		expect(res.status).toBe(400);
	}
});

test("duplicate email → still 200 (idempotent)", async () => {
	const first = await subscribe("20.0.0.3", "dup@example.com");
	expect(first.status).toBe(200);
	const second = await subscribe("20.0.0.3", "dup@example.com");
	expect(second.status).toBe(200);
});

test("per-IP rate limit trips after the cap", async () => {
	const ip = "20.0.0.4";
	let sawLimit = false;
	for (let i = 0; i < 12; i++) {
		const res = await subscribe(ip, `u${i}@example.com`);
		if (res.status === 429) {
			sawLimit = true;
			break;
		}
	}
	expect(sawLimit).toBe(true);
});
