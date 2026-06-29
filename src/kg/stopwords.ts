// NLTK english stopwords (the standard 198-word list). Used in term-index
// doc-node path decomposition.

export const NLTK_ENGLISH_STOPWORDS = new Set<string>([
	"a", "about", "above", "after", "again", "against", "ain", "all", "am", "an",
	"and", "any", "are", "aren", "aren't", "as", "at", "be", "because", "been",
	"before", "being", "below", "between", "both", "but", "by", "can", "couldn",
	"couldn't", "d", "did", "didn", "didn't", "do", "does", "doesn", "doesn't",
	"doing", "don", "don't", "down", "during", "each", "few", "for", "from",
	"further", "had", "hadn", "hadn't", "has", "hasn", "hasn't", "have", "haven",
	"haven't", "having", "he", "he'd", "he'll", "he's", "her", "here", "hers",
	"herself", "him", "himself", "his", "how", "i", "i'd", "i'll", "i'm", "i've",
	"if", "in", "into", "is", "isn", "isn't", "it", "it'd", "it'll", "it's", "its",
	"itself", "just", "ll", "m", "ma", "me", "mightn", "mightn't", "more", "most",
	"mustn", "mustn't", "my", "myself", "needn", "needn't", "no", "nor", "not",
	"now", "o", "of", "off", "on", "once", "only", "or", "other", "our", "ours",
	"ourselves", "out", "over", "own", "re", "s", "same", "shan", "shan't", "she",
	"she'd", "she'll", "she's", "should", "should've", "shouldn", "shouldn't", "so",
	"some", "such", "t", "than", "that", "that'll", "the", "their", "theirs",
	"them", "themselves", "then", "there", "these", "they", "they'd", "they'll",
	"they're", "they've", "this", "those", "through", "to", "too", "under",
	"until", "up", "ve", "very", "was", "wasn", "wasn't", "we", "we'd", "we'll",
	"we're", "we've", "were", "weren", "weren't", "what", "when", "where", "which",
	"while", "who", "whom", "why", "will", "with", "won", "won't", "wouldn",
	"wouldn't", "y", "you", "you'd", "you'll", "you're", "you've", "your", "yours",
	"yourself", "yourselves",
]);

// POS stopwords — content-tagged words that are still noise. Used by
// the POS-approximating seed filter (we can't POS-tag in the browser, so seed
// extraction drops everything in POS_STOPWORDS ∪ NLTK english stopwords instead
// of keeping NN/VB/JJ tags). The apostrophe-prefixed contraction fragments
// ('s, 'll, …) won't survive our \w+ tokenizer but are kept for parity.
export const POS_STOPWORDS = new Set<string>([
	"'d", "'ll", "'m", "'re", "'s", "'ve", "am", "are", "bad", "be", "been",
	"being", "come", "coming", "did", "do", "does", "get", "go", "going", "good",
	"got", "had", "has", "have", "i", "is", "know", "let", "n't", "need", "no",
	"ok", "okay", "right", "said", "say", "sure", "thing", "things", "think",
	"want", "was", "were", "yeah", "yes",
]);

// The seed-extraction removal set: union of both. Approximates POS content-word
// filtering (keep nouns/verbs/adjectives) by instead dropping function words.
export const SEED_STOPWORDS = new Set<string>([
	...NLTK_ENGLISH_STOPWORDS,
	...POS_STOPWORDS,
]);
