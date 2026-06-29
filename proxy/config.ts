// Proxy configuration, read from the environment (Bun auto-loads .env).
// Shared by server.ts and mint-code.ts.

function num(name: string, fallback: number): number {
	const v = process.env[name];
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
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
	allowedOrigins: (process.env.ALLOWED_ORIGIN ?? "http://localhost:5173")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
	dbPath: process.env.DB_PATH ?? "./cymbiont-proxy.db",
	host: process.env.HOST ?? "0.0.0.0",
	port: num("PORT", 8790),
};
