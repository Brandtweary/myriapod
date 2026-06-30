// myriapod-proxy — metered OpenAI-compatible inference proxy.
//
// Holds the owner OpenRouter key server-side; the browser never sees it. Every
// principal — anonymous-free or family — is identified by an opaque bearer token
// minted at POST /anon-init (anon) or POST /redeem (family). /v1/chat/completions
// is spend-only: it resolves the bearer, checks credit + caps, injects the right
// upstream key, forwards to OpenRouter, and debits the measured cost. The own-key
// path doesn't come here at all — the browser calls OpenRouter directly.
//
// The free grant lives entirely in /anon-init: one $10 per browser token, gated
// (on a genuinely-new browser + IP) by the BotD / honeypot / time-trap checks in
// anon.ts. A known token carried across IPs (VPN hop) keeps its balance with no
// new grant; a cleared browser on an already-granted IP adopts that IP's existing
// principal. So a fresh grant needs BOTH a never-seen token AND a never-granted IP.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getConnInfo } from "hono/bun";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { Db } from "./db";
import { forwardCompletion, mintSubKey } from "./openrouter";
import { grantGatesPass } from "./anon";
import { VoiceBroker, registerVoiceRoutes } from "./voice-broker";
import type { Context } from "hono";

const db = new Db(config.dbPath);
const app = new Hono();

// Voice-session broker — in-memory leases over the configured moshi instance(s).
// Ephemeral concurrency state, not money; a restart just resets the counts.
const voiceBroker = new VoiceBroker({
	instances: config.voiceInstances,
	capacity: config.voiceInstanceCapacity,
	heartbeatSec: config.voiceHeartbeatSec,
});

app.use(
	"*",
	cors({
		origin: config.allowedOrigins,
		allowMethods: ["GET", "POST", "OPTIONS"],
		// No allowHeaders list → Hono reflects the browser's
		// Access-Control-Request-Headers. The OpenAI SDK attaches x-stainless-*
		// headers; a fixed allow-list omits them and the preflight blocks the POST.
	}),
);

// Access log — method, path, status, duration. Makes "is traffic reaching the
// proxy, and which path is it taking?" answerable at a glance.
app.use("*", async (c, next) => {
	const t0 = Date.now();
	await next();
	console.log(`[proxy] ${c.req.method} ${new URL(c.req.url).pathname} → ${c.res.status} (${Date.now() - t0}ms)`);
});

app.get("/health", (c) => c.json({ ok: true }));

// Voice-session broker routes (POST /voice/lease | /heartbeat | /release).
// Registered after the CORS + access-log middleware so both apply.
registerVoiceRoutes(app, voiceBroker);

/** The bearer token presented by the client, or "" if none. The legacy "anon"
 *  placeholder (sent before a real token exists) is treated as no-bearer. */
function bearerOf(c: Context): string {
	const auth = c.req.header("authorization") ?? "";
	const t = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
	return t === "anon" ? "" : t;
}

/** Prefer the X-Forwarded-For client when behind a tunnel/reverse proxy, else
 *  the direct connection address. */
function clientIp(c: Context): string {
	const xff = c.req.header("x-forwarded-for");
	if (xff) return xff.split(",")[0]!.trim();
	try {
		return getConnInfo(c).remote.address ?? "unknown";
	} catch {
		return "unknown";
	}
}

// Current principal's remaining hosted credit (for the Access settings readout).
// No token yet → report the full free grant (not yet minted).
app.get("/balance", (c) => {
	const bearer = bearerOf(c);
	if (bearer) {
		const p = db.getPrincipal(bearer);
		if (!p) return c.json({ error: "invalid token" }, 401);
		if (p.tier === "family") {
			return c.json({ tier: "family", remaining: p.credit_remaining, grant: config.familyLimit });
		}
		return c.json({ tier: "free", remaining: p.credit_remaining, grant: config.freeGrant });
	}
	return c.json({ tier: "free", remaining: config.freeGrant, grant: config.freeGrant });
});

// In-memory per-IP sliding-window rate limit for the open web-search proxy. Web
// search is table-stakes for every visitor (own-key included), so the endpoint is
// NOT principal-gated — CORS already scopes browser callers to the site, and this
// window stops non-browser abuse of the open SearXNG passthrough. Not money, so it
// is not metered; a restart just resets the counts.
const WEB_SEARCH_WINDOW_MS = 60_000;
const WEB_SEARCH_MAX = 40;
const webSearchHits = new Map<string, number[]>();
function webSearchRateLimited(ip: string): boolean {
	const now = Date.now();
	const cutoff = now - WEB_SEARCH_WINDOW_MS;
	const hits = (webSearchHits.get(ip) ?? []).filter((t) => t > cutoff);
	hits.push(now);
	webSearchHits.set(ip, hits);
	return hits.length > WEB_SEARCH_MAX;
}

