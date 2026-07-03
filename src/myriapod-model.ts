import type { Model } from "@earendil-works/pi-ai";

// One hardcoded chat model: GLM 5.2 (frontier) over OpenRouter. There is no model
// picker — the audience never sees or chooses it. The same model serves BOTH the
// chat agent and the three per-turn pipeline agents (audit/memory/summary); one
// model keeps the moving parts down.
//
// Three serving paths reach it (resolved in main.ts: resolveServingPath):
//   own-key → the visitor's own OpenRouter key, calling OpenRouter DIRECTLY (no proxy)
//   family  → a redeemed family token, through the metering proxy
//   anon    → a minted $10 free-tier token, through the metering proxy
// The own-key path uses MYRIAPOD_MODEL (baseUrl = OpenRouter direct); the owner-funded
// paths use proxyChatModel() (baseUrl = the proxy). The proxy holds the real owner key
// server-side — no key ever reaches the browser.

// GLM 5.2's OpenRouter model id (z-ai). 1M context.
export const MYRIAPOD_MODEL_ID = "z-ai/glm-5.2";

// The own-key serving path: GLM 5.2 called DIRECTLY against OpenRouter with the
// visitor's own key. provider "openrouter" makes pi-ai emit the OpenRouter reasoning
// format (`reasoning: { effort }`) and parse OpenRouter usage.
//
// reasoning MUST be `true` even though we want thinking OFF: pi-ai only emits a
// reasoning field when `model.reasoning` is truthy (openai-completions.js buildParams).
// With reasoning:false it sends NOTHING and GLM falls back to its default — thinking ON
// (verified: 122 reasoning tokens on a 3-word prompt). With reasoning:true +
// THINKING_LEVEL "off", pi-ai emits `reasoning: { effort: "none" }`, which GLM honors as
// OFF (verified via the proxy: effort:"none" → 0 reasoning tokens; effort:"minimal"/"low"
// actually ADD reasoning). Snappiness is load-bearing for a spoken agent; flip
// THINKING_LEVEL to a real effort here if answer quality ever needs it.
//
// cost is USD per million tokens — APPROXIMATE (GLM 5.2's OpenRouter price; the proxy
// meters the TRUE per-call cost from OpenRouter's usage, so this only feeds the UI
// stats line). maxTokens is a generation ceiling, not a target (the proxy also caps it).
export const MYRIAPOD_MODEL: Model<"openai-completions"> = {
	id: MYRIAPOD_MODEL_ID,
	name: "GLM 5.2",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.1, output: 3.4, cacheRead: 0.275, cacheWrite: 1.1 },
	contextWindow: 1_000_000,
	maxTokens: 8_192,
};

// Reasoning off for snappiness (see the long note on MYRIAPOD_MODEL.reasoning). "off"
// → pi-ai sends `reasoning: { effort: "none" }` → GLM does not think.
export const MYRIAPOD_THINKING_LEVEL = "off" as const;

// --- Owner-funded path: the metering proxy ---------------------------------
// The owner-funded serving paths (anonymous + family) route chat AND ingestion through
// our Bun proxy instead of calling OpenRouter directly; the own-key path bypasses it.
// Override the URL at build time via VITE_PROXY_BASE.
const ENV = import.meta.env as Record<string, string | undefined>;
export const MYRIAPOD_PROXY_BASE = ENV.VITE_PROXY_BASE ?? "http://127.0.0.1:8790/v1";

// A provider id distinct from "openrouter" so the own-key path's stored OpenRouter key
// and the proxy's auth token never share a providerKeys slot.
export const MYRIAPOD_PROXY_PROVIDER = "myriapod";

// GLM 5.2 pointed at the proxy. pi-ai auto-detects a non-openrouter.ai baseUrl as plain
// OpenAI and would emit `reasoning_effort`; we pin thinkingFormat "openrouter" so the
// forwarded body carries `reasoning: { effort }` — byte-identical to the proven direct
// path (the proxy passes it through to OpenRouter verbatim). Everything else (including
// reasoning:true) is inherited from MYRIAPOD_MODEL.
export function proxyChatModel(): Model<"openai-completions"> {
	return {
		...MYRIAPOD_MODEL,
		provider: MYRIAPOD_PROXY_PROVIDER,
		baseUrl: MYRIAPOD_PROXY_BASE,
		compat: { thinkingFormat: "openrouter" },
	};
}
