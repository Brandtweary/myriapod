/**
 * Lean replacement for pi-ai's side-effectful `/compat` barrel.
 *
 * The real `@earendil-works/pi-ai/compat` runs `registerBuiltInApiProviders()`
 * at import time — instantiating every builtin provider API and statically
 * pulling `providers/all` (all ~40 provider catalogs + the image-generation
 * surface) into the main chunk, even though Myriapod only ever drives the
 * `openai-completions` API (Kimi K3 over OpenRouter / the metering proxy). The
 * pi-ai README itself says to avoid the barrel in bundled apps for this reason.
 *
 * This module re-exports the exact surface the app + pi-agent-core consume from
 * `/compat`, sourced from the direct, side-effect-free entrypoints:
 *   - streaming: pi-ai's own lazy wrapper for `openai-completions` (the one api
 *     in use), so the OpenAI SDK stays a deferred chunk loaded on first stream
 *     rather than eagerly weighting the main bundle;
 *   - catalog reads: the static getters from `providers/all` (only the tiny
 *     generated model catalog is retained; the provider factories tree-shake);
 *   - everything else (types, `EventStream`, `validateToolArguments`, model
 *     helpers): the main `@earendil-works/pi-ai` entry, which has no side effects.
 *
 * A Vite alias (vite.config.ts) redirects `@earendil-works/pi-ai/compat` here so
 * pi-agent-core — an npm dep that also imports the barrel from its agent loop —
 * resolves to this lean surface too. The provider SDK fan-out (anthropic /
 * google / mistral / bedrock chunks) then drops out of the graph entirely.
 */
export * from "@earendil-works/pi-ai";
export {
	getBuiltinModel as getModel,
	getBuiltinModels as getModels,
	getBuiltinProviders as getProviders,
} from "@earendil-works/pi-ai/providers/all";

import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

// One lazy wrapper instance, shared by every importer (app + aliased agent core)
// so the `streamFn === streamSimple` default-detection identity check in
// AgentInterface still holds.
const openaiCompletions = openAICompletionsApi();

export const stream = openaiCompletions.stream;
export const streamSimple = openaiCompletions.streamSimple;

/** compat's `complete`: run a full stream and await its assembled result. */
export function complete(
	model: Model<Api>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	return openaiCompletions.stream(model, context, options).result();
}
