// cymbiont-proxy — metered OpenAI-compatible inference proxy.
//
// Holds the owner OpenRouter key server-side; the browser never sees it. Every
// /v1/chat/completions call resolves a principal (anonymous-by-IP or family-by-
// token), checks credit + caps, injects the right upstream key, forwards to
// OpenRouter, and debits the measured cost. The own-key path doesn't come here
// at all — the browser calls OpenRouter directly with the user's own key.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getConnInfo } from "hono/bun";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { Db } from "./db";
import { forwardCompletion, mintSubKey } from "./openrouter";
import {
	challengeEnabled,
	createChallenge,
	redeemChallenge,
	verifyChallenge,
} from "./challenge";
import type { Context } from "hono";

const db = new Db(config.dbPath);
const app = new Hono();

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

app.get("/health", (c) => c.json({ ok: true, challenge: challengeEnabled }));

// Current principal's remaining hosted credit (for the Access settings readout).
// IP principal that hasn't chatted yet reports the full grant (not yet created).
app.get("/balance", (c) => {
	const auth = c.req.header("authorization") ?? "";
	const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
	if (bearer !== "" && bearer !== "anon") {
		const p = db.getPrincipal(bearer);
		if (!p || p.type !== "token") return c.json({ error: "invalid token" }, 401);
		return c.json({ tier: "family", remaining: p.credit_remaining, grant: config.familyLimit });
	}
	const p = db.getPrincipal(clientIp(c));
	return c.json({
		tier: "free",
		remaining: p ? p.credit_remaining : config.freeGrant,
		grant: config.freeGrant,
	});
});

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

	// --- Resolve principal + upstream key -----------------------------------
	const auth = c.req.header("authorization") ?? "";
	const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
	const isFamily = bearer !== "" && bearer !== "anon";

	let principalId: string;
	let upstreamKey: string;

	if (isFamily) {
		const principal = db.getPrincipal(bearer);
		if (!principal || principal.type !== "token") {
			return c.json({ error: "invalid family token" }, 401);
		}
		if (principal.credit_remaining <= 0) {
			return c.json({ error: "family credit exhausted" }, 402);
		}
		if (db.familyMonthlySpend() >= config.familyMonthlyCap) {
			return c.json({ error: "family monthly capacity reached — resets next month" }, 503);
		}
		principalId = principal.id;
		upstreamKey = principal.upstream_key ?? config.ownerKey;
	} else {
		const ip = clientIp(c);
		let principal = db.getPrincipal(ip);
		if (!principal) {
			// First touch from this IP → grant free credit (gated).
			if (db.newIpGrantsToday() >= config.newIpPerDay) {
				return c.json(
					{
						error:
							"free-credit signups are maxed out for today — try again tomorrow, or add your own OpenRouter key for unlimited use",
					},
					429,
				);
			}
			const ok = await verifyChallenge(c.req.header("x-challenge-token") ?? undefined);
			if (!ok) return c.json({ error: "human verification required" }, 403);
			db.createPrincipal({
				id: ip,
				type: "ip",
				upstreamKey: null,
				credit: config.freeGrant,
				tier: "free",
			});
			principal = db.getPrincipal(ip)!;
		}
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
		principalId = principal.id;
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

	const result = await forwardCompletion({
		base: config.openrouterBase,
		upstreamKey,
		body: fwdBody,
	});

	// Meter once usage is known — runs in the background so it lands even after
	// the streamed response has been returned (or the client disconnected).
	result.usage
		.then((u) => {
			if (u) {
				db.recordUsage({
					principalId,
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
			name: `cymbiont-family-${code}`,
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

// Cap challenge endpoints for the widget — only mounted when the challenge is on.
if (challengeEnabled) {
	app.post("/challenge", (c) => c.json(createChallenge()));
	app.post("/redeem-challenge", async (c) => c.json(await redeemChallenge(await c.req.json())));
}

if (!config.ownerKey) {
	console.warn("[proxy] WARNING: OWNER_OPENROUTER_KEY is empty — free-tier requests will fail.");
}
console.log(
	`[proxy] cymbiont-proxy listening on http://${config.host}:${config.port} | ` +
		`challenge=${challengeEnabled ? "on" : "off"} | origins=${config.allowedOrigins.join(", ")}`,
);

Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });

export { app, db };
