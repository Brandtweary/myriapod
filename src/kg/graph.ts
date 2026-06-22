// Browser port of the Cymbiont graph engine — load + indexes + term-match, plus
// the mutable graph API (getOrCreate / addLink / expireLink / serialize) that the
// personal/user graph is built on (added Phase 3; the stock graph is read-only).
// Reference: cymbiont/cymbiont/kg/graph.py (load, _build_term_index, term_match,
// _index_stem, and the mutation methods). PPR / MMR / seed extraction live in
// their own modules and operate on a loaded Graph.

import { NLTK_ENGLISH_STOPWORDS } from "./stopwords";
import { depluralize, stemText, stemWord, tokenize } from "./stem";
import { COMMUTATIVE_TYPES, DESCRIPTION_WORD_CAP, TERM_ALIAS_EDGE_TYPES } from "./config";
import type { Clause, LinkData, StockGraphAsset, TermMatch, Thought } from "./types";

interface TermEntry {
	node_id: string;
	no_stem: boolean;
}

const GENERIC_DIRS = new Set(["areas", "commands"]);

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nowIso(): string {
	return new Date().toISOString();
}

/** Mirror of graph.py DescriptionTooLongError — thrown at any write site when a
 *  node description exceeds the word cap. */
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
	embeddings: Map<string, number[]> = new Map();

	// lowercase label -> id (nodes only)
	labelIndex: Map<string, string> = new Map();
	// stemmed label -> set of ids (nodes only)
	stemIndex: Map<string, Set<string>> = new Map();

	// term-match indexes (built lazily)
	private termSingle: Map<string, TermEntry[]> = new Map();
	private termMulti: Array<[string, TermEntry]> = [];
	private termIndexValid = false;

	constructor(asset: StockGraphAsset) {
		this.load(asset);
	}

	// -- graph.py load() --------------------------------------------------
	private load(asset: StockGraphAsset): void {
		for (const [id, t] of Object.entries(asset.thoughts)) {
			this.thoughts.set(id, t);
			if (!this.isLink(t)) {
				this.labelIndex.set(t.label.toLowerCase(), t.id);
				this.indexStem(t);
			}
		}
		for (const [id, vec] of Object.entries(asset.embeddings)) {
			this.embeddings.set(id, vec);
		}
	}

	isLink(t: Thought): boolean {
		return t.link_data != null;
	}

	isExpired(t: Thought): boolean {
		return !!t.link_data?.expired_at;
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

	// -- mutation: CRUD ported from graph.py ------------------------------

	/** Empty mutable graph — the personal/user graph starts here. */
	static empty(): Graph {
		return new Graph({
			meta: { version: 1, node_count: 0, edge_count: 0, last_modified: nowIso() },
			thoughts: {},
			embeddings: {},
		});
	}

	get(label: string): Thought | null {
		const id = this.labelIndex.get(label.toLowerCase());
		return id ? (this.thoughts.get(id) ?? null) : null;
	}

	private touch(t: Thought): void {
		t.updated_at = nowIso();
	}

	private fire(t: Thought): void {
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

	// graph.py get_or_create — label-upsert; on collision only description /
	// entity_type are updated (never weight). 100-word cap enforced before write.
	getOrCreate(
		label: string,
		weight = 1,
		description?: string | null,
		entityType?: string | null,
	): Thought {
		const existing = this.get(label);
		if (existing) {
			if (description != null && existing.description !== description) {
				this.validateDescriptionLength(description, label);
				existing.description = description;
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
			weight,
			last_fired: now,
			description: description ?? null,
			entity_type: entityType ?? null,
			links_to: [],
			links_from: [],
			link_data: null,
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

	// graph.py _find_link — returns the matching link Thought INCLUDING expired
	// ones (the add_link reactivation branch depends on this).
	findLink(fromId: string, linkType: string, toId: string): Thought | null {
		const src = this.thoughts.get(fromId);
		if (!src) return null;
		for (const linkId of src.links_to) {
			const link = this.thoughts.get(linkId);
			const ld = link?.link_data;
			if (ld && ld.from_id === fromId && ld.link_type === linkType && ld.to_id === toId) {
				return link!;
			}
		}
		return null;
	}

	hasLink(sourceLabel: string, linkType: string, targetLabel: string): boolean {
		const source = this.get(sourceLabel);
		const target = this.get(targetLabel);
		if (!source || !target) return false;
		return this.findLink(source.id, linkType, target.id) != null;
	}

	// graph.py add_link — implicit endpoint creation, reactivate-if-expired /
	// merge-clauses-by-type on collision, auto-create commutative reverse.
	addLink(
		sourceLabel: string,
		linkType: string,
		targetLabel: string,
		weight = 1,
		clauses?: Clause[] | null,
		isReverse = false,
	): Thought | null {
		const source = this.getOrCreate(sourceLabel);
		const target = this.getOrCreate(targetLabel);
		if (source.id === target.id) return null;

		const existing = this.findLink(source.id, linkType, target.id);
		if (existing && existing.link_data) {
			if (this.isExpired(existing)) {
				delete existing.link_data.expired_at;
				existing.weight = weight;
				if (clauses) existing.link_data.clauses = clauses;
				this.touch(existing);
				this.invalidateTermIndex();
				if (!isReverse && COMMUTATIVE_TYPES.has(linkType)) {
					const reverse = this.findLink(target.id, linkType, source.id);
					if (reverse?.link_data && this.isExpired(reverse)) {
						delete reverse.link_data.expired_at;
						reverse.weight = weight;
						this.touch(reverse);
					}
				}
			} else if (clauses) {
				let merged = [...(existing.link_data.clauses ?? [])];
				const existingTypes = new Set(merged.map((c) => c.type));
				for (const c of clauses) {
					if (existingTypes.has(c.type)) merged = merged.filter((ec) => ec.type !== c.type);
					merged.push(c);
				}
				existing.link_data.clauses = merged;
				this.touch(existing);
			}
			this.fire(existing);
			return existing;
		}

		const now = nowIso();
		const linkData: LinkData = { from_id: source.id, link_type: linkType, to_id: target.id };
		if (clauses) linkData.clauses = clauses;
		const link: Thought = {
			id: crypto.randomUUID(),
			label: `${sourceLabel}::${linkType}::${targetLabel}`,
			weight,
			last_fired: now,
			description: null,
			entity_type: null,
			links_to: [],
			links_from: [],
			link_data: linkData,
			hit_count: 0,
			created_at: now,
			updated_at: now,
			metadata: null,
		};
		this.thoughts.set(link.id, link);
		source.links_to.push(link.id);
		target.links_from.push(link.id);
		this.invalidateTermIndex();

		if (!isReverse && COMMUTATIVE_TYPES.has(linkType)) {
			this.addLink(targetLabel, linkType, sourceLabel, weight, null, true);
		}
		return link;
	}

	// graph.py expire_link — soft-delete via expired_at + commutative reverse.
	expireLink(fromId: string, linkType: string, toId: string): Thought | null {
		const link = this.findLink(fromId, linkType, toId);
		if (!link?.link_data) return null;
		if (this.isExpired(link)) return link;
		link.link_data.expired_at = nowIso();
		this.touch(link);
		this.invalidateTermIndex();
		if (COMMUTATIVE_TYPES.has(linkType)) {
			const reverse = this.findLink(toId, linkType, fromId);
			if (reverse?.link_data && !this.isExpired(reverse)) {
				reverse.link_data.expired_at = nowIso();
				this.touch(reverse);
			}
		}
		return link;
	}

	// Serialize to the StockGraphAsset shape for IndexedDB persistence. The user
	// graph carries no embeddings (PPR-only), so embeddings is always empty.
	serialize(): StockGraphAsset {
		const thoughts: Record<string, Thought> = {};
		let nodeCount = 0;
		let edgeCount = 0;
		for (const [id, t] of this.thoughts) {
			thoughts[id] = t;
			if (this.isLink(t)) edgeCount++;
			else nodeCount++;
		}
		return {
			meta: { version: 1, node_count: nodeCount, edge_count: edgeCount, last_modified: nowIso() },
			thoughts,
			embeddings: {},
		};
	}

	// -- graph.py _build_term_index() -------------------------------------
	private buildTermIndex(): void {
		const termIndex = new Map<string, TermEntry>();

		for (const t of this.thoughts.values()) {
			if (this.isLink(t) || !t.description) continue;

			const noStem = t.metadata?.no_stem ?? true; // default: exact match
			const preparedKey = noStem ? t.label.toLowerCase() : stemText(t.label);
			termIndex.set(preparedKey, { node_id: t.id, no_stem: noStem });

			// Auto-alias: hyphenated labels get a space-separated variant.
			if (t.label.includes("-")) {
				const spaceVersion = t.label.replace(/-/g, " ");
				const preparedSpace = noStem ? spaceVersion.toLowerCase() : stemText(spaceVersion);
				if (!termIndex.has(preparedSpace)) {
					termIndex.set(preparedSpace, { node_id: t.id, no_stem: noStem });
				}
			}

			// Alias-resolving edges (alias-of / mistranscription-of) pointing TO
			// this node: alias --alias-of--> target, so look at links_from.
			for (const linkId of t.links_from) {
				const link = this.thoughts.get(linkId);
				if (!link || !link.link_data) continue;
				if (this.isExpired(link)) continue;
				if (!TERM_ALIAS_EDGE_TYPES.has(link.link_data.link_type)) continue;
				const aliasNode = this.thoughts.get(link.link_data.from_id);
				if (!aliasNode) continue;
				const aliasNoStem = aliasNode.metadata?.no_stem ?? noStem;
				const preparedAlias = aliasNoStem
					? aliasNode.label.toLowerCase()
					: stemText(aliasNode.label);
				termIndex.set(preparedAlias, { node_id: t.id, no_stem: aliasNoStem });
			}

			// Document node path decomposition: sliding 2-word windows.
			if (t.label.startsWith("doc:")) {
				let pathStr = t.label.slice(4);
				if (pathStr.endsWith(".md")) pathStr = pathStr.slice(0, -3);
				const words: string[] = [];
				for (const part of pathStr.split("/")) {
					for (const word of part.split("_")) {
						const w = word.toLowerCase().trim();
						if (w && !GENERIC_DIRS.has(w) && !NLTK_ENGLISH_STOPWORDS.has(w)) {
							words.push(w);
						}
					}
				}
				for (let i = 0; i < words.length - 1; i++) {
					const bigram = `${words[i]} ${words[i + 1]}`;
					if (!termIndex.has(bigram)) {
						termIndex.set(bigram, { node_id: t.id, no_stem: true });
					}
				}
			}
		}

		// Split into single-word (dict lookup) and multi-word (regex).
		this.termSingle = new Map();
		this.termMulti = [];
		for (const [key, data] of termIndex) {
			if (key.includes(" ")) {
				this.termMulti.push([key, data]);
			} else {
				let list = this.termSingle.get(key);
				if (!list) {
					list = [];
					this.termSingle.set(key, list);
				}
				list.push(data);
			}
		}
		this.termIndexValid = true;
	}

	private ensureTermIndex(): void {
		if (!this.termIndexValid) this.buildTermIndex();
	}

	// -- graph.py term_match() --------------------------------------------
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
		// Depluralized text so a multi-word exact key ("knowledge graph") still
		// matches an S-pluralized phrase ("knowledge graphs") in the input.
		const singularText = tokenize(lowercased).map((t) => depluralize(t)).join(" ");
		for (const [preparedKey, data] of this.termMulti) {
			const pattern = new RegExp(`\\b${escapeRegExp(preparedKey)}\\b`);
			if (data.no_stem) {
				if (pattern.test(lowercased) || pattern.test(singularText)) {
					matchedIds.add(data.node_id);
				}
			} else {
				if (stemmedTextCache === null) stemmedTextCache = stemText(lowercased);
				if (pattern.test(stemmedTextCache)) matchedIds.add(data.node_id);
			}
		}

		// Resolve hard-linked edges bidirectionally.
		const extraIds = new Set<string>();
		for (const nodeId of matchedIds) {
			const node = this.thoughts.get(nodeId);
			if (!node) continue;
			for (const linkId of [...node.links_to, ...node.links_from]) {
				const link = this.thoughts.get(linkId);
				if (!link || !link.link_data) continue;
				if (this.isExpired(link)) continue;
				if (link.link_data.link_type !== "hard-linked") continue;
				const otherId =
					link.link_data.from_id === nodeId ? link.link_data.to_id : link.link_data.from_id;
				const other = this.thoughts.get(otherId);
				if (other && other.description) extraIds.add(otherId);
			}
		}
		for (const id of extraIds) matchedIds.add(id);

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
