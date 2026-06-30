// The browser client half of the web-search tool. A separate component owns the
// proxy endpoint; this codes to that contract:
//   GET <endpoint>?q=<query>&limit=<n>
//   Authorization: Bearer <proxy principal token>   (anon/family only — optional)
//   → { results: [{ title, url, snippet }] }
// Web search is universal — registered on every serving path (see main.ts createAgent).
// The endpoint is open (per-IP rate-limited, not principal-gated): owner-funded paths
// pass their proxy bearer; own-key visitors pass NO bearer, so the Authorization header
// is omitted entirely and their OpenRouter key never reaches the proxy.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRenderer } from "@earendil-works/pi-web-ui";
import { registerToolRenderer, renderHeader } from "@earendil-works/pi-web-ui";
import { Globe } from "lucide";
import { type Static, Type } from "typebox";

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

// Fetch web results through the metering proxy. Throws on a non-OK response or a
// timeout so the agent loop synthesizes an error result.
export async function webSearch(
	endpoint: string,
	bearer: string,
	query: string,
	limit = 8,
): Promise<WebSearchResult[]> {
	const url = `${endpoint}?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`;
	const res = await fetch(url, {
		// Only attach Authorization when we actually hold a bearer (anon/family). Own-key
		// visitors pass "" — sending an empty/garbage bearer would leak nothing useful and
		// the endpoint is open anyway.
		headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
		signal: AbortSignal.timeout(15000),
	});
	if (!res.ok) throw new Error(`web search failed: HTTP ${res.status}`);
	const data = (await res.json()) as { results?: WebSearchResult[] };
	return data.results ?? [];
}

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The search query." }),
	limit: Type.Optional(Type.Number({ description: "Max results (default 8, capped at 8)." })),
});

export function createWebSearchTool(opts: { endpoint: string; getBearer: () => string }): AgentTool<typeof webSearchSchema> {
	return {
		name: "web_search",
		label: "Web search",
		description:
			"Search the web for current information beyond what you already know — recent events, " +
			"specific facts, anything that needs a live lookup. Returns a short list of titled results " +
			"with links and snippets.",
		parameters: webSearchSchema,
		execute: async (_id, params: Static<typeof webSearchSchema>) => {
			const limit = Math.min(Math.max(params.limit ?? 8, 1), 8);
			const results = await webSearch(opts.endpoint, opts.getBearer(), params.query, limit);
			const text = results.length
				? results
						.slice(0, limit)
						.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${(r.snippet ?? "").slice(0, 200)}`)
						.join("\n\n")
				: `No web results for "${params.query}".`;
			return {
				content: [{ type: "text", text }],
				details: { results: results.map((r) => ({ title: r.title, url: r.url })) },
			};
		},
	};
}

const webSearchRenderer: ToolRenderer = {
	render: (_params, result) => {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		if (result && !result.isError) {
			const n = (result.details as { results?: unknown[] } | undefined)?.results?.length ?? 0;
			return {
				content: renderHeader(state, Globe, `Searched the web · ${n} result${n === 1 ? "" : "s"}`),
				isCustom: false,
			};
		}
		return { content: renderHeader(state, Globe, "Searching the web…"), isCustom: false };
	},
};

export function registerWebToolRenderer(): void {
	registerToolRenderer("web_search", webSearchRenderer);
}
