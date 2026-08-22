// The term-store engine — load + indexes + term-match, plus the mutable store
// API (getOrCreate / aliases / rename / merge / remove) that the personal
// memory is built on. A keyword router over evergreen descriptions: no edges,
// no graph traversal.

import { depluralize, stemText, stemWord, tokenize } from "./stem";
import { DESCRIPTION_WORD_CAP } from "./config";
import { boundaryAssertions, escapeRegExp } from "../regex-utils";
import type { GraphAsset, TermMatch, Thought } from "./types";

interface TermEntry {
	node_id: string;
	no_stem: boolean;
}

function nowIso(): string {
	return new Date().toISOString();
}

/** Thrown at any write site when a term description exceeds the word cap. */
export class DescriptionTooLongError extends Error {
	constructor(
		public readonly label: string,
		public readonly wordCount: number,
	) {
		super(`Description for '${label}' is ${wordCount} words (cap ${DESCRIPTION_WORD_CAP})`);
		this.name = "DescriptionTooLongError";
	}
}

export class Graph {
	thoughts: Map<string, Thought> = new Map();

	// lowercase label -> id
	labelIndex: Map<string, string> = new Map();
	// stemmed label -> set of ids
	stemIndex: Map<string, Set<string>> = new Map();

	// term-match indexes (built lazily)
	private termSingle: Map<string, TermEntry[]> = new Map();
	private termMulti: Array<[string, TermEntry]> = [];
	private termIndexValid = false;

	constructor(asset: GraphAsset) {
		this.load(asset);
	}

	// -- load() -----------------------------------------------------------
	private load(asset: GraphAsset): void {
		for (const [id, t] of Object.entries(asset.thoughts)) {
			// Defend against a malformed import bricking the whole store: skip a row
			// with no usable label, and trust the map key as the canonical id (a
			// key ≠ t.id would otherwise make the entry invisible to get()).
			if (typeof t.label !== "string") continue;
			if (!Array.isArray(t.aliases)) t.aliases = [];
			t.id = id;
			this.thoughts.set(id, t);
			this.labelIndex.set(t.label.toLowerCase(), t.id);
			this.indexStem(t);
		}
	}

	private indexStem(t: Thought): void {
		const stemmed = stemWord(t.label);
		let set = this.stemIndex.get(stemmed);
		if (!set) {
			set = new Set();
			this.stemIndex.set(stemmed, set);
		}
		set.add(t.id);
	}

	private unindex(t: Thought): void {
		this.labelIndex.delete(t.label.toLowerCase());
		const stemmed = stemWord(t.label);
		const set = this.stemIndex.get(stemmed);
		if (set) {
			set.delete(t.id);
			if (!set.size) this.stemIndex.delete(stemmed);
		}
	}

	// -- mutation: CRUD ---------------------------------------------------

	/** Empty mutable store — the personal memory starts here. */
	static empty(): Graph {
		return new Graph({
			meta: { version: 2, node_count: 0, last_modified: nowIso() },
			thoughts: {},
		});
	}

	get(label: string): Thought | null {
		const id = this.labelIndex.get(label.toLowerCase());
		return id ? (this.thoughts.get(id) ?? null) : null;
	}

	private touch(t: Thought): void {
		t.updated_at = nowIso();
	}

	fire(t: Thought): void {
		t.hit_count = (t.hit_count ?? 0) + 1;
		t.last_fired = nowIso();
	}

	private validateDescriptionLength(description: string | null | undefined, label: string): void {
		if (description == null) return;
		const words = description.trim().split(/\s+/).filter(Boolean).length;
		if (words > DESCRIPTION_WORD_CAP) throw new DescriptionTooLongError(label, words);
	}

	private invalidateTermIndex(): void {
		this.termIndexValid = false;
		this.termSingle = new Map();
		this.termMulti = [];
	}

	// getOrCreate — label-upsert; on collision only description / entity_type
	// are updated. 100-word cap enforced before write. A description change
	// nulls the stored embedding (stale until re-embedded on the write path).
	getOrCreate(label: string, description?: string | null, entityType?: string | null): Thought {
		const existing = this.get(label);
		if (existing) {
			if (description != null && existing.description !== description) {
				this.validateDescriptionLength(description, label);
				existing.description = description;
				existing.embedding = null;
				this.touch(existing);
				this.invalidateTermIndex(); // null→value changes term-index membership
			}
			if (entityType != null && existing.entity_type !== entityType) {
				existing.entity_type = entityType;
				this.touch(existing);
			}
			return existing;
		}
		this.validateDescriptionLength(description, label);
		const now = nowIso();
		const t: Thought = {
			id: crypto.randomUUID(),
			label,
			last_fired: now,
			description: description ?? null,
			entity_type: entityType ?? null,
			aliases: [],
			embedding: null,
			hit_count: 0,
			created_at: now,
			updated_at: now,
			metadata: null,
		};
		this.thoughts.set(t.id, t);
		this.labelIndex.set(label.toLowerCase(), t.id);
		this.indexStem(t);
		this.invalidateTermIndex();
		return t;
	}

