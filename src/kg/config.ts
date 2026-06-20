// Retrieval tunables — mirror cymbiont/cymbiont/config.py ([kg] section) and the
// hardcoded query_ppr / mmr_rerank params. Single source of truth for the port.

// PPR (cymbiont/kg/graph.py query_ppr)
export const PPR_ALPHA = 0.5; // restart probability (HippoRAG-optimal)
export const PPR_MAX_ITER = 100;
export const PPR_TOL = 1e-6;
export const INV_FREQ_PPR = true; // inverse-frequency hub suppression
export const INV_FREQ_ALPHA = 0.7;
export const IS_A_DECAY = 0.5; // personalization decay per is-a hop
export const IS_A_MAX_DEPTH = 2; // transitive is-a expansion depth
export const REVERSE_EDGE_WEIGHT = 0.5; // auto-reverse / commutative reverse weight

// MMR rerank (cymbiont/kg/server.py mmr_rerank_triples)
export const MMR_LAMBDA = 0.7; // relevance vs diversity (1.0 = pure PPR)
export const MMR_CANDIDATES = 30; // PPR overfetch before MMR

// Output caps
export const TRIPLES_PER_RETRIEVE = 3;
export const MAX_TRIPLES_PER_HEAD = 3;
export const TERMS_PER_RETRIEVE = 20;
export const MAX_DOC_NODES = 3; // doc:* term-match nodes per turn

// Ingestion write-side (cymbiont/kg/graph.py _validate_description_length)
export const DESCRIPTION_WORD_CAP = 100;

// Edge-type semantics (cymbiont/kg/graph.py)
export const COMMUTATIVE_TYPES = new Set(["relates-to"]);
export const RETRIEVAL_ONLY_EDGE_TYPES = new Set([
	"alias-of",
	"hard-linked",
	"mistranscription-of",
]);
export const TERM_ALIAS_EDGE_TYPES = new Set(["alias-of", "mistranscription-of"]);
