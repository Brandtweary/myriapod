import type { Model } from "@earendil-works/pi-ai";

// One hardcoded chat model: the open-weight LLM served by the self-hosted vLLM
// behind the voice stack's traefik `/llm` route. There is no model picker — the
// audience (non-technical) never sees or chooses it, and the whole app speaks to a
// single local endpoint. The same OpenAI-compatible endpoint serves BOTH typed
// chat here and personal-graph ingestion.
//
// Dev: the browser reaches the host through an SSH tunnel (localhost:8123 → the
// stack's traefik). Prod: same-origin `/llm` behind the deployed traefik + TLS.
// Override the base at build time with VITE_LLM_BASE.
const ENV = import.meta.env as Record<string, string | undefined>;
export const CYMBIONT_LLM_BASE = ENV.VITE_LLM_BASE ?? "http://127.0.0.1:8123/llm/v1";

// vLLM serves the model under its bare HF id (no --served-model-name override).
export const CYMBIONT_MODEL_ID = "Qwen/Qwen3.5-9B";

// A provider id distinct from "openrouter" so pi-ai treats `model.baseUrl` as a
// plain OpenAI-compatible endpoint (no openrouter.ai reasoning-format autodetect).
// vLLM needs no API key; we seed a throwaway bearer in this provider's key slot so
// pi-web-ui's pre-send key check passes (the server ignores the value).
export const CYMBIONT_PROVIDER = "cymbiont";
export const CYMBIONT_PROVIDER_KEY = "local";

// Reasoning is off: the local model runs with thinking disabled server-side, so we
// never emit a reasoning_effort field and the agent's thinking level is "off".
export const CYMBIONT_THINKING_LEVEL = "off" as const;

// Local inference has no per-token cost. Zeroed so the framework's stats line shows
// $0 rather than a fabricated price.
export const CYMBIONT_MODEL: Model<"openai-completions"> = {
	id: CYMBIONT_MODEL_ID,
	name: "Cymbiont (local)",
	api: "openai-completions",
	provider: CYMBIONT_PROVIDER,
	baseUrl: CYMBIONT_LLM_BASE,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 2_048,
};