	/** Add an alias (alternative surface form) to a term. Returns false when the
	 * alias is already the label or alias of some term. */
	addAlias(label: string, alias: string): boolean {
		const t = this.get(label);
		if (!t) return false;
		const a = alias.trim().toLowerCase();
		if (!a || a === t.label.toLowerCase()) return false;
		if (this.labelIndex.has(a)) return false; // collides with another term's label
		for (const other of this.thoughts.values()) {
			if (other.aliases.includes(a)) return false;
		}
		t.aliases.push(a);
		this.touch(t);
		this.invalidateTermIndex();
		return true;
	}

	removeAlias(label: string, alias: string): boolean {
		const t = this.get(label);
		if (!t) return false;
		const a = alias.trim().toLowerCase();
		const idx = t.aliases.indexOf(a);
		if (idx < 0) return false;
		t.aliases.splice(idx, 1);
		this.touch(t);
		this.invalidateTermIndex();
		return true;
	}

	/** Relabel a term in place (description, aliases, hit count preserved). */
	rename(oldLabel: string, newLabel: string): boolean {
		const t = this.get(oldLabel);
		if (!t) return false;
		if (this.get(newLabel)) return false; // target label taken
		this.unindex(t);
		t.label = newLabel;
		this.touch(t);
		this.labelIndex.set(newLabel.toLowerCase(), t.id);
		this.indexStem(t);
		this.invalidateTermIndex();
		return true;
	}

	/** Merge the loser term into the survivor: the loser's label + aliases become
	 * survivor aliases, hit counts sum, the loser is deleted. The survivor's
	 * description wins (update it separately if it should absorb detail). */
	merge(loserLabel: string, survivorLabel: string): boolean {
		const loser = this.get(loserLabel);
		const survivor = this.get(survivorLabel);
		if (!loser || !survivor || loser.id === survivor.id) return false;
		this.unindex(loser);
		this.thoughts.delete(loser.id);
		const taken = new Set(survivor.aliases);
		const survivorLabelLc = survivor.label.toLowerCase();
		for (const a of [loser.label.toLowerCase(), ...loser.aliases]) {
			if (a === survivorLabelLc || taken.has(a)) continue;
			// Global alias-uniqueness (matching addAlias): never absorb an alias
			// already owned by another term as its label or alias — that would
			// double-route the surface form.
			if (this.labelIndex.has(a)) continue;
			let heldByOther = false;
			for (const other of this.thoughts.values()) {
				if (other.id === survivor.id) continue;
				if (other.aliases.includes(a)) {
					heldByOther = true;
					break;
				}
			}
			if (heldByOther) continue;
			survivor.aliases.push(a);
			taken.add(a);
		}
		survivor.hit_count = (survivor.hit_count ?? 0) + (loser.hit_count ?? 0);
		this.touch(survivor);
		this.invalidateTermIndex();
		return true;
	}

	remove(label: string): boolean {
		const t = this.get(label);
		if (!t) return false;
		this.unindex(t);
		this.thoughts.delete(t.id);
		this.invalidateTermIndex();
		return true;
	}

	setNoStem(label: string, noStem: boolean): boolean {
		const t = this.get(label);
		if (!t) return false;
		t.metadata = { ...(t.metadata ?? {}), no_stem: noStem };
		this.touch(t);
		this.invalidateTermIndex();
		return true;
	}

	// Serialize to the GraphAsset shape for IndexedDB persistence.
	serialize(): GraphAsset {
		const thoughts: Record<string, Thought> = {};
		let nodeCount = 0;
		for (const [id, t] of this.thoughts) {
			thoughts[id] = t;
			nodeCount++;
		}
		return {
			meta: { version: 2, node_count: nodeCount, last_modified: nowIso() },
			thoughts,
		};
	}

	// -- searchText() -----------------------------------------------------
	// A LITERAL substring search for the memory_search tool — distinct from
	// termMatch (which is term-index-driven, descriptions-only, and runs the
	// inverse direction). Lowercased `.includes` over each term's label +
	// description + aliases. Ranked by hit_count desc. Default limit 50,
	// hard cap 100.
	searchText(query: string, limit = 50): { label: string; description: string; hit_count: number }[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const cap = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50;

		const results: { label: string; description: string; hit_count: number }[] = [];
		for (const t of this.thoughts.values()) {
			const hit =
				t.label.toLowerCase().includes(q) ||
				(t.description ?? "").toLowerCase().includes(q) ||
				t.aliases.some((a) => a.includes(q));
			if (hit) {
				results.push({ label: t.label, description: t.description ?? "", hit_count: t.hit_count });
			}
		}
		results.sort((a, b) => b.hit_count - a.hit_count);
		return results.slice(0, cap);
	}