// Open (rate-limited) web search. Proxies a query to the self-hosted SearXNG and
// returns a trimmed result list. Universal — every serving path may call it; the
// per-IP window above is the only guard. NOT metered (SearXNG is self-hosted/free).
app.get("/v1/web-search", async (c) => {
	if (webSearchRateLimited(clientIp(c))) {
		return c.json({ error: "rate limit — slow down" }, 429);
	}

	const q = c.req.query("q")?.trim() ?? "";
	if (!q) return c.json({ error: "missing query (q)" }, 400);
	const limitParam = Number(c.req.query("limit"));
	const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 10) : 8;

	let res: Response;
	try {
		res = await fetch(
			`${config.searxngBase}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0`,
			{ headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) },
		);
	} catch (err) {
		console.error("[proxy] searxng fetch failed:", err);
		return c.json({ error: "searxng unreachable" }, 502);
	}
	if (!res.ok) {
		return c.json({ error: `searxng ${res.status}` }, 502);
	}

	const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
	const results = (data.results ?? []).slice(0, limit).map((r) => ({
		title: (r.title as string) || "Untitled",
		url: r.url as string,
		snippet: (r.content as string) || (r.abstract as string) || "",
	}));
	return c.json({ results });
});

// Establish (or recover) an anonymous free-tier principal and return its token.
// The frontend calls this once, on the first owner-funded send, then uses the
// returned token as the proxy bearer for chat. This is the ONLY place a fresh $10
// is minted and the only place the grant gates run.
app.post("/anon-init", async (c) => {
	let body: Record<string, unknown> = {};
	try {
		body = (await c.req.json()) as Record<string, unknown>;
	} catch {
		// tolerate an empty/absent body — the gates below will fail closed
	}
	const presented = bearerOf(c) || (typeof body.token === "string" ? body.token : "");
	const ip = clientIp(c);

	// 1. Known token → continuity. Same browser on a new IP (VPN hop) keeps its
	//    balance; bind this IP to it so nobody else can grant on it.
	if (presented) {
		const p = db.getPrincipal(presented);
		if (p && p.tier === "free") {
			db.bindIp(ip, p.id);
			return c.json({ token: p.id, remaining: p.credit_remaining });
		}
		if (p && p.tier === "family") {
			return c.json({ token: p.id, remaining: p.credit_remaining });
		}
		// unknown token → fall through (cleared storage / spoofed); resolve by IP
	}

	// 2. IP already granted → adopt that principal (cleared/new browser, same IP).
	//    No fresh grant — this is what stops clear-storage-to-refarm.
	const bound = db.anonPrincipalForIp(ip);
	if (bound) {
		return c.json({ token: bound.id, remaining: bound.credit_remaining });
	}

	// 3. Genuinely new browser AND new IP → gated fresh grant.
	if (db.newIpGrantsToday() >= config.newIpPerDay) {
		return c.json(
			{
				error:
					"free-credit signups are maxed out for today — try again tomorrow, or add your own OpenRouter key for unlimited use",
			},
			429,
		);
	}
	if (!grantGatesPass({ honeypot: body.honeypot, elapsedMs: body.elapsedMs, botd: body.botd })) {
		return c.json(
			{ error: "couldn't verify your browser — add your own OpenRouter key to keep chatting" },
			403,
		);
	}
	const token = randomBytes(32).toString("hex");
	db.createPrincipal({
		id: token,
		type: "anon",
		upstreamKey: null,
		credit: config.freeGrant,
		tier: "free",
	});
	db.bindIp(ip, token);
	return c.json({ token, remaining: config.freeGrant });
});

