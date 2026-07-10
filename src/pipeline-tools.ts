// The pipeline agents' tool set — full mutation authority over the term memory
// plus the speech-adaptation stores and the human-review flags store. Shared by
// the audit agent and the memory agent (identical tools keep the request
// prefix cache-shared; the prompts govern who does what). Every execute records
// a one-line action via `record` — that stream IS the action buffer and the
// activity feed, so no tool result needs self-reporting ceremony.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import { DescriptionTooLongError, type Graph } from "./kg/graph.js";
import type { EmbedFn } from "./kg/embed.js";
import { findSimilarTerms } from "./kg/similarity.js";
import {
	type SttLexicon,
	mistranscriptionCount,
} from "./stt-lexicon.js";

// Rolling cap on the mistranscription log: it appends per voice turn and rides the
// lexicon export blob, so an uncapped log would bloat both IndexedDB and every export.
const MISTRANSCRIPTION_LOG_MAX = 500;

export interface ReviewFlag {
	kind: string;
	label?: string;
	description: string;
	ts: string;
}

export interface PipelineToolDeps {
	getGraph: () => Graph;
	embed: EmbedFn;
	getSttLexicon: () => SttLexicon;
	addFlag: (flag: ReviewFlag) => void;
	record: (line: string) => void;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

// Keep each tool literal contextually typed against ITS schema (so `execute`
// params are Static<S>), then erase to AgentTool<any> for the mixed array.
const tool = <S extends TSchema>(t: AgentTool<S>): AgentTool<any> => t as AgentTool<any>;

export function createPipelineTools(deps: PipelineToolDeps): AgentTool<any>[] {
	const { getGraph, embed, getSttLexicon, addFlag, record } = deps;

	// Embed a term's description and store the vector. Awaited inside the write
	// tools so the vector lands before the tick's save; fail-soft (null keeps
	// similar_terms string-only for this term).
	const embedTerm = async (label: string): Promise<void> => {
		const t = getGraph().get(label);
		if (!t || !t.description) return;
		t.embedding = await embed(`${t.label}: ${t.description}`);
	};

	const addTermSchema = Type.Object({
		label: Type.String({
			description: "Short, hyphenated, lowercase term name (e.g. 'vector-database').",
		}),
		description: Type.String({
			description: "Evergreen definition (hard 100-word cap; aim 50-80 words).",
		}),
		type: Type.Optional(
			Type.String({
				description: "Most specific of: person|project|tool|concept|organism|place|other.",
			}),
		),
	});

	const updateDescriptionSchema = Type.Object({
		label: Type.String(),
		description: Type.String({
			description: "The full replacement description (hard 100-word cap).",
		}),
	});

	const aliasSchema = Type.Object({
		term: Type.String({ description: "The canonical term label." }),
		alias: Type.String({ description: "The alternative surface form to route to it." }),
	});

	const renameSchema = Type.Object({
		from: Type.String(),
		to: Type.String(),
	});

	const mergeSchema = Type.Object({
		loser: Type.String({ description: "The term to fold in (its label becomes an alias)." }),
		survivor: Type.String({ description: "The term that remains." }),
	});

	const labelSchema = Type.Object({ label: Type.String() });

	const noStemSchema = Type.Object({
		label: Type.String(),
		no_stem: Type.Boolean({
			description: "true = exact matching only (proper nouns, stem-collision fixes).",
		}),
	});

	const similarSchema = Type.Object({
		label: Type.String({ description: "The candidate label to check." }),
		description: Type.Optional(
			Type.String({ description: "Candidate description — enables semantic comparison." }),
		),
	});

	const mistranscriptionSchema = Type.Object({
		spoken: Type.String({ description: "What the user actually said." }),
		transcribed: Type.String({ description: "What the transcriber wrote." }),
		kind: Type.Union([
			Type.Literal("phonetic"),
			Type.Literal("semantic"),
			Type.Literal("persistent_near_miss"),
		]),
		notes: Type.Optional(Type.String()),
	});

	const autoReplaceSchema = Type.Object({
		from: Type.String({ description: "The mistranscribed phrase (whole-phrase matched)." }),
		to: Type.String({ description: "The correct phrase." }),
	});

	const flagSchema = Type.Object({
		kind: Type.String({
			description: "Flag category, e.g. 'lexicon-colonization', 'llm-misspelling', 'needs-surgery'.",
		}),
		label: Type.Optional(Type.String({ description: "The term label concerned, if any." })),
		description: Type.String({ description: "One-line description for human review." }),
	});

	return [
		tool({
			name: "add_term",
			label: "Add term",
			description:
				"Mint a new term in the memory (or update the description/type of an existing label — " +
				"this is an upsert). Check similar_terms first when minting.",
			parameters: addTermSchema,
			execute: async (_id, p: Static<typeof addTermSchema>) => {
				const label = p.label.trim();
				if (!label) throw new Error("empty label");
				const existed = getGraph().get(label) !== null;
				try {
					getGraph().getOrCreate(label, p.description, p.type ?? null);
				} catch (e) {
					if (e instanceof DescriptionTooLongError) {
						throw new Error(
							`description rejected: ${e.wordCount} words (hard cap 100). Shorten it and retry.`,
						);
					}
					throw e;
				}
				await embedTerm(label);
				record(existed ? `updated ${label}` : `minted ${label}`);
				return text(existed ? `Updated existing term '${label}'.` : `Minted new term '${label}'.`);
			},
		}),
		tool({
			name: "update_description",
			label: "Update description",
			description:
				"Replace an existing term's description. Augment, never regress: fold new information " +
				"and the speaker's current takes into what's already there.",
			parameters: updateDescriptionSchema,
			execute: async (_id, p: Static<typeof updateDescriptionSchema>) => {
				if (!getGraph().get(p.label)) throw new Error(`no term '${p.label}'`);
				try {
					getGraph().getOrCreate(p.label, p.description);
				} catch (e) {
					if (e instanceof DescriptionTooLongError) {
						throw new Error(
							`description rejected: ${e.wordCount} words (hard cap 100). Shorten it and retry.`,
						);
					}
					throw e;
				}
				await embedTerm(p.label);
				record(`updated ${p.label}`);
				return text(`Description of '${p.label}' updated.`);
			},
		}),
		tool({
			name: "add_alias",
			label: "Add alias",
			description:
				"Add an alternative surface form (abbreviation, spoken variant, persistent " +
				"mistranscription) that routes to an existing term.",
			parameters: aliasSchema,
			execute: async (_id, p: Static<typeof aliasSchema>) => {
				if (!getGraph().addAlias(p.term, p.alias)) {
					throw new Error(
						`could not add alias '${p.alias}' to '${p.term}' (missing term, or the alias collides with an existing label/alias)`,
					);
				}
				record(`aliased ${p.alias} → ${p.term}`);
				return text(`Alias '${p.alias}' → '${p.term}' added.`);
			},
		}),
		tool({
			name: "remove_alias",
			label: "Remove alias",
			description: "Remove an alias from a term (e.g. one causing false retrievals).",
			parameters: aliasSchema,
			execute: async (_id, p: Static<typeof aliasSchema>) => {
				if (!getGraph().removeAlias(p.term, p.alias)) {
					throw new Error(`no alias '${p.alias}' on '${p.term}'`);
				}
				record(`unaliased ${p.alias} from ${p.term}`);
				return text(`Alias '${p.alias}' removed from '${p.term}'.`);
			},
		}),
		tool({
			name: "rename_term",
			label: "Rename term",
			description:
				"Relabel a term in place (description, aliases, hit count preserved). For a label that " +
				"is genuinely wrong — e.g. a bare generic word that needs qualifying.",
			parameters: renameSchema,
			execute: async (_id, p: Static<typeof renameSchema>) => {
				if (!getGraph().rename(p.from, p.to)) {
					throw new Error(`rename failed (missing '${p.from}' or '${p.to}' already exists)`);
				}
				await embedTerm(p.to);
				record(`renamed ${p.from} → ${p.to}`);
				return text(`Renamed '${p.from}' → '${p.to}'.`);
			},
		}),
		tool({
			name: "merge_terms",
			label: "Merge terms",
			description:
				"Merge two terms that are genuinely the SAME concept: the loser's label and aliases " +
				"become aliases of the survivor, hit counts sum, the loser is deleted. Destructive — " +
				"see your merge policy before using.",
			parameters: mergeSchema,
			execute: async (_id, p: Static<typeof mergeSchema>) => {
				if (!getGraph().merge(p.loser, p.survivor)) {
					throw new Error(`merge failed (missing term, or same term twice)`);
				}
				record(`merged ${p.loser} → ${p.survivor}`);
				return text(`Merged '${p.loser}' into '${p.survivor}'.`);
			},
		}),
		tool({
			name: "remove_term",
			label: "Remove term",
			description:
				"Delete a term outright (noise, a mistake, too vague to be useful). Destructive — " +
				"see your removal policy before using.",
			parameters: labelSchema,
			execute: async (_id, p: Static<typeof labelSchema>) => {
				if (!getGraph().remove(p.label)) throw new Error(`no term '${p.label}'`);
				record(`removed ${p.label}`);
				return text(`Removed '${p.label}'.`);
			},
		}),
		tool({
			name: "set_no_stem",
			label: "Set matching mode",
			description:
				"Set a term's matching mode: no_stem=true means exact matching only (fixes stemming " +
				"collisions where an unrelated word retrieves the term).",
			parameters: noStemSchema,
			execute: async (_id, p: Static<typeof noStemSchema>) => {
				if (!getGraph().setNoStem(p.label, p.no_stem)) throw new Error(`no term '${p.label}'`);
				record(`set no_stem=${p.no_stem} on ${p.label}`);
				return text(`'${p.label}' now matches ${p.no_stem ? "exactly" : "by stem"}.`);
			},
		}),
		tool({
			name: "similar_terms",
			label: "Find similar terms",
			description:
				"Find existing terms similar to a candidate label — string similarity over " +
				"labels/aliases plus semantic similarity over descriptions. Call BEFORE minting a new " +
				"term; a hit that is the same concept means augment/alias instead of mint.",
			parameters: similarSchema,
			execute: async (_id, p: Static<typeof similarSchema>) => {
				const queryEmbedding = p.description ? await embed(`${p.label}: ${p.description}`) : null;
				const candidates = findSimilarTerms(getGraph(), p.label, queryEmbedding);
				if (!candidates.length) return text(`No similar terms to '${p.label}'.`);
				const lines = candidates.map((c) => {
					const scores = [
						`string ${c.stringScore.toFixed(2)}`,
						c.semanticScore !== null ? `semantic ${c.semanticScore.toFixed(2)}` : null,
					]
						.filter(Boolean)
						.join(", ");
					return `- **${c.term.label}** (${scores}): ${c.term.description ?? "(no description)"}`;
				});
				return text(`Similar to '${p.label}':\n${lines.join("\n")}`);
			},
		}),
		tool({
			name: "log_mistranscription",
			label: "Log mistranscription",
			description:
				"Log a speech-to-text error (what was said vs what was transcribed). The result " +
				"reports how many times this exact pair has been logged — the recurrence signal for " +
				"the persistent-miss alias escalation.",
			parameters: mistranscriptionSchema,
			execute: async (_id, p: Static<typeof mistranscriptionSchema>) => {
				const lex = getSttLexicon();
				lex.mistranscriptions.push({
					spoken: p.spoken,
					transcribed: p.transcribed,
					kind: p.kind,
					notes: p.notes,
					ts: new Date().toISOString(),
				});
				if (lex.mistranscriptions.length > MISTRANSCRIPTION_LOG_MAX) {
					lex.mistranscriptions = lex.mistranscriptions.slice(-MISTRANSCRIPTION_LOG_MAX);
				}
				const count = mistranscriptionCount(lex, p.spoken, p.transcribed);
				record(`logged STT: ${p.transcribed} → ${p.spoken} (${p.kind}, seen ${count}×)`);
				return text(
					`Logged '${p.transcribed}' → '${p.spoken}' (${p.kind}). This pair has now been logged ${count} time(s).`,
				);
			},
		}),
		tool({
			name: "add_auto_replace_rule",
			label: "Add auto-replace rule",
			description:
				"Add a transcript auto-replace rule: every future voice transcript rewrites the 'from' " +
				"phrase to the 'to' phrase before anyone sees it. ONE-WAY CORRUPTION if wrong — see " +
				"your auto-vs-manual policy before using.",
			parameters: autoReplaceSchema,
			execute: async (_id, p: Static<typeof autoReplaceSchema>) => {
				const lex = getSttLexicon();
				if (lex.autoReplace.some((r) => r.from.toLowerCase() === p.from.toLowerCase())) {
					throw new Error(`a rule for '${p.from}' already exists`);
				}
				lex.autoReplace.push({ from: p.from, to: p.to, ts: new Date().toISOString() });
				record(`auto-replace: "${p.from}" → "${p.to}"`);
				return text(`Auto-replace rule added: "${p.from}" → "${p.to}".`);
			},
		}),
		tool({
			name: "flag_for_review",
			label: "Flag for review",
			description:
				"Record a finding that needs the human's judgment rather than an automated fix " +
				"(lexicon colonization, an LLM misspelling habit, a split too tangled to do safely).",
			parameters: flagSchema,
			execute: async (_id, p: Static<typeof flagSchema>) => {
				addFlag({
					kind: p.kind,
					label: p.label,
					description: p.description,
					ts: new Date().toISOString(),
				});
				record(`flagged ${p.kind}${p.label ? `: ${p.label}` : ""}`);
				return text(`Flagged for review (${p.kind}).`);
			},
		}),
	];
}