	// -- buildTermIndex() -------------------------------------------------
	private buildTermIndex(): void {
		// Multi-valued so terms that prepare to the same key (e.g. two stems
		// colliding, or a later label reusing an earlier term's alias key) coexist
		// instead of last-writer-wins silently shadowing one of them.
		const termIndex = new Map<string, TermEntry[]>();
		const push = (key: string, entry: TermEntry): void => {
			let list = termIndex.get(key);
			if (!list) {
				list = [];
				termIndex.set(key, list);
			}
			if (!list.some((e) => e.node_id === entry.node_id)) list.push(entry);
		};

		for (const t of this.thoughts.values()) {
			if (!t.description) continue;

			const noStem = t.metadata?.no_stem ?? true; // default: exact match
			const preparedKey = noStem ? t.label.toLowerCase() : stemText(t.label);
			push(preparedKey, { node_id: t.id, no_stem: noStem });

			// Auto-alias: labels carrying internal punctuation the tokenizer splits on
			// (hyphens, apostrophes, …) get a space-separated variant, so a form typed
			// or spoken with the punctuation still routes. tokenize() yields the same
			// space-joined shape the query side rejoins to.
			const labelJoined = tokenize(t.label).join(" ");
			if (labelJoined.includes(" ") && labelJoined !== preparedKey) {
				push(noStem ? labelJoined : stemText(labelJoined), { node_id: t.id, no_stem: noStem });
			}

			// Explicit aliases (spoken variants, abbreviations, persistent
			// mistranscriptions) — always exact-matched. Punctuated aliases get the
			// same space-separated variant as labels (a hyphenated/apostrophe'd key
			// never matches the tokenizer's split words otherwise).
			for (const alias of t.aliases) {
				const preparedAlias = alias.toLowerCase();
				push(preparedAlias, { node_id: t.id, no_stem: true });
				const aliasJoined = tokenize(alias).join(" ");
				if (aliasJoined.includes(" ") && aliasJoined !== preparedAlias) {
					push(aliasJoined, { node_id: t.id, no_stem: true });
				}
			}
		}

		// Split into single-word (dict lookup) and multi-word (regex).
		this.termSingle = new Map();
		this.termMulti = [];
		for (const [key, entries] of termIndex) {
			if (key.includes(" ")) {
				for (const data of entries) this.termMulti.push([key, data]);
			} else {
				this.termSingle.set(key, entries);
			}
		}
		this.termIndexValid = true;
	}

	private ensureTermIndex(): void {
		if (!this.termIndexValid) this.buildTermIndex();
	}

	// -- termMatch() ------------------------------------------------------
	termMatch(text: string): TermMatch[] {
		this.ensureTermIndex();
		const lowercased = text.toLowerCase();
		const matchedIds = new Set<string>();

		const tokensLower = new Set(tokenize(lowercased));
		// Depluralized variants — always applied to exact (no_stem) matching so a
		// spoken S-plural ("graphs") still finds the singular label ("graph").
		const tokensSingular = new Set([...tokensLower].map((t) => depluralize(t)));

		// Fast path: single-word exact (no_stem) matches.
		for (const token of new Set([...tokensLower, ...tokensSingular])) {
			const entries = this.termSingle.get(token);
			if (entries) {
				for (const data of entries) {
					if (data.no_stem) matchedIds.add(data.node_id);
				}
			}
		}
		// Single-word stemmed matches (opt-in only).
		const tokensStemmed = new Set([...tokensLower].map((t) => stemWord(t)));
		for (const stemmedToken of tokensStemmed) {
			const entries = this.termSingle.get(stemmedToken);
			if (entries) {
				for (const data of entries) {
					if (!data.no_stem) matchedIds.add(data.node_id);
				}
			}
		}

		// Slow path: multi-word keys via regex.
		let stemmedTextCache: string | null = null;
		// Tokens rejoined with single spaces (no depluralization) so a multi-word
		// exact key ("apis mellifera") matches input typed with the internal
		// punctuation ("apis-mellifera") — the tokenizer splits the punct, the
		// rejoin normalizes it to the stored space-joined form.
		const rejoinedText = tokenize(lowercased).join(" ");
		// Depluralized text so a multi-word exact key ("term store") still
		// matches an S-pluralized phrase ("term stores") in the input.
		const singularText = tokenize(lowercased).map((t) => depluralize(t)).join(" ");
		for (const [preparedKey, data] of this.termMulti) {
			const [lead, trail] = boundaryAssertions(preparedKey);
			const pattern = new RegExp(`${lead}${escapeRegExp(preparedKey)}${trail}`);
			if (data.no_stem) {
				if (pattern.test(lowercased) || pattern.test(rejoinedText) || pattern.test(singularText)) {
					matchedIds.add(data.node_id);
				}
			} else {
				if (stemmedTextCache === null) stemmedTextCache = stemText(lowercased);
				if (pattern.test(stemmedTextCache)) matchedIds.add(data.node_id);
			}
		}

		// Build results.
		const results: TermMatch[] = [];
		for (const nodeId of matchedIds) {
			const node = this.thoughts.get(nodeId);
			if (!node || !node.description) continue;
			results.push({
				label: node.label,
				description: node.description,
				hit_count: node.hit_count,
			});
		}
		results.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
		return results;
	}
}
