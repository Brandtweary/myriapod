// Personal-graph ingestion pipeline.
//
// Flow per turn: dump the personal graph as existing-context → build the prompt →
// one LLM completion → tolerant brace-bracket parse → apply mutations to the
// in-page user Graph. The completion hits the same OpenAI-compatible endpoint as
// typed chat (see myriapod-model.ts); `makeCompletion` is endpoint-agnostic, so a
// deploy can repoint `baseUrl` without touching this logic.

import { DescriptionTooLongError, Graph } from "./graph";
import { buildIngestMessages } from "./extraction-prompts";
import { NLTK_ENGLISH_STOPWORDS } from "./stopwords";
import { tokenize } from "./stem";
import type { Clause } from "./types";

// -- LLM completion seam ----------------------------------------------------

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
export type CompletionFn = (messages: ChatMessage[]) => Promise<string>;

export interface CompletionOpts {
	baseUrl: string; // OpenAI-compatible base, e.g. http://.../llm/v1
	model: string;
	apiKey?: string; // optional bearer; the local server ignores it
	// Reports the call's token usage if the caller wants it (unused locally — there
	// is no per-token cost to fold into the session total).
	onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}

/** Build a one-shot, non-streaming completion against an OpenAI-compatible
 *  endpoint. Reasoning is disabled explicitly (`reasoning: { enabled: false }`):
 *  the chat model is GLM-over-OpenRouter, which thinks by default — wasteful and
 *  JSON-corrupting for a structured extraction job. OpenRouter honors the field;
 *  endpoints that don't simply ignore it. So `message.content` is clean JSON with
 *  no separate reasoning field to strip. */
