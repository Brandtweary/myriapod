import type { Model } from "@earendil-works/pi-ai";

// The chat model is hardcoded — no picker. Cymbiont Web is not "Pi on the web";
// the audience is non-technical (family), so the model is an implementation
// detail they never see or choose.
//
// DeepSeek V4 (Pro/Flash) is NOT in pi-ai 0.75.3's frozen model registry (it
// shipped after that release and was never backfilled), so `getModel()` returns
// undefined for it. We construct the `Model` literal directly instead. The
// OpenAI-completions provider auto-detects OpenRouter behavior from the
// openrouter.ai baseUrl (thinking → `reasoning: { effort }`).
//
// Specs pulled from OpenRouter's /api/v1/models (Jun 2026). Cost is USD per
// million tokens, matching pi-ai's registry convention.

// Production model. Smarter, ~5x the price of Flash.
export const DEEPSEEK_V4_PRO: Model<"openai-completions"> = {
	id: "deepseek/deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435 },
	contextWindow: 1_048_576,
	maxTokens: 32_000, // generation ceiling (covers reasoning + answer); tune as needed
};

// Dev/prototyping model. ~5x cheaper, same family, same 1M context.
export const DEEPSEEK_V4_FLASH: Model<"openai-completions"> = {
	id: "deepseek/deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.09, output: 0.18, cacheRead: 0.02, cacheWrite: 0.09 },
	contextWindow: 1_048_576,
	maxTokens: 32_000,
};

// ACTIVE model. Flash while building; swap to DEEPSEEK_V4_PRO for production.
export const CYMBIONT_MODEL = DEEPSEEK_V4_FLASH;

// Reasoning is always on at "high". DeepSeek V4 only honors high/xhigh effort,
// and xhigh is buggy upstream (maps to an invalid "max" effort that OpenRouter
// rejects). "high" is the right default for ~99% of users and there is no
// selector — the audience shouldn't have to think about thinking.
export const CYMBIONT_THINKING_LEVEL = "high" as const;
