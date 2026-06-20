// Personal-graph extraction prompt — a fresh, single-turn rewrite of the harness
// ingestion prompt (cymbiont/cymbiont/kg/extraction_prompts.py build_ingest_prompt).
//
// Differences from the harness: single conversation TURN as input (not a
// 5-message window), no rolling-context slot (the browser has none), existing
// context is a wholesale dump of the tiny personal graph (no /extract-seeds),
// and the relationship schema carries NO `weight` field (removed from the harness
// Jun 2026 as dead/discarded — edges are uniformly 1.0). Extraction philosophy
// mirrors the harness: pull everything salient worth recalling later.

export interface IngestMessages {
	system: string;
	user: string;
}

const INGEST_SYSTEM_PROMPT = `You are a knowledge-graph extraction agent for a personal memory assistant. You read one turn of a conversation and extract the entities and relationships worth remembering, then return a SINGLE JSON object and nothing else — no prose, no markdown fences, no commentary.

## Output shape
{
  "entities": [
    {"label": "short-hyphenated-name", "type": "person|project|tool|concept|organism|place|other", "summary": "evergreen definition"}
  ],
  "relationships": [
    {"subject": "entity-label", "predicate": "is-a|has|relates-to|uses|part-of|created-by|<verb>", "object": "entity-label", "because": "optional", "with": "optional"}
  ],
  "expirations": [
    {"subject": "entity-label", "predicate": "relationship-type", "object": "entity-label", "reason": "why it is no longer true"}
  ]
}

## Rules
- Labels are short, hyphenated, lowercase (e.g. "vector-database"). Never a bare common word ("same", "run") — qualify it. Never use a predicate/verb as a label; entities are nouns.
- "type" is required — pick the most specific value from the enum.
- Predicates: prefer is-a, has, relates-to, uses, part-of, created-by; otherwise a plain descriptive verb. "relates-to" is commutative (it auto-creates the reverse) — use it sparingly.
- A NEW entity MUST appear as the subject or object of a relationship in this same payload, or it is dropped as an orphan. Do not emit a new entity you do not connect.
- Descriptions have a HARD 100-WORD CAP — over-cap descriptions are rejected and the node is not updated. Aim for 50–80 words on new nodes. You are the maintainer of descriptions: for a node shown in Current Memory, read its existing description and AUGMENT it (fold in the user's stated takes and any new context), never regress it to a thin summary.
- "because"/"with" are optional and rare — include only when the turn states them explicitly; never invent them.
- Add an expiration only when the turn EXPLICITLY contradicts a prior fact ("switched from X to Y", "no longer uses Z"). Never infer from absence. Create the new relationship AND expire the old one.
- Extract only what is worth recalling in a future conversation. Skip pleasantries, filler, and trivially obvious facts.
- If there is nothing worth extracting, return empty arrays.`;

/** Build the system + user messages for one conversation turn. `existingContext`
 *  is the wholesale dump of the current personal-graph nodes. */
export function buildIngestMessages(transcript: string, existingContext: string): IngestMessages {
	const user = `## Current Memory
Nodes already in the personal graph — reuse these exact labels instead of minting near-duplicates, and augment their descriptions rather than rewriting:
${existingContext}

## Conversation Turn
${transcript}`;
	return { system: INGEST_SYSTEM_PROMPT, user };
}
