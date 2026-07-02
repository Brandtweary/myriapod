// Proxy configuration, read from the environment (Bun auto-loads .env).
// Shared by server.ts and mint-code.ts.

function num(name: string, fallback: number): number {
	const v = process.env[name];
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

// The moshi voice instances the broker load-balances across. Prod sets VOICE_INSTANCES
// to a JSON array of {sttUrl, ttsUrl} pairs (two instances, distinguished by URL path
// on the same origin). When unset, a SINGLE instance is built from VOICE_STT_BASE /
// VOICE_TTS_BASE (defaulting to the dev WS targets) so staging behaves exactly like the
// current single-instance demo.
function parseVoiceInstances(): { sttUrl: string; ttsUrl: string }[] {
	const raw = process.env.VOICE_INSTANCES;
	if (raw && raw.trim()) {
		try {
			const arr = JSON.parse(raw) as unknown;
			if (Array.isArray(arr)) {
				const cleaned = arr
					.filter(
						(x): x is { sttUrl: string; ttsUrl: string } =>
							!!x && typeof x.sttUrl === "string" && typeof x.ttsUrl === "string",
					)
					.map((x) => ({ sttUrl: x.sttUrl, ttsUrl: x.ttsUrl }));
				if (cleaned.length) return cleaned;
			}
		} catch {
			// malformed → fall back to the single-instance default below
		}
	}
	return [
		{
			sttUrl: process.env.VOICE_STT_BASE ?? "ws://localhost:8123/api/asr-streaming",
			ttsUrl: process.env.VOICE_TTS_BASE ?? "ws://localhost:8123/api/tts_streaming",
		},
	];
}

export const config = {
	// OpenRouter keys (validated lazily — mint-code.ts doesn't need them).
	ownerKey: process.env.OWNER_OPENROUTER_KEY ?? "",
	provisioningKey: process.env.OPENROUTER_PROVISIONING_KEY ?? "",
	familyLimit: num("FAMILY_LIMIT", 100),

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
	// Hard ceiling on a single upstream (OpenRouter) request, including the streamed
	// body. Bounds a forward stuck on a dead connection (e.g. the client changed
	// networks / dropped a VPN mid-stream) so it fails fast instead of hanging.
	upstreamTimeoutMs: num("UPSTREAM_TIMEOUT_MS", 120000),

	// Wiring.
	openrouterBase: process.env.OPENROUTER_BASE ?? "https://openrouter.ai/api/v1",
	// Self-hosted SearXNG backing the auth-gated /v1/web-search route. Defaults to
	// the local NixOS instance (serves JSON); prod overrides to the GPU-host instance.
	searxngBase: process.env.SEARXNG_BASE ?? "http://127.0.0.1:8888",
	// The embedding-inference container backing /v1/embed (memory dedup). Defaults
	// to a local text-embeddings-inference instance; prod overrides to the GPU host.
	embedBase: process.env.EMBED_BASE ?? "http://127.0.0.1:8899",
	allowedOrigins: (process.env.ALLOWED_ORIGIN ?? "http://localhost:5173")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
	dbPath: process.env.DB_PATH ?? "./myriapod-proxy.db",
	host: process.env.HOST ?? "0.0.0.0",
	port: num("PORT", 8790),

	// --- Voice-session broker -------------------------------------------------
	// The moshi instances to load-balance voice sessions across (see
	// parseVoiceInstances). Per-instance capacity = the moshi STT batch_size; the
	// current live config runs stt batch_size=1, so 1 is the default. Prod with two
	// instances sets a higher batch_size and matches it here.
	voiceInstances: parseVoiceInstances(),
	voiceInstanceCapacity: num("VOICE_INSTANCE_CAPACITY", 1),
	voiceHeartbeatSec: num("VOICE_HEARTBEAT_SEC", 60),
};
