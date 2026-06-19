// Types mirroring the Cymbiont KG store.json shape and retrieval outputs.
// Reference: cymbiont/cymbiont/kg/graph.py (Thought dataclass, Triple, term_match).

export interface Clause {
	type: "because" | "with";
	text: string;
}

export interface LinkData {
	from_id: string;
	link_type: string;
	to_id: string;
	expired_at?: string | null;
	clauses?: Clause[];
}

export interface Thought {
	id: string;
	label: string;
	weight: number;
	last_fired?: string;
	description: string | null;
	entity_type: string | null;
	links_to: string[];
	links_from: string[];
	link_data: LinkData | null;
	hit_count: number;
	created_at?: string;
	updated_at?: string;
	metadata: { no_stem?: boolean } | null;
}

// The browser asset emitted by scripts/build-stock-kg.py.
export interface StockGraphAsset {
	meta: {
		version: number;
		node_count: number;
		edge_count: number;
		last_modified: string;
	};
	thoughts: Record<string, Thought>;
	embeddings: Record<string, number[]>;
}

// term_match result (left gutter).
export interface TermMatch {
	label: string;
	description: string;
	hit_count: number;
}

// PPR/MMR result (right gutter). Mirrors server.py's _triple_to_dict.
export interface Triple {
	subject: string;
	predicate: string;
	object: string;
	weight: number;
	hops: number;
	clauses?: Clause[];
}
