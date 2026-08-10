// Proxy configuration, read from the environment (Bun auto-loads .env).
// Shared by server.ts and mint-code.ts.

function num(name: string, fallback: number): number {
	const v = process.env[name];
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

// The streaming-TTS endpoints the broker load-balances voice sessions across. Set
// VOICE_TTS_ENDPOINTS to a JSON array of {ttsUrl} to run several (distinguished by URL
// path on the same origin). When unset, a SINGLE endpoint is built from
// VOICE_TTS_BASE (defaulting to the dev WS target).
function parseTtsEndpoints(): { ttsUrl: string }[] {
	const raw = process.env.VOICE_TTS_ENDPOINTS;
	if (raw && raw.trim()) {
		try {
			const arr = JSON.parse(raw) as unknown;
			if (Array.isArray(arr)) {
				const cleaned = arr
					.filter((x): x is { ttsUrl: string } => !!x && typeof x.ttsUrl === "string")
					.map((x) => ({ ttsUrl: x.ttsUrl }));
				if (cleaned.length) return cleaned;
			}
		} catch {
			// malformed → fall back to the single-endpoint default below
		}
	}
	return [{ ttsUrl: process.env.VOICE_TTS_BASE ?? "ws://localhost:8123/api/tts_streaming" }];
}

export const config = {
	// OpenRouter keys (validated lazily — mint-code.ts doesn't need them).
	ownerKey: process.env.OWNER_OPENROUTER_KEY ?? "",
	provisioningKey: process.env.OPENROUTER_PROVISIONING_KEY ?? "",
	familyLimit: num("FAMILY_LIMIT", 100),

	// Bearer token gating the read-only /admin/telemetry endpoint. Empty (default)
	// → the endpoint is disabled (404), so an unconfigured deploy never exposes it.
	// Set ADMIN_TOKEN in prod to enable read-only usage stats (no chat content).
	adminToken: process.env.ADMIN_TOKEN ?? "",

	// Free tier.
	freeGrant: num("FREE_GRANT_USD", 10),
	freeDailyCap: num("FREE_DAILY_CAP_USD", 50),
	newIpPerDay: num("NEW_IP_PER_DAY", 5),

	// Monthly backstops the proxy enforces (OpenRouter can't give aggregate caps).
	// Generous by design — bump as needed. familyMonthlyCap covers all family
	// tokens together; monthlyCap is the overall ceiling across free + family.
	familyMonthlyCap: num("FAMILY_MONTHLY_CAP_USD", 200),
	monthlyCap: num("MONTHLY_CAP_USD", 300),

	// Request limits.
	maxTokensCap: num("MAX_TOKENS_CAP", 32000),
	maxInputChars: num("MAX_INPUT_CHARS", 200000),
	// Conservative $/1M-token ceiling used to pre-reserve credit before forwarding
	// (the spend-cap reservation) and as the fallback debit when a completion returns
	// no usage chunk. An upper bound on real per-token price, not the true cost.
	costCeilPerMToken: num("COST_CEIL_PER_MTOKEN", 16),
	// Server-side allowlist of model ids the owner-funded paths may request. Comma-
	// separated; defaults to the single hardcoded frontend model.
	allowedModels: (process.env.ALLOWED_MODELS ?? "moonshotai/kimi-k3")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
	// Hard ceiling on a single upstream (OpenRouter) request, including the streamed
	// body. Bounds a forward stuck on a dead connection (e.g. the client changed
	// networks / dropped a VPN mid-stream) so it fails fast instead of hanging.
	upstreamTimeoutMs: num("UPSTREAM_TIMEOUT_MS", 120000),

	// Wiring.
	openrouterBase: process.env.OPENROUTER_BASE ?? "https://openrouter.ai/api/v1",
	// Self-hosted SearXNG backing the auth-gated /v1/web-search route. Defaults to
	// a local instance (which must serve JSON); prod overrides to the GPU host.
	searxngBase: process.env.SEARXNG_BASE ?? "http://127.0.0.1:8888",
	// The embedding-inference container backing /v1/embed (memory dedup). Defaults
	// to a local text-embeddings-inference instance; prod overrides to the GPU host.
	embedBase: process.env.EMBED_BASE ?? "http://127.0.0.1:8899",
	allowedOrigins: (process.env.ALLOWED_ORIGIN ?? "http://localhost:5173")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
	// Direct peers whose X-Forwarded-For header is trusted (the reverse proxy / tunnel
	// terminating TLS in front of us). Comma-separated peer IPs, or "*" to trust any
	// peer's XFF. EMPTY (default) → never trust XFF; use the real socket peer. Trusting
	// XFF blindly lets any client spoof its IP and defeat every per-IP guard.
	trustedProxies: (process.env.TRUSTED_PROXY ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
	dbPath: process.env.DB_PATH ?? "./myriapod-proxy.db",
	host: process.env.HOST ?? "0.0.0.0",
	port: num("PORT", 8790),

	// --- Voice-session broker -------------------------------------------------
	// The streaming-TTS endpoints to load-balance voice sessions across (see
	// parseTtsEndpoints). Capacity is how many simultaneous voice sessions ONE such
	// endpoint is declared to carry — an operator judgment the broker enforces, not a
	// value any backend reports; 1 is the conservative default for a single-GPU TTS
	// server. STT is a shared stateless HTTP endpoint and is not leased.
	voiceTtsEndpoints: parseTtsEndpoints(),
	voiceTtsSessionCapacity: num("VOICE_TTS_SESSION_CAPACITY", 1),
	voiceHeartbeatSec: num("VOICE_HEARTBEAT_SEC", 60),
	// Absolute lease lifetime (seconds). A lease is reclaimed once it exceeds this age
	// REGARDLESS of heartbeats, so a client can't hold a TTS slot forever by beating.
	voiceMaxLeaseSec: num("VOICE_MAX_LEASE_SEC", 1800),
};