app.post("/v1/chat/completions", async (c) => {
	const raw = await c.req.text();
	if (raw.length > config.maxInputChars) {
		return c.json({ error: "request too large" }, 413);
	}
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(raw);
	} catch {
		return c.json({ error: "invalid JSON body" }, 400);
	}

	// --- Resolve principal by bearer (spend-only — grants happen at /anon-init) ---
	const bearer = bearerOf(c);
	if (!bearer) {
		return c.json({ error: "no session — initialize a free grant or add your own key" }, 401);
	}
	const principal = db.getPrincipal(bearer);
	if (!principal) {
		return c.json({ error: "invalid or expired session token" }, 401);
	}

	let upstreamKey: string;
	if (principal.tier === "family") {
		if (principal.credit_remaining <= 0) {
			return c.json({ error: "family credit exhausted" }, 402);
		}
		if (db.familyMonthlySpend() >= config.familyMonthlyCap) {
			return c.json({ error: "family monthly capacity reached — resets next month" }, 503);
		}
		upstreamKey = principal.upstream_key ?? config.ownerKey;
	} else {
		if (principal.credit_remaining <= 0) {
			return c.json(
				{ error: "free credit used up — add your own OpenRouter key to keep chatting" },
				402,
			);
		}
		if (db.freeSpendToday() >= config.freeDailyCap) {
			return c.json(
				{ error: "the hosted free tier is at capacity for today — try again tomorrow or use your own key" },
				429,
			);
		}
		upstreamKey = config.ownerKey;
	}

	if (!upstreamKey) {
		return c.json({ error: "proxy is missing its upstream key" }, 500);
	}

	// Global monthly backstop across all metered spend.
	if (db.monthlySpend() >= config.monthlyCap) {
		return c.json(
			{
				error:
					"the hosted service is at monthly capacity — try again next month, or add your own OpenRouter key for unlimited use",
			},
			503,
		);
	}

	// --- Forward + meter -----------------------------------------------------
	const cap = config.maxTokensCap;
	const fwdBody: Record<string, unknown> = {
		...body,
		max_tokens: typeof body.max_tokens === "number" ? Math.min(body.max_tokens, cap) : cap,
		usage: { include: true },
	};
	const model = typeof body.model === "string" ? body.model : null;

	console.log(`[proxy] forwarding: tier=${principal.tier} model=${model ?? "?"} stream=${fwdBody.stream === true}`);
	const result = await forwardCompletion({
		base: config.openrouterBase,
		upstreamKey,
		body: fwdBody,
		timeoutMs: config.upstreamTimeoutMs,
	});

	// Meter once usage is known — runs in the background so it lands even after
	// the streamed response has been returned (or the client disconnected).
	result.usage
		.then((u) => {
			if (u) {
				db.recordUsage({
					principalId: principal.id,
					model,
					promptTokens: u.promptTokens,
					completionTokens: u.completionTokens,
					cost: u.cost,
				});
			}
		})
		.catch((err) => console.error("[proxy] metering failed:", err));

	if (!result.ok) {
		return new Response(result.clientText ?? "upstream error", {
			status: result.status,
			headers: { "Content-Type": result.contentType },
		});
	}
	if (result.stream && result.clientStream) {
		return new Response(result.clientStream, {
			status: 200,
			headers: { "Content-Type": result.contentType },
		});
	}
	return new Response(result.clientText ?? "", {
		status: 200,
		headers: { "Content-Type": result.contentType },
	});
});

app.post("/redeem", async (c) => {
	if (!config.provisioningKey) {
		return c.json({ error: "family tier not configured" }, 503);
	}
	let body: { code?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid JSON body" }, 400);
	}
	const code = typeof body.code === "string" ? body.code.trim() : "";
	if (!code) return c.json({ error: "missing code" }, 400);
	if (!db.codeExists(code)) return c.json({ error: "unknown code" }, 404);

	// Reserve the code atomically BEFORE the async mint so two concurrent
	// redemptions can't both succeed; release it if minting fails.
	const token = randomBytes(32).toString("hex");
	if (!db.claimCode(code, token)) {
		return c.json({ error: "code already redeemed" }, 409);
	}
	try {
		const { key } = await mintSubKey({
			base: config.openrouterBase,
			provisioningKey: config.provisioningKey,
			name: `myriapod-family-${code}`,
			limit: config.familyLimit,
		});
		db.createPrincipal({
			id: token,
			type: "token",
			upstreamKey: key,
			credit: config.familyLimit,
			tier: "family",
		});
		return c.json({ token });
	} catch (err) {
		db.releaseCode(code);
		console.error("[proxy] provisioning failed:", err);
		return c.json({ error: "could not provision family key" }, 502);
	}
});

// Serve only when run directly (`bun run server.ts`); importing the module (e.g.
// from tests) gives you `app` + `db` without binding a port.
if (import.meta.main) {
	if (!config.ownerKey) {
		console.warn("[proxy] WARNING: OWNER_OPENROUTER_KEY is empty — free-tier requests will fail.");
	}
	console.log(
		`[proxy] myriapod-proxy listening on http://${config.host}:${config.port} | ` +
			`origins=${config.allowedOrigins.join(", ")}`,
	);
	Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
}

export { app, db, voiceBroker };
