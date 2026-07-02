// Two native Pi AgentTools over the browser-local term memory:
//   memory_search — a literal text search (Graph.searchText) for a term/substring.
//   memory_dump   — a BOUNDED top-N dump of the whole memory (a raw dump could
//                   blow the context window, so this is hard-capped).
// Both take a `() => Graph` accessor rather than a Graph instance: the memory
// store is reassigned on import / delete, so a captured instance would go stale.
// Dispatch is automatic once these sit in agent.state.tools.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRenderer } from "@earendil-works/pi-web-ui";
import { registerToolRenderer, renderHeader } from "@earendil-works/pi-web-ui";
import { Database, Search } from "lucide";
import { type Static, Type } from "typebox";
import type { Graph } from "./kg/graph.js";
import type { Thought } from "./kg/types.js";

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------
const memorySearchSchema = Type.Object({
	query: Type.String({ description: "The term or phrase to look for." }),
	limit: Type.Optional(Type.Number({ description: "Max results (default 50, capped at 100)." })),
});

export function createMemorySearchTool(getGraph: () => Graph): AgentTool<typeof memorySearchSchema> {
	return {
		name: "memory_search",
		label: "Search memory",
		description:
			"Search the personal memory (the listener's own browser-local term glossary) for a " +
			"word or phrase. A plain text search over term names, descriptions, and aliases. " +
			"Use it to recall what you've been told about a person, thing, or topic.",
		parameters: memorySearchSchema,
		execute: async (_id, params: Static<typeof memorySearchSchema>) => {
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
// memory_dump
// ---------------------------------------------------------------------------
function buildDump(graph: Graph, limit: number): { text: string; termCount: number } {
	const cap = Math.min(Math.max(limit, 1), 500);

	// Rank terms by hit_count desc, tie-break last_fired desc.
	const nodes: Thought[] = [...graph.thoughts.values()];
	nodes.sort((a, b) => {
		if (b.hit_count !== a.hit_count) return b.hit_count - a.hit_count;
		const al = a.last_fired ?? "";
		const bl = b.last_fired ?? "";
		return al < bl ? 1 : al > bl ? -1 : 0;
	});
	const kept = nodes.slice(0, cap);

	const termLines = kept.map(
		(n) => `**${n.label}** (hits ${n.hit_count}): ${n.description || "(no description)"}`,
	);

	const parts: string[] = [`# Personal memory (top ${kept.length} of ${nodes.length} terms)`, ""];
	parts.push(termLines.length ? termLines.join("\n") : "(empty)");
	return { text: parts.join("\n"), termCount: kept.length };
}

const memoryDumpSchema = Type.Object({
	limit: Type.Optional(Type.Number({ description: "Max terms to include (default 150, capped at 500)." })),
});

export function createMemoryDumpTool(getGraph: () => Graph): AgentTool<typeof memoryDumpSchema> {
	return {
		name: "memory_dump",
		label: "Dump memory",
		description:
			"Dump an overview of the personal memory: the most-referenced terms with their " +
			"descriptions. Bounded to the top-ranked terms so it stays compact. Use it to survey " +
			"what you remember rather than to look up one thing.",
		parameters: memoryDumpSchema,
		execute: async (_id, params: Static<typeof memoryDumpSchema>) => {
			const { text, termCount } = buildDump(getGraph(), params.limit ?? 150);
			return { content: [{ type: "text", text }], details: { termCount } };
		},
	};
}

// ---------------------------------------------------------------------------
// Tool renderers (compact labels over pi-web-ui's spinner card)
// ---------------------------------------------------------------------------
const memorySearchRenderer: ToolRenderer = {
	render: (_params, result) => {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		if (result && !result.isError) {
			const n = (result.details as { count?: number } | undefined)?.count ?? 0;
			return {
				content: renderHeader(state, Search, `Searched memory · ${n} term${n === 1 ? "" : "s"}`),
				isCustom: false,
			};
		}
		return { content: renderHeader(state, Search, "Searching memory…"), isCustom: false };
	},
};

const memoryDumpRenderer: ToolRenderer = {
	render: (_params, result) => {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		if (result && !result.isError) {
			const d = result.details as { termCount?: number } | undefined;
			const n = d?.termCount ?? 0;
			return {
				content: renderHeader(state, Database, `Memory · ${n} term${n === 1 ? "" : "s"}`),
				isCustom: false,
			};
		}
		return { content: renderHeader(state, Database, "Reading memory…"), isCustom: false };
	},
};

export function registerMemoryToolRenderers(): void {
	registerToolRenderer("memory_search", memorySearchRenderer);
	registerToolRenderer("memory_dump", memoryDumpRenderer);
}
