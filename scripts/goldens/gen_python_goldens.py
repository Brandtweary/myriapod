#!/usr/bin/env python3
"""Generate Python ground-truth output for the TS retrieval port's golden tests.

Loads the frozen stock graph via the real cymbiont Graph engine (dev-time only —
the shipped app never touches Python) and emits, for the shared query set:
  - term_match() label lists
  - stem_word() for every token across all node labels + all query tokens
  - extract_seed_labels() seed lists (to measure seed-approximation divergence)
  - query_ppr() triples from the PYTHON-extracted seeds (isolates PPR fidelity)
  - the full /retrieve pipeline: seeds -> PPR(overfetch) -> MMR(top-k)

The TS checker (check.ts) reproduces these and diffs. Run from cymbiont-web/:
    python3 scripts/goldens/gen_python_goldens.py
"""

import json
from pathlib import Path

import numpy as np

from cymbiont.config import (
	INV_FREQ_ALPHA,
	INV_FREQ_PPR,
	MAX_DOC_NODES,
	MMR_CANDIDATES,
	MMR_LAMBDA,
	TERMS_PER_RETRIEVE,
	TRIPLES_PER_RETRIEVE,
)
from cymbiont.kg.graph import Graph
from cymbiont.kg.retriever import (
	_cap_per_head,
	_dedup_predicate_hierarchy,
	_format_clauses,
)
from cymbiont.kg.server import extract_seed_labels, mmr_rerank_triples
from cymbiont.kg.stemming import stem_word, tokenize

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "stock-kg" / "kg" / "store.json"
NPZ = ROOT / "stock-kg" / "kg" / "node_embeddings_minilm.npz"
QUERIES = json.loads((Path(__file__).parent / "queries.json").read_text())
OUT = Path(__file__).parent / "goldens.json"

OVERFETCH = max(MMR_CANDIDATES, TRIPLES_PER_RETRIEVE)


def triple_dict(t) -> dict:
	d = {
		"subject": t.subject,
		"predicate": t.predicate,
		"object": t.object,
		"weight": t.weight,
	}
	if getattr(t, "clauses", None):
		d["clauses"] = t.clauses
	return d


def assemble(triples_in: list[dict], terms_in: list[dict]) -> str | None:
	"""Mirror retriever.py main()._assemble (nested, not importable)."""
	if not triples_in and not terms_in:
		return None
	p = ["<kg-context>"]
	if terms_in:
		p.append("## Term Descriptions")
		for m in sorted(terms_in, key=lambda x: x["label"]):
			p.append(f"**{m['label']}**: {m['description']}")
		p.append("")
	if triples_in:
		p.append("## Knowledge Graph")
		for i, t in enumerate(triples_in, 1):
			p.append(f"[{i}] {t['subject']} --{t['predicate']}--> {t['object']}{_format_clauses(t)}")
	p.append("</kg-context>")
	return "\n".join(p)


def main() -> None:
	g = Graph(STORE)
	g.load()

	z = np.load(NPZ, allow_pickle=True)
	node_embeddings = {k: z[k] for k in z.files if not k.startswith("_ts_")}

	term_match = {q: sorted(m["label"] for m in g.term_match(q)) for q in QUERIES}
	seeds = {q: sorted(extract_seed_labels(q, g)) for q in QUERIES}

	# PPR fed the Python-extracted seeds (server params), top_n = overfetch.
	ppr_from_py_seeds = {}
	full_pipeline = {}
	# retriever.py-level: post-processed triples, doc-capped terms, assembled block.
	retriever_triples = {}
	retriever_terms = {}
	retrieve_block = {}
	for q in QUERIES:
		py_seeds = extract_seed_labels(q, g)
		ppr = g.query_ppr(
			py_seeds,
			top_n=OVERFETCH,
			inv_freq_weight=INV_FREQ_PPR,
			inv_freq_alpha=INV_FREQ_ALPHA,
		)
		ppr_from_py_seeds[q] = [triple_dict(t) for t in ppr]
		reranked = mmr_rerank_triples(
			ppr, node_embeddings, g.label_index, top_k=TRIPLES_PER_RETRIEVE, lambda_=MMR_LAMBDA
		)
		full_pipeline[q] = [triple_dict(t) for t in reranked]

		# retriever.py post-processing (fresh ledger ⇒ no dedup).
		tri = _cap_per_head(_dedup_predicate_hierarchy([triple_dict(t) for t in reranked]))
		matches = g.term_match(q)
		doc = [m for m in matches if m["label"].startswith("doc:")]
		nondoc = [m for m in matches if not m["label"].startswith("doc:")]
		matches = nondoc + doc[:MAX_DOC_NODES]
		terms = matches
		if len(terms) > TERMS_PER_RETRIEVE:
			terms = sorted(terms, key=lambda m: m.get("hit_count", 0), reverse=True)[:TERMS_PER_RETRIEVE]
		retriever_triples[q] = tri
		retriever_terms[q] = sorted(m["label"] for m in matches)
		retrieve_block[q] = assemble(tri, terms)

	# Stemmer vocab: every token from every node label + every query token.
	vocab: set[str] = set()
	for t in g.thoughts.values():
		if t.link_data:
			continue
		vocab.update(tokenize(t.label))
		vocab.add(t.label.lower())
	for q in QUERIES:
		vocab.update(tokenize(q))
	stems = {w: stem_word(w) for w in sorted(vocab)}

	OUT.write_text(
		json.dumps(
			{
				"term_match": term_match,
				"seeds": seeds,
				"ppr_from_py_seeds": ppr_from_py_seeds,
				"full_pipeline": full_pipeline,
				"retriever_triples": retriever_triples,
				"retriever_terms": retriever_terms,
				"retrieve_block": retrieve_block,
				"stems": stems,
			},
			indent=2,
		)
	)
	print(
		f"wrote {OUT.name}: {len(QUERIES)} queries "
		f"(term_match, seeds, ppr, full_pipeline), {len(stems)} stems"
	)


if __name__ == "__main__":
	main()
