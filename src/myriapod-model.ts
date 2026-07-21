import type { Model } from "@earendil-works/pi-ai";

// One hardcoded chat model: Kimi K3 (frontier, open-weight) over OpenRouter. There is
// no model picker — the audience never sees or chooses it. The same model serves BOTH
// the chat agent and the three per-turn pipeline agents (audit/memory/summary); one
// model keeps the moving parts down.
//
// Three serving paths reach it (resolved in main.ts: resolveServingPath):
//   own-key → the visitor's own OpenRouter key, calling OpenRouter DIRECTLY (no proxy)
//   family  → a redeemed family token, through the metering proxy
//   anon    → a minted $10 free-tier token, through the metering proxy
// The own-key path uses MYRIAPOD_MODEL (baseUrl = OpenRouter direct); the owner-funded
// paths use proxyChatModel() (baseUrl = the proxy). The proxy holds the real owner key
// server-side — no key ever reaches the browser.

// Kimi K3's OpenRouter model id (moonshotai). 1M context.
export const MYRIAPOD_MODEL_ID = "moonshotai/kimi-k3";

// Kimi K3 has exactly ONE reasoning mode: always on, and OpenRouter accepts only the
// wire effort "max" (more levels "coming soon"). There is no way to turn thinking off, so
// the chat agent reasons on every turn too — Kimi's inference is fast enough (adaptive
// thinking + high token throughput) that the always-on latency is acceptable for the
// voice cascade.
//
// pi-ai's effort vocabulary is off/minimal/low/medium/high/xhigh — there is NO "max". So
// thinkingLevelMap translates the level we request into the wire value "max": requesting
// level "high" emits `reasoning: { effort: "max" }`, the only value Kimi honors. reasoning
// MUST stay `true` — pi-ai only emits a reasoning field when model.reasoning is truthy
// (buildParams in openai-completions.js).
//
// The single wire effort Kimi accepts. Exported for the hand-built ingest path
// (kg/ingest.ts makeCompletion), which sets `reasoning.effort` directly rather than going
// through pi-ai's thinkingLevelMap.
export const MYRIAPOD_REASONING_EFFORT = "max" as const;
//
// cost is USD per million tokens — APPROXIMATE (Kimi K3's OpenRouter price; the proxy
// meters the TRUE per-call cost from OpenRouter's usage, so this only feeds the UI stats
// line). maxTokens is a generation ceiling, not a target (the proxy also caps it).
export const MYRIAPOD_MODEL: Model<"openai-completions"> = {
	id: MYRIAPOD_MODEL_ID,
	name: "Kimi K3",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	thinkingLevelMap: { high: MYRIAPOD_REASONING_EFFORT },
	input: ["text"],
	cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.0 },
	contextWindow: 1_000_000,
	maxTokens: 8_192,
};

// The chat agent's thinking level. "high" is the sole level thinkingLevelMap translates to
// Kimi's "max" wire effort — Kimi is always-on, so there is no "off" to choose.
export const MYRIAPOD_THINKING_LEVEL = "high" as const;

// --- Owner-funded path: the metering proxy ---------------------------------
// The owner-funded serving paths (anonymous + family) route chat AND ingestion through
// our Bun proxy instead of calling OpenRouter directly; the own-key path bypasses it.
// Override the URL at build time via VITE_PROXY_BASE.
const ENV = import.meta.env as Record<string, string | undefined>;
export const MYRIAPOD_PROXY_BASE = ENV.VITE_PROXY_BASE ?? "http://127.0.0.1:8790/v1";

// A provider id distinct from "openrouter" so the own-key path's stored OpenRouter key
// and the proxy's auth token never share a providerKeys slot.
export const MYRIAPOD_PROXY_PROVIDER = "myriapod";

// Kimi K3 pointed at the proxy. pi-ai auto-detects a non-openrouter.ai baseUrl as plain
// OpenAI and would emit `reasoning_effort`; we pin thinkingFormat "openrouter" so the
// forwarded body carries `reasoning: { effort }` — byte-identical to the direct path (the
// proxy passes it through to OpenRouter verbatim). Everything else (including reasoning:true
// and thinkingLevelMap) is inherited from MYRIAPOD_MODEL.
export function proxyChatModel(): Model<"openai-completions"> {
	return {
		...MYRIAPOD_MODEL,
		provider: MYRIAPOD_PROXY_PROVIDER,
		baseUrl: MYRIAPOD_PROXY_BASE,
		compat: { thinkingFormat: "openrouter" },
	};
}
