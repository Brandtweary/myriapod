#!/usr/bin/env python3
"""Build the browser-loadable stock-KG asset.

Reads the frozen stock graph (store.json) + precomputed MiniLM node embeddings
(node_embeddings_minilm.npz) and emits a single static asset the web app fetches
at boot: public/stock-kg.json. Nothing in the shipped app talks to Python — this
runs once, at build time, whenever the stock graph is regenerated.

Asset shape:
    {
      "meta":       { version, node_count, edge_count, last_modified },
      "thoughts":   { id: <thought>, ... },   # nodes AND link-thoughts, verbatim
      "embeddings": { node_id: [384 floats], ... }   # entity nodes only, L2-normalized
    }

Idempotent: re-runnable any time the stock graph changes.
"""

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "stock-kg" / "kg" / "store.json"
NPZ = ROOT / "stock-kg" / "kg" / "node_embeddings_minilm.npz"
OUT = ROOT / "public" / "stock-kg.json"


def main() -> None:
    store = json.loads(STORE.read_text())
    meta = store["meta"] if "meta" in store else store.get("_meta", {})
    thoughts = store["thoughts"]

    z = np.load(NPZ, allow_pickle=True)
    embeddings = {
        k: z[k].astype("float32").tolist()
        for k in z.files
        if not k.startswith("_ts_")
    }

    # Sanity: the asset must match the documented frozen graph.
    nodes = [t for t in thoughts.values() if not t.get("link_data")]
    links = [t for t in thoughts.values() if t.get("link_data")]
    assert meta.get("node_count") == len(nodes) == len(embeddings), (
        f"node/embedding mismatch: meta={meta.get('node_count')} "
        f"nodes={len(nodes)} emb={len(embeddings)}"
    )
    assert meta.get("edge_count") == len(links), (
        f"edge mismatch: meta={meta.get('edge_count')} links={len(links)}"
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "meta": meta,
        "thoughts": thoughts,
        "embeddings": embeddings,
    }))

    kb = OUT.stat().st_size / 1024
    print(
        f"wrote {OUT.relative_to(ROOT)}  "
        f"({len(nodes)} nodes, {len(links)} edges, {len(embeddings)} embeddings, {kb:.0f} KB)"
    )


if __name__ == "__main__":
    main()
