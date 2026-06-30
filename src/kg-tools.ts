// Two native Pi AgentTools over the browser-local personal knowledge graph:
//   kg_search — a literal text search (Graph.searchText) for a term/substring.
//   kg_dump   — a BOUNDED top-N dump of the whole graph (a raw whole-graph dump
//               could blow the context window, so this is hard-capped).
// Both take a `() => Graph` accessor rather than a Graph instance: the personal
// graph is reassigned on import / delete, so a captured instance would go stale.
// Dispatch is automatic once these sit in agent.state.tools.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRenderer } from "@earendil-works/pi-web-ui";
import { registerToolRenderer, renderHeader } from "@earendil-works/pi-web-ui";
import { Database, Search } from "lucide";
import { type Static, Type } from "typebox";
import type { Graph } from "./kg/graph.js";
import type { Thought } from "./kg/types.js";

// ---------------------------------------------------------------------------
// kg_search
// ---------------------------------------------------------------------------
const kgSearchSchema = Type.Object({
	query: Type.String({ description: "The term or phrase to look for." }),
	limit: Type.Optional(Type.Number({ description: "Max results (default 50, capped at 100)." })),
});

export function createKgSearchTool(getGraph: () => Graph): AgentTool<typeof kgSearchSchema> {
	return {
		name: "kg_search",
		label: "Search memory",
		description:
			"Search the personal knowledge graph (the listener's own browser-local memory) for a " +
			"word or phrase. A plain text search over node names, descriptions, and relationships. " +
			"Use it to recall what you've been told about a person, thing, or topic.",
		parameters: kgSearchSchema,
		execute: async (_id, params: Static<typeof kgSearchSchema>) => {
			const results = getGraph().searchText(params.query, params.limit ?? 50);
			const text = results.length
				? results
						.map((r) => `**${r.label}** (hits ${r.hit_count}): ${r.description || "(no description)"}`)
						.join("\n")
				: `No matches for "${params.query}".`;
			return { content: [{ type: "text", text }], details: { count: results.length } };
		},
	};
}

// ---------------------------------------------------------------------------
// kg_dump
// ---------------------------------------------------------------------------
function buildDump(graph: Graph, limit: number): { text: string; nodeCount: number; tripleCount: number } {
	const cap = Math.min(Math.max(limit, 1), 500);

	// Rank nodes by hit_count desc, tie-break last_fired desc.
	const nodes: Thought[] = [];
	for (const t of graph.thoughts.values()) {
		if (!graph.isLink(t)) nodes.push(t);
	}
	nodes.sort((a, b) => {
		if (b.hit_count !== a.hit_count) return b.hit_count - a.hit_count;
		const al = a.last_fired ?? "";
		const bl = b.last_fired ?? "";
		return al < bl ? 1 : al > bl ? -1 : 0;
	});
	const kept = nodes.slice(0, cap);
	const keptIds = new Set(kept.map((n) => n.id));

	const nodeLines = kept.map(
		(n) => `**${n.label}** (hits ${n.hit_count}): ${n.description || "(no description)"}`,
	);

	// Live triples whose BOTH endpoints survived into the kept set.
	const tripleLines: string[] = [];
	for (const t of graph.thoughts.values()) {
		if (!graph.isLink(t) || graph.isExpired(t)) continue;
		const ld = t.link_data!;
		if (!keptIds.has(ld.from_id) || !keptIds.has(ld.to_id)) continue;
		const from = graph.thoughts.get(ld.from_id);
		const to = graph.thoughts.get(ld.to_id);
		if (!from || !to) continue;
		tripleLines.push(`${from.label} --${ld.link_type}--> ${to.label}`);
	}

	const parts: string[] = [`# Personal knowledge graph (top ${kept.length} of ${nodes.length} nodes)`, "", "## Nodes"];
	parts.push(nodeLines.length ? nodeLines.join("\n") : "(empty)");
	if (tripleLines.length) {
		parts.push("", "## Relationships", tripleLines.join("\n"));
	}
	return { text: parts.join("\n"), nodeCount: kept.length, tripleCount: tripleLines.length };
}

const kgDumpSchema = Type.Object({
	limit: Type.Optional(Type.Number({ description: "Max nodes to include (default 150, capped at 500)." })),
});

export function createKgDumpTool(getGraph: () => Graph): AgentTool<typeof kgDumpSchema> {
	return {
		name: "kg_dump",
		label: "Dump memory",
		description:
			"Dump an overview of the personal knowledge graph: the most-referenced nodes (with " +
			"descriptions) and the relationships among them. Bounded to the top-ranked nodes so it " +
			"stays compact. Use it to survey what you remember rather than to look up one thing.",
		parameters: kgDumpSchema,
		execute: async (_id, params: Static<typeof kgDumpSchema>) => {
			const { text, nodeCount, tripleCount } = buildDump(getGraph(), params.limit ?? 150);
			return { content: [{ type: "text", text }], details: { nodeCount, tripleCount } };
		},
	};
}

// ---------------------------------------------------------------------------
// Tool renderers (compact labels over pi-web-ui's spinner card)
// ---------------------------------------------------------------------------
const kgSearchRenderer: ToolRenderer = {
	render: (_params, result) => {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		if (result && !result.isError) {
			const n = (result.details as { count?: number } | undefined)?.count ?? 0;
			return {
				content: renderHeader(state, Search, `Searched memory · ${n} node${n === 1 ? "" : "s"}`),
				isCustom: false,
			};
		}
		return { content: renderHeader(state, Search, "Searching memory…"), isCustom: false };
	},
};

const kgDumpRenderer: ToolRenderer = {
	render: (_params, result) => {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		if (result && !result.isError) {
			const d = result.details as { nodeCount?: number; tripleCount?: number } | undefined;
			const n = d?.nodeCount ?? 0;
			const t = d?.tripleCount ?? 0;
			return {
				content: renderHeader(state, Database, `Memory · ${n} node${n === 1 ? "" : "s"}, ${t} link${t === 1 ? "" : "s"}`),
				isCustom: false,
			};
		}
		return { content: renderHeader(state, Database, "Reading memory…"), isCustom: false };
	},
};

export function registerKgToolRenderers(): void {
	registerToolRenderer("kg_search", kgSearchRenderer);
	registerToolRenderer("kg_dump", kgDumpRenderer);
}
