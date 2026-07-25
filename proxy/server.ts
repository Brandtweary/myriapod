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
import type { Usage } from "./openrouter";
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
	maxLeaseSec: config.voiceMaxLeaseSec,
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
registerVoiceRoutes(app, voiceBroker, clientIp);

/** The bearer token presented by the client, or "" if none. The legacy "anon"
 *  placeholder (sent before a real token exists) is treated as no-bearer. */
function bearerOf(c: Context): string {
	const auth = c.req.header("authorization") ?? "";
	const t = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
	return t === "anon" ? "" : t;
}

/** The client IP for per-IP limits + signup/continuity. Honors X-Forwarded-For ONLY
 *  when the direct socket peer is a configured trusted proxy (config.trustedProxies,
 *  or "*"). Untrusted → the real peer, so a client can't spoof its IP via XFF. */
function clientIp(c: Context): string {
	let peer = "unknown";
	try {
		peer = getConnInfo(c).remote.address ?? "unknown";
	} catch {
		peer = "unknown";
	}
	if (config.trustedProxies.length) {
		const trusted = config.trustedProxies.includes("*") || config.trustedProxies.includes(peer);
		if (trusted) {
			const xff = c.req.header("x-forwarded-for");
			if (xff) {
				// The trusted proxy APPENDS the real peer as the RIGHTMOST entry; anything to
				// its left is client-supplied and spoofable. With a single trusted hop (the TLS
				// terminator), the last entry is the real client. Never read the leftmost — that
				// is exactly what a spoofed X-Forwarded-For controls.
				const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
				if (parts.length) return parts[parts.length - 1]!;
			}
		}
	}
	return peer;
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

// Read-only usage telemetry: sessions, origin IPs, engagement minutes, credits —
// NO conversation content, ever. Bearer-gated by config.adminToken; when that's
// unset the route 404s, so an unconfigured deploy never exposes it. Purpose is
// operational visibility (is anyone using it? is a bot draining the owner key?).
app.get("/admin/telemetry", (c) => {
	if (!config.adminToken) return c.notFound();
	if (bearerOf(c) !== config.adminToken) return c.json({ error: "unauthorized" }, 401);
	return c.json(db.telemetry());
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

// In-memory per-IP sliding-window rate limit for the open embed passthrough.
// Same rationale as web-search: the memory pipeline calls it once per term write,
// so it's not principal-gated (CORS scopes browser callers); the window stops
// non-browser abuse. Not money, not metered; a restart resets the counts.
const EMBED_WINDOW_MS = 60_000;
const EMBED_MAX = 240; // higher than web-search: a busy turn embeds several terms
const EMBED_MAX_INPUTS = 64; // per-request array cap
const EMBED_MAX_INPUT_CHARS = 8192; // per-string cap
const embedHits = new Map<string, number[]>();
function embedRateLimited(ip: string): boolean {
	const now = Date.now();
	const cutoff = now - EMBED_WINDOW_MS;
	const hits = (embedHits.get(ip) ?? []).filter((t) => t > cutoff);
	hits.push(now);
	embedHits.set(ip, hits);
	return hits.length > EMBED_MAX;
}

// In-memory per-IP sliding-window rate limit for the cloud-audio passthroughs
// (/v1/audio/transcriptions + /v1/audio/speech). Unlike embed/web-search (which hit
// free self-hosted backends), these spend the owner key on OpenRouter — but the
// per-call cost is sub-cent (a whisper transcription ≈ $0.0015/min, a kokoro
// sentence a fraction of a cent), so a per-IP window bounding burst abuse is the
// guard, mirroring the open-passthrough posture. STT fires once per turn; TTS fires
// once per sentence, so the ceiling is generous. Not principal-metered.
const AUDIO_WINDOW_MS = 60_000;
const AUDIO_MAX = 120; // a chatty voice turn POSTs one TTS request per sentence
const AUDIO_MAX_TTS_INPUT_CHARS = 4000; // one sentence chunk; bounds a single speech spend
const audioHits = new Map<string, number[]>();
function audioRateLimited(ip: string): boolean {
	const now = Date.now();
	const cutoff = now - AUDIO_WINDOW_MS;
	const hits = (audioHits.get(ip) ?? []).filter((t) => t > cutoff);
	hits.push(now);
	audioHits.set(ip, hits);
	return hits.length > AUDIO_MAX;
}

// In-memory per-IP sliding-window rate limit for the email-signup form. A public
// endpoint (anyone can submit), so this is the only guard; not money, not metered.
const SUBSCRIBE_WINDOW_MS = 60_000;
const SUBSCRIBE_MAX = 5; // it's a single form submit — a handful a minute is plenty
const subscribeHits = new Map<string, number[]>();
function subscribeRateLimited(ip: string): boolean {
	const now = Date.now();
	const cutoff = now - SUBSCRIBE_WINDOW_MS;
	const hits = (subscribeHits.get(ip) ?? []).filter((t) => t > cutoff);
	hits.push(now);
	subscribeHits.set(ip, hits);
	return hits.length > SUBSCRIBE_MAX;
}

// A deliberately-loose email shape check — reject obvious garbage and bound the
// stored string; real deliverability isn't proven here (low-volume list, read by
// hand). RFC-5322 is not the goal.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_CHARS = 254;

// Per-IP brute-force guard for /redeem: a raw sliding-window cap PLUS an escalating
// backoff that lengthens with each failed (unknown-code) attempt. Both maps are
// in-memory + ephemeral and pruned by the periodic sweep below.
const REDEEM_WINDOW_MS = 60_000;
const REDEEM_MAX_PER_WINDOW = 12; // raw attempts/min per IP before a hard 429
const REDEEM_BACKOFF_BASE_MS = 2_000;
const REDEEM_BACKOFF_MAX_MS = 15 * 60_000;
const redeemHits = new Map<string, number[]>();
const redeemFailures = new Map<string, { count: number; blockedUntil: number }>();
function redeemRateLimited(ip: string): boolean {
	const now = Date.now();
	const f = redeemFailures.get(ip);
	if (f && now < f.blockedUntil) return true;
	const cutoff = now - REDEEM_WINDOW_MS;
	const hits = (redeemHits.get(ip) ?? []).filter((t) => t > cutoff);
	hits.push(now);
	redeemHits.set(ip, hits);
	return hits.length > REDEEM_MAX_PER_WINDOW;
}
function noteRedeemFailure(ip: string): void {
	const now = Date.now();
	const f = redeemFailures.get(ip) ?? { count: 0, blockedUntil: 0 };
	f.count += 1;
	f.blockedUntil = now + Math.min(REDEEM_BACKOFF_BASE_MS * 2 ** (f.count - 1), REDEEM_BACKOFF_MAX_MS);
	redeemFailures.set(ip, f);
}
function noteRedeemSuccess(ip: string): void {
	redeemFailures.delete(ip);
	redeemHits.delete(ip);
}

// Periodic eviction for the in-memory per-IP rate-limit maps so a flood of distinct
// IPs can't grow them without bound. Unref'd → never keeps the process (or a test run)
// alive. Sweeps expired sliding-window entries and lapsed backoff records.
const RATE_MAP_SWEEP_MS = 5 * 60_000;
function pruneWindowMap(map: Map<string, number[]>, windowMs: number): void {
	const cutoff = Date.now() - windowMs;
	for (const [ip, hits] of map) {
		const live = hits.filter((t) => t > cutoff);
		if (live.length) map.set(ip, live);
		else map.delete(ip);
	}
}
const rateMapSweeper = setInterval(() => {
	pruneWindowMap(webSearchHits, WEB_SEARCH_WINDOW_MS);
	pruneWindowMap(embedHits, EMBED_WINDOW_MS);
	pruneWindowMap(audioHits, AUDIO_WINDOW_MS);
	pruneWindowMap(subscribeHits, SUBSCRIBE_WINDOW_MS);
	pruneWindowMap(redeemHits, REDEEM_WINDOW_MS);
	const now = Date.now();
	for (const [ip, f] of redeemFailures) {
		if (now >= f.blockedUntil) redeemFailures.delete(ip);
	}
}, RATE_MAP_SWEEP_MS);
rateMapSweeper.unref?.();

// Open (rate-limited) embedding passthrough. Proxies text to the self-hosted
// embedding-inference container and returns the vectors — the browser can't reach
// the GPU-host localhost directly, and CORS forbids a cross-origin call. Mirrors
// the HF text-embeddings-inference `/embed` contract: {inputs: string[]} in, a
// number[][] out. NOT metered (self-hosted/free). Used by the memory pipeline's
// mint-time dedup (one call per term write).
app.post("/v1/embed", async (c) => {
	if (embedRateLimited(clientIp(c))) {
		return c.json({ error: "rate limit — slow down" }, 429);
	}
	let body: { inputs?: unknown };
	try {
		body = (await c.req.json()) as { inputs?: unknown };
	} catch {
		return c.json({ error: "invalid JSON body" }, 400);
	}
	const inputs = Array.isArray(body.inputs) ? body.inputs.filter((s) => typeof s === "string") : [];
	if (!inputs.length) return c.json({ error: "missing inputs (string[])" }, 400);
	// Bound the passthrough — it's an open door to a GPU host; CORS is not access control.
	if (inputs.length > EMBED_MAX_INPUTS) {
		return c.json({ error: `too many inputs (max ${EMBED_MAX_INPUTS})` }, 400);
	}
	if (inputs.some((s) => (s as string).length > EMBED_MAX_INPUT_CHARS)) {
		return c.json({ error: `input too long (max ${EMBED_MAX_INPUT_CHARS} chars each)` }, 400);
	}

	let res: Response;
	try {
		res = await fetch(`${config.embedBase}/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ inputs }),
			signal: AbortSignal.timeout(15000),
		});
	} catch (err) {
		console.error("[proxy] embed fetch failed:", err);
		return c.json({ error: "embed backend unreachable" }, 502);
	}
	if (!res.ok) {
		return c.json({ error: `embed backend ${res.status}` }, 502);
	}
	// text-embeddings-inference returns number[][] directly; pass it through.
	return c.json((await res.json()) as number[][]);
});

// Cloud speech-to-text. The browser POSTs the utterance as multipart/form-data
// (a 16-bit mono WAV under `file`), exactly the OpenAI transcription contract; we
// inject the owner key + the forced model and forward to OpenRouter's
// /audio/transcriptions, returning its {text, usage} JSON. The model is forced
// server-side so the owner key can never fund an arbitrary (expensive) STT model.
app.post("/v1/audio/transcriptions", async (c) => {
	if (audioRateLimited(clientIp(c))) {
		return c.json({ error: "rate limit — slow down" }, 429);
	}
	if (!config.ownerKey) {
		return c.json({ error: "proxy is missing its upstream key" }, 500);
	}
	let inForm: FormData;
	try {
		inForm = await c.req.formData();
	} catch {
		return c.json({ error: "expected multipart/form-data" }, 400);
	}
	const file = inForm.get("file");
	if (!(file instanceof Blob)) {
		return c.json({ error: "missing audio file" }, 400);
	}
	const outForm = new FormData();
	outForm.append("file", file, (file as File).name || "audio.wav");
	outForm.append("model", config.sttModel);
	outForm.append("response_format", "json");

	let res: Response;
	try {
		res = await fetch(`${config.openrouterBase}/audio/transcriptions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${config.ownerKey}` },
			body: outForm,
			// OpenRouter enforces a 60s upstream timeout on transcription; match it.
			signal: AbortSignal.timeout(60_000),
		});
	} catch (err) {
		console.error("[proxy] stt fetch failed:", err);
		return c.json({ error: "transcription backend unreachable" }, 502);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		console.error(`[proxy] ✗ stt upstream ${res.status} body=${body.slice(0, 500)}`);
		return c.json({ error: "transcription failed", status: res.status }, 502);
	}
	// Pass through {text, usage}; the browser reads only `.text`.
	return c.json((await res.json()) as Record<string, unknown>);
});

// Cloud text-to-speech. The browser POSTs {input, voice?, response_format?} for ONE
// sentence chunk (the SentenceChunker already split the reply); we inject the owner
// key + forced model and forward to OpenRouter's /audio/speech, streaming the raw
// audio bytes straight back. Default response_format is `pcm` (raw 16-bit LE mono
// 24 kHz — what the playback worklet consumes with no decode). The model + default
// voice are forced server-side (owner-key protection); the browser may only pick a
// voice the forced model exposes and mp3-vs-pcm.
app.post("/v1/audio/speech", async (c) => {
	if (audioRateLimited(clientIp(c))) {
		return c.json({ error: "rate limit — slow down" }, 429);
	}
	if (!config.ownerKey) {
		return c.json({ error: "proxy is missing its upstream key" }, 500);
	}
	let body: { input?: unknown; voice?: unknown; response_format?: unknown };
	try {
		body = (await c.req.json()) as typeof body;
	} catch {
		return c.json({ error: "invalid JSON body" }, 400);
	}
	const input = typeof body.input === "string" ? body.input : "";
	if (!input.trim()) return c.json({ error: "missing input text" }, 400);
	if (input.length > AUDIO_MAX_TTS_INPUT_CHARS) {
		return c.json({ error: `input too long (max ${AUDIO_MAX_TTS_INPUT_CHARS} chars)` }, 400);
	}
	const format = body.response_format === "mp3" ? "mp3" : "pcm";
	const upstreamBody: Record<string, unknown> = {
		model: config.ttsModel,
		input,
		voice: typeof body.voice === "string" && body.voice ? body.voice : config.ttsVoice,
		response_format: format,
	};
	// Pin the serving provider so OpenRouter can't route TTS to a slow instance — an
	// unpinned model may land on a provider that streams the clip out over tens of
	// seconds, wrecking the per-sentence latency the voice UX depends on.
	if (config.ttsProvider) {
		upstreamBody.provider = { order: [config.ttsProvider], allow_fallbacks: false };
	}

	let res: Response;
	try {
		res = await fetch(`${config.openrouterBase}/audio/speech`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.ownerKey}`,
			},
			body: JSON.stringify(upstreamBody),
			signal: AbortSignal.timeout(60_000),
		});
	} catch (err) {
		console.error("[proxy] tts fetch failed:", err);
		return c.json({ error: "speech backend unreachable" }, 502);
	}
	if (!res.ok || !res.body) {
		const errBody = await res.text().catch(() => "");
		console.error(`[proxy] ✗ tts upstream ${res.status} body=${errBody.slice(0, 500)}`);
		return c.json({ error: "speech synthesis failed", status: res.status }, 502);
	}
	// Stream the upstream audio straight through so the browser gets the first PCM
	// bytes at the upstream's time-to-first-byte and can start playing immediately
	// (the frontend paces frames as they arrive) — buffering the whole clip here would
	// hold every byte until synthesis finished, adding the full clip time to the
	// per-sentence latency. Bun.serve's raised idleTimeout keeps the passthrough from
	// being aborted mid-stream. Preserve the upstream content-type
	// (audio/pcm;rate=24000;channels=1 for pcm, audio/mpeg for mp3).
	return new Response(res.body, {
		status: 200,
		headers: { "Content-Type": res.headers.get("content-type") ?? "application/octet-stream" },
	});
});

// Feature-release email capture (About page). Open + rate-limited — a public form.
// Stores the address in the subscribers table; there is no newsletter client, the
// list is read by hand off the box. Idempotent on email (a re-submit is a no-op 200).
app.post("/subscribe", async (c) => {
	if (subscribeRateLimited(clientIp(c))) {
		return c.json({ error: "rate limit — slow down" }, 429);
	}
	let body: { email?: unknown };
	try {
		body = (await c.req.json()) as { email?: unknown };
	} catch {
		return c.json({ error: "invalid JSON body" }, 400);
	}
	const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
	if (!email || email.length > EMAIL_MAX_CHARS || !EMAIL_RE.test(email)) {
		return c.json({ error: "invalid email" }, 400);
	}
	db.addSubscriber(email, clientIp(c));
	return c.json({ ok: true });
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

// In-flight reserved spend per cap window, held only while requests are outstanding
// (added at reservation, removed once the true cost lands in usage_log or is refunded).
// The DB caps are SUM(usage_log) — blind to concurrent forwards not yet metered — so a
// burst could all pass the pre-check; adding these to the DB totals closes that gap.
// All reads/writes here are synchronous, so under Bun's single-threaded event loop the
// check-then-reserve section below is effectively atomic (no interleaving).
const inflight = { free: 0, monthly: 0, familyMonthly: 0 };

/** A conservative USD upper bound for one request: prompt bytes (≈4 chars/token) plus
 *  the generation ceiling, at the configured price ceiling. Used both to pre-reserve
 *  credit and as the fallback debit when a completion returns no usage. */
function estimateCostUsd(rawChars: number, maxTokens: number): number {
	const promptTokens = Math.ceil(rawChars / 4);
	return ((promptTokens + maxTokens) / 1_000_000) * config.costCeilPerMToken;
}

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

	const isFamily = principal.tier === "family";

	// Cheap balance guard with a tier-specific message, before the atomic reserve.
	if (principal.credit_remaining <= 0) {
		return c.json(
			isFamily
				? { error: "family credit exhausted" }
				: { error: "free credit used up — add your own OpenRouter key to keep chatting" },
			402,
		);
	}

	const upstreamKey = isFamily ? (principal.upstream_key ?? config.ownerKey) : config.ownerKey;
	if (!upstreamKey) {
		return c.json({ error: "proxy is missing its upstream key" }, 500);
	}

	// Model allowlist — the owner key must never fund an arbitrary model.
	const model = typeof body.model === "string" ? body.model : null;
	if (!model || !config.allowedModels.includes(model)) {
		return c.json({ error: "unsupported model" }, 400);
	}

	const cap = config.maxTokensCap;
	const maxTokens = typeof body.max_tokens === "number" ? Math.min(body.max_tokens, cap) : cap;
	const estimate = estimateCostUsd(raw.length, maxTokens);

	// --- Atomic admission ----------------------------------------------------
	// Cap checks (DB total + in-flight reservations) then an atomic credit reservation.
	// This runs entirely synchronously, so no concurrent forward can slip between the
	// check and the reserve (Bun's JS loop is single-threaded).
	if (isFamily) {
		if (db.familyMonthlySpend() + inflight.familyMonthly >= config.familyMonthlyCap) {
			return c.json({ error: "family monthly capacity reached — resets next month" }, 503);
		}
	} else if (db.freeSpendToday() + inflight.free >= config.freeDailyCap) {
		return c.json(
			{ error: "the hosted free tier is at capacity for today — try again tomorrow or use your own key" },
			429,
		);
	}
	if (db.monthlySpend() + inflight.monthly >= config.monthlyCap) {
		return c.json(
			{
				error:
					"the hosted service is at monthly capacity — try again next month, or add your own OpenRouter key for unlimited use",
			},
			503,
		);
	}
	if (!db.reserve(principal.id, estimate)) {
		return c.json(
			isFamily
				? { error: "family credit exhausted" }
				: { error: "free credit used up — add your own OpenRouter key to keep chatting" },
			402,
		);
	}
	inflight.monthly += estimate;
	if (isFamily) inflight.familyMonthly += estimate;
	else inflight.free += estimate;

	// Settle the reservation exactly once — reconcile to the true (or fallback) cost, or
	// refund it whole on an upstream error — and drop the in-flight amount.
	let settled = false;
	const releaseInflight = () => {
		inflight.monthly -= estimate;
		if (isFamily) inflight.familyMonthly -= estimate;
		else inflight.free -= estimate;
	};
	const reconcile = (cost: number, u: Usage | null) => {
		if (settled) return;
		settled = true;
		db.reconcileUsage({
			principalId: principal.id,
			model,
			promptTokens: u?.promptTokens ?? 0,
			completionTokens: u?.completionTokens ?? 0,
			cost,
			reserved: estimate,
		});
		releaseInflight();
	};
	const refund = () => {
		if (settled) return;
		settled = true;
		db.refundReservation(principal.id, estimate);
		releaseInflight();
	};

	// --- Forward -------------------------------------------------------------
	const fwdBody: Record<string, unknown> = {
		...body,
		max_tokens: maxTokens,
		usage: { include: true },
		// Enforce Zero Data Retention at the request layer — route only to ZDR
		// endpoints, independent of the account-level toggle (they OR together).
		provider: {
			...((body as Record<string, unknown>).provider as Record<string, unknown> | undefined),
			zdr: true,
		},
	};

	console.log(`[proxy] forwarding: tier=${principal.tier} model=${model} stream=${fwdBody.stream === true}`);
	let result;
	try {
		result = await forwardCompletion({
			base: config.openrouterBase,
			upstreamKey,
			body: fwdBody,
			timeoutMs: config.upstreamTimeoutMs,
		});
	} catch (err) {
		refund();
		console.error("[proxy] forward threw:", err);
		return c.json({ error: "upstream error", status: 502 }, 502);
	}

	if (!result.ok) {
		// Upstream failed — no real spend, so refund the reservation. The body is already
		// a generic {error,status} (openrouter.ts logs the raw upstream body server-side).
		refund();
		return new Response(result.clientText ?? JSON.stringify({ error: "upstream error", status: result.status }), {
			status: result.status,
			headers: { "Content-Type": result.contentType },
		});
	}

	// Success — reconcile once usage is known, in the background so it lands even after
	// the streamed response returns or the client disconnects. Missing usage → debit the
	// conservative fallback estimate rather than serving free compute.
	result.usage
		.then((u) => reconcile(u ? u.cost : estimate, u))
		.catch((err) => {
			console.error("[proxy] metering failed:", err);
			reconcile(estimate, null);
		});

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
	// Brute-force guard: /redeem is unauthenticated and codes are guessable, so throttle
	// per IP (sliding window) AND apply an escalating backoff after failed attempts. The
	// check runs BEFORE any code lookup or sub-key mint.
	const ip = clientIp(c);
	if (redeemRateLimited(ip)) {
		return c.json({ error: "too many attempts — slow down" }, 429);
	}
	let body: { code?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid JSON body" }, 400);
	}
	const code = typeof body.code === "string" ? body.code.trim() : "";
	if (!code) return c.json({ error: "missing code" }, 400);
	if (!db.codeExists(code)) {
		noteRedeemFailure(ip);
		return c.json({ error: "unknown code" }, 404);
	}

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
		noteRedeemSuccess(ip);
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
	// idleTimeout must exceed the longest upstream wait — the client connection sits
	// idle while we await OpenRouter (up to the 120s chat timeout / 60s audio timeout),
	// and Bun.serve's 10s default would otherwise abort the response mid-flight (a slow
	// audio synthesis or a long reasoning delay before the first chat token). 255 is
	// Bun's max.
	Bun.serve({ hostname: config.host, port: config.port, idleTimeout: 255, fetch: app.fetch });
}

export { app, db, voiceBroker };
