// The shapes for the serialized memory asset and the retrieval outputs.

export interface Thought {
	id: string;
	label: string;
	last_fired?: string;
	description: string | null;
	entity_type: string | null;
	// Alternative surface forms that route to this term (spoken variants,
	// abbreviations, persistent mistranscriptions). Matched exactly (lowercased).
	aliases: string[];
	// 384-dim MiniLM embedding of the description, computed server-side on
	// write (mint / description change). Null until embedded; rides the
	// lexicon export so imports don't recompute.
	embedding?: number[] | null;
	hit_count: number;
	created_at?: string;
	updated_at?: string;
	metadata: { no_stem?: boolean } | null;
}

// The serialized memory asset persisted to IndexedDB (the term half of the
// exportable lexicon).
export interface GraphAsset {
	meta: {
		version: number;
		node_count: number;
		last_modified: string;
	};
	thoughts: Record<string, Thought>;
}

// term_match result (left gutter).
export interface TermMatch {
	label: string;
	description: string;
	hit_count: number;
}