export function makeCompletion(opts: CompletionOpts): CompletionFn {
	return async (messages) => {
		const res = await fetch(`${opts.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: opts.model,
				messages,
				stream: false,
				reasoning: { enabled: false },
			}),
		});
		if (!res.ok) {
			throw new Error(`ingestion completion failed: ${res.status} ${await res.text()}`);
		}
		const data = await res.json();
		const u = data?.usage;
		if (u && opts.onUsage) {
			opts.onUsage({ promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 });
		}
		return data?.choices?.[0]?.message?.content ?? "";
	};
}

// -- Tolerant parse ---------------------------------------------------------

/** Recover complete JSON objects from one top-level array in a (possibly
 *  truncated) payload, stopping at the first incomplete object. */
function extractArrayObjects(raw: string, key: string): Record<string, unknown>[] {
	const ki = raw.indexOf(`"${key}"`);
	if (ki === -1) return [];
	const lb = raw.indexOf("[", ki);
	if (lb === -1) return [];

	const objs: Record<string, unknown>[] = [];
	let i = lb + 1;
	const n = raw.length;
	while (i < n) {
		while (i < n && raw[i] !== "{" && raw[i] !== "]") i++;
		if (i >= n || raw[i] === "]") break;
		const start = i;
		let depth = 0;
		let inStr = false;
		let esc = false;
		let complete = false;
		while (i < n) {
			const c = raw[i];
			if (inStr) {
				if (esc) esc = false;
				else if (c === "\\") esc = true;
				else if (c === '"') inStr = false;
			} else if (c === '"') {
				inStr = true;
			} else if (c === "{") {
				depth++;
			} else if (c === "}") {
				depth--;
				if (depth === 0) {
					i++;
					complete = true;
					break;
				}
			}
			i++;
		}
		if (!complete) break; // ran off the end mid-object — truncated
		try {
			objs.push(JSON.parse(raw.slice(start, i)));
		} catch {
			break;
		}
	}
	return objs;
}

export interface ExtractionPayload {
	entities?: Array<{ label?: string; type?: string; summary?: string }>;
	relationships?: Array<{
		subject?: string;
		predicate?: string;
		object?: string;
		because?: string;
		with?: string;
	}>;
	expirations?: Array<{ subject?: string; predicate?: string; object?: string; reason?: string }>;
}

/** Parse extraction JSON; on truncation, salvage every complete object. Returns
 *  `ok=false` when only partially salvaged. */
export function parseExtraction(raw: string): { payload: ExtractionPayload; ok: boolean } {
	try {
		return { payload: JSON.parse(raw) as ExtractionPayload, ok: true };
	} catch {
		return {
			payload: {
				entities: extractArrayObjects(raw, "entities") as ExtractionPayload["entities"],
				relationships: extractArrayObjects(
					raw,
					"relationships",
				) as ExtractionPayload["relationships"],
				expirations: extractArrayObjects(raw, "expirations") as ExtractionPayload["expirations"],
			},
			ok: false,
		};
	}
}

/** First `{` … last `}`, to tolerate any stray preamble around the JSON. */
export function extractJsonObject(raw: string): string | null {
	const first = raw.indexOf("{");
	const last = raw.lastIndexOf("}");
	if (first === -1 || last === -1 || last < first) return null;
	return raw.slice(first, last + 1);
}

// -- Strip injected context -------------------------------------------------

const STRIP_TAGS: Array<[string, string]> = [["<kg-context>", "</kg-context>"]];

/** Remove the hidden KG-context breadcrumb from turn text so injected retrieval
 *  never pollutes the extraction input. */
export function stripInjectedContext(text: string): string {
	for (const [open, close] of STRIP_TAGS) {
		let idx: number;
		while ((idx = text.indexOf(open)) !== -1) {
			const end = text.indexOf(close, idx);
			if (end === -1) text = text.slice(0, idx);
			else text = text.slice(0, idx) + text.slice(end + close.length);
		}
	}
	return text.trim();
}

// -- Existing-context dump --------------------------------------------------

/** Render every node in the personal graph as the extractor's dedup memory:
 *  label, type, description, and active outgoing edges. */
export function dumpExistingContext(graph: Graph): string {
	const nodes = [...graph.thoughts.values()].filter((t) => !t.link_data);
	if (nodes.length === 0) return "(the personal graph is empty — nothing remembered yet)";
	nodes.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

	const lines: string[] = [];
	for (const n of nodes) {
		const type = n.entity_type ? ` (${n.entity_type})` : "";
		const desc = n.description ? ` — ${n.description}` : "";
		lines.push(`- ${n.label}${type}${desc}`);
		for (const linkId of n.links_to) {
			const link = graph.thoughts.get(linkId);
			if (!link?.link_data || graph.isExpired(link)) continue;
			const target = graph.thoughts.get(link.link_data.to_id);
			if (target) lines.push(`    --${link.link_data.link_type}--> ${target.label}`);
		}
	}
	return lines.join("\n");
}

// -- Apply mutations --------------------------------------------------------

export interface ApplyStats {
	entitiesAdded: number;
	newEntities: number;
	rejectedOrphan: number;
	rejectedOverlong: number;
	linksAdded: number;
	clausesMerged: number;
	expirationsApplied: number;
}

export function applyExtraction(graph: Graph, payload: ExtractionPayload): ApplyStats {
	const entities = payload.entities ?? [];
	const relationships = payload.relationships ?? [];
	const expirations = payload.expirations ?? [];

	const stats: ApplyStats = {
		entitiesAdded: 0,
		newEntities: 0,
		rejectedOrphan: 0,
		rejectedOverlong: 0,
		linksAdded: 0,
		clausesMerged: 0,
		expirationsApplied: 0,
	};

	// Labels referenced as subject/object — NEW entities must appear here or
	// they are rejected as orphans (existing nodes may be bare: description path).
	const referenced = new Set<string>();
	for (const rel of relationships) {
		const subj = (rel.subject ?? "").trim();
		const obj = (rel.object ?? "").trim();
		if (subj) referenced.add(subj);
		if (obj) referenced.add(obj);
	}

	for (const ent of entities) {
		const label = (ent.label ?? "").trim();
		if (!label) continue;
		const isNew = graph.get(label) === null;
		if (isNew && !referenced.has(label)) {
			stats.rejectedOrphan++;
			continue;
		}
		try {
			graph.getOrCreate(label, 1, ent.summary ?? null, ent.type ?? null);
		} catch (e) {
			if (e instanceof DescriptionTooLongError) {
				stats.rejectedOverlong++; // no describe-corrector in V1 — skip the update
				continue;
			}
			throw e;
		}
		stats.entitiesAdded++;
		if (isNew) stats.newEntities++;
	}

	for (const rel of relationships) {
		const subj = (rel.subject ?? "").trim();
		const pred = (rel.predicate ?? "").trim();
		const obj = (rel.object ?? "").trim();
		if (!subj || !pred || !obj) continue;

		const clauses: Clause[] = [];
		if (rel.because) clauses.push({ type: "because", text: rel.because });
		if (rel.with) clauses.push({ type: "with", text: rel.with });

		if (graph.hasLink(subj, pred, obj)) {
			// Existing edge: merge clauses only (no weight change, no re-fire) —
			// the has-link gate, NOT a re-add.
			if (clauses.length) {
				const source = graph.get(subj);
				const target = graph.get(obj);
				const link = source && target ? graph.findLink(source.id, pred, target.id) : null;
				if (link?.link_data) {
					let merged = [...(link.link_data.clauses ?? [])];
					const types = new Set(merged.map((c) => c.type));
					for (const c of clauses) {
						if (types.has(c.type)) merged = merged.filter((ec) => ec.type !== c.type);
						merged.push(c);
					}
					link.link_data.clauses = merged;
					stats.clausesMerged++;
				}
			}
		} else {
			graph.addLink(subj, pred, obj, 1, clauses.length ? clauses : null);
			stats.linksAdded++;
		}
	}

	for (const exp of expirations) {
		const subj = (exp.subject ?? "").trim();
		const pred = (exp.predicate ?? "").trim();
		const obj = (exp.object ?? "").trim();
		if (!subj || !pred || !obj) continue;
		const source = graph.get(subj);
		const target = graph.get(obj);
		if (source && target && graph.expireLink(source.id, pred, target.id)) {
			stats.expirationsApplied++;
		}
	}

	return stats;
}

// -- Orchestration ----------------------------------------------------------

/** Thin-turn guard: at least one non-stopword content token of length > 2.
 *  Skips "ok"/"thanks"-class turns to save a metered call. */
function hasContentWords(text: string): boolean {
	return tokenize(text).some((t) => t.length > 2 && !NLTK_ENGLISH_STOPWORDS.has(t));
}

/** Run one ingestion pass: strip injected context, guard thin turns, prompt the
 *  model, parse, and apply. Mutates `graph` in place; returns stats (or null when
 *  skipped / no parseable output). */
export async function runIngestion(
	graph: Graph,
	turnText: string,
	completion: CompletionFn,
): Promise<ApplyStats | null> {
	const cleaned = stripInjectedContext(turnText);
	if (!hasContentWords(cleaned)) return null;

	const { system, user } = buildIngestMessages(cleaned, dumpExistingContext(graph));
	const raw = await completion([
		{ role: "system", content: system },
		{ role: "user", content: user },
	]);

	const json = extractJsonObject(raw);
	if (json === null) return null;
	const { payload } = parseExtraction(json);
	return applyExtraction(graph, payload);
}
