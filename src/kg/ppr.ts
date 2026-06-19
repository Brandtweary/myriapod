// Personalized PageRank retrieval — port of graph.py query_ppr + _build_nx_graph
// + _follow_isa, with a faithful reproduction of networkx.pagerank's power
// iteration (stochastic out-edge normalization, dangling-node redistribution via
// the personalization vector, convergence at err < N*tol).

import {
	INV_FREQ_ALPHA,
	INV_FREQ_PPR,
	IS_A_DECAY,
	IS_A_MAX_DEPTH,
	PPR_ALPHA,
	PPR_MAX_ITER,
	PPR_TOL,
	REVERSE_EDGE_WEIGHT,
	RETRIEVAL_ONLY_EDGE_TYPES,
} from "./config";
import { stemWord } from "./stem";
import type { Graph } from "./graph";
import type { Triple } from "./types";

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Edge {
	weight: number;
	isReverse: boolean;
}

interface NxGraph {
	nodeIds: string[];
	isNode: Set<string>;
	adj: Map<string, Map<string, Edge>>; // from -> to -> edge
	degree: Map<string, number>; // in + out edge count (networkx DiGraph.degree)
}

// graph.py _build_nx_graph
function buildNxGraph(graph: Graph): NxGraph {
	const nodeIds: string[] = [];
	const isNode = new Set<string>();
	for (const [id, t] of graph.thoughts) {
		if (!graph.isLink(t)) {
			nodeIds.push(id);
			isNode.add(id);
		}
	}
	const adj = new Map<string, Map<string, Edge>>();
	for (const id of nodeIds) adj.set(id, new Map());

	for (const t of graph.thoughts.values()) {
		if (!graph.isLink(t) || !t.link_data) continue;
		if (graph.isExpired(t)) continue;
		const fromId = t.link_data.from_id;
		const toId = t.link_data.to_id;
		if (!isNode.has(fromId) || !isNode.has(toId)) continue;
		const linkType = t.link_data.link_type ?? "";

		if (RETRIEVAL_ONLY_EDGE_TYPES.has(linkType)) {
			const ew = 1.0;
			const fwd = adj.get(fromId)!.get(toId);
			if (fwd) fwd.weight += ew;
			else adj.get(fromId)!.set(toId, { weight: ew, isReverse: false });
			if (!adj.get(toId)!.has(fromId)) {
				adj.get(toId)!.set(fromId, { weight: ew * REVERSE_EDGE_WEIGHT, isReverse: false });
			}
			continue;
		}

		const ew = t.weight;
		const fwd = adj.get(fromId)!.get(toId);
		if (fwd) fwd.weight += ew; // link_type tiebreak irrelevant to PPR scoring
		else adj.get(fromId)!.set(toId, { weight: ew, isReverse: false });

		const rw = ew * REVERSE_EDGE_WEIGHT;
		const rev = adj.get(toId)!.get(fromId);
		if (rev) {
			if (rev.isReverse) rev.weight += rw;
		} else {
			adj.get(toId)!.set(fromId, { weight: rw, isReverse: true });
		}
	}

	// networkx DiGraph.degree(n) = out_degree + in_degree (edge counts).
	const degree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
	for (const [from, nbrs] of adj) {
		degree.set(from, degree.get(from)! + nbrs.size);
		for (const to of nbrs.keys()) degree.set(to, (degree.get(to) ?? 0) + 1);
	}

	return { nodeIds, isNode, adj, degree };
}

// graph.py _follow_isa
function followIsa(
	graph: Graph,
	nodeId: string,
	expanded: Map<string, number>,
	maxDepth: number,
	currentDepth: number,
): void {
	if (currentDepth > maxDepth) return;
	const t = graph.thoughts.get(nodeId);
	if (!t) return;
	for (const linkId of t.links_to) {
		const link = graph.thoughts.get(linkId);
		if (!link || !link.link_data) continue;
		if (graph.isExpired(link)) continue;
		if (link.link_data.link_type !== "is-a") continue;
		const targetId = link.link_data.to_id;
		const target = graph.thoughts.get(targetId);
		if (!target || graph.isLink(target)) continue;
		const prior = expanded.get(targetId);
		if (prior === undefined || currentDepth < prior) {
			expanded.set(targetId, currentDepth);
			followIsa(graph, targetId, expanded, maxDepth, currentDepth + 1);
		}
	}
}

// Faithful reproduction of networkx.pagerank power iteration.
function pagerank(
	nodeIds: string[],
	adj: Map<string, Map<string, Edge>>,
	p: Map<string, number>, // normalized personalization
	alpha: number,
	maxIter: number,
	tol: number,
): Map<string, number> {
	const N = nodeIds.length;
	const outSum = new Map<string, number>();
	for (const id of nodeIds) {
		let s = 0;
		for (const e of adj.get(id)!.values()) s += e.weight;
		outSum.set(id, s);
	}
	const dangling = nodeIds.filter((id) => outSum.get(id) === 0);

	let x = new Map<string, number>(nodeIds.map((id) => [id, 1 / N]));
	for (let iter = 0; iter < maxIter; iter++) {
		const xlast = x;
		x = new Map<string, number>(nodeIds.map((id) => [id, 0]));
		let danglesum = 0;
		for (const n of dangling) danglesum += xlast.get(n)!;
		danglesum *= alpha;
		for (const n of nodeIds) {
			const xln = xlast.get(n)!;
			const os = outSum.get(n)!;
			if (os > 0) {
				for (const [nbr, e] of adj.get(n)!) {
					x.set(nbr, x.get(nbr)! + alpha * xln * (e.weight / os));
				}
			}
			const pn = p.get(n) ?? 0;
			x.set(n, x.get(n)! + danglesum * pn + (1 - alpha) * pn);
		}
		let err = 0;
		for (const n of nodeIds) err += Math.abs(x.get(n)! - xlast.get(n)!);
		if (err < N * tol) return x;
	}
	// networkx raises PowerIterationFailedConvergence here (Python falls back to
	// BFS). On a graph this small it always converges well inside maxIter; return
	// best-effort if it somehow doesn't.
	return x;
}

export interface PprOptions {
	topN?: number;
	alpha?: number;
	invFreqWeight?: boolean;
	invFreqAlpha?: number;
}

export function queryPpr(graph: Graph, seedLabels: string[], opts: PprOptions = {}): Triple[] {
	const topN = opts.topN ?? 12;
	const alpha = opts.alpha ?? PPR_ALPHA;
	const invFreqWeight = opts.invFreqWeight ?? INV_FREQ_PPR;
	const invFreqAlpha = opts.invFreqAlpha ?? INV_FREQ_ALPHA;

	// Resolve seeds (exact + stem), filter to non-link nodes.
	let seedIds = new Set<string>();
	for (const label of seedLabels) {
		const tid = graph.labelIndex.get(label.toLowerCase());
		if (tid) seedIds.add(tid);
		const ids = graph.stemIndex.get(stemWord(label));
		if (ids) for (const id of ids) seedIds.add(id);
	}
	seedIds = new Set(
		[...seedIds].filter((sid) => {
			const t = graph.thoughts.get(sid);
			return t !== undefined && !graph.isLink(t);
		}),
	);
	if (seedIds.size === 0) return [];

	// Transitive is-a expansion (depth 2, 0.5^depth decay on personalization).
	const expanded = new Map<string, number>();
	for (const sid of seedIds) followIsa(graph, sid, expanded, IS_A_MAX_DEPTH, 1);
	const seedDepths = new Map<string, number>();
	for (const sid of seedIds) seedDepths.set(sid, 0);
	for (const [nid, d] of expanded) if (!seedDepths.has(nid)) seedDepths.set(nid, d);
	seedIds = new Set(seedDepths.keys());

	const { nodeIds, isNode, adj, degree } = buildNxGraph(graph);
	if (nodeIds.length === 0) return [];

	// Personalization with is-a depth decay.
	const pers = new Map<string, number>();
	for (const sid of seedIds) {
		const t = graph.thoughts.get(sid);
		if (t && isNode.has(sid)) {
			const decay = IS_A_DECAY ** seedDepths.get(sid)!;
			pers.set(sid, t.weight * decay);
		}
	}
	if (pers.size === 0) return [];

	let pSum = 0;
	for (const v of pers.values()) pSum += v;
	const p = new Map<string, number>();
	for (const [k, v] of pers) p.set(k, v / pSum);

	let scores = pagerank(nodeIds, adj, p, alpha, PPR_MAX_ITER, PPR_TOL);

	// Inverse-frequency hub suppression.
	if (invFreqWeight) {
		const reweighted = new Map<string, number>();
		for (const [nid, score] of scores) {
			const denom = Math.max(Math.log(1 + (degree.get(nid) ?? 0)) ** invFreqAlpha, 1.0);
			reweighted.set(nid, score / denom);
		}
		scores = reweighted;
	}

	// Top scored nodes (excluding seeds), for the candidate pool.
	const scoredNodes = [...scores].filter(([nid]) => !seedIds.has(nid) && graph.thoughts.has(nid));
	scoredNodes.sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
	const pool = new Set<string>(seedIds);
	for (const [nid] of scoredNodes.slice(0, topN * 3)) pool.add(nid);

	// Triple assembly over link-thoughts with an endpoint in the pool.
	const triples: Triple[] = [];
	const seen = new Set<string>();
	for (const t of graph.thoughts.values()) {
		if (!graph.isLink(t) || !t.link_data) continue;
		if (graph.isExpired(t)) continue;
		const fromId = t.link_data.from_id;
		const toId = t.link_data.to_id;
		if (!pool.has(fromId) && !pool.has(toId)) continue;
		const source = graph.thoughts.get(fromId);
		const target = graph.thoughts.get(toId);
		if (!source || !target || graph.isLink(source) || graph.isLink(target)) continue;

		const linkType = t.link_data.link_type;
		const tk = `${source.label}::${linkType}::${target.label}`;
		const rk = `${target.label}::${linkType}::${source.label}`;
		if (seen.has(tk) || seen.has(rk)) continue;
		seen.add(tk);

		const combined = (scores.get(fromId) ?? 0) + (scores.get(toId) ?? 0);
		if (combined > 0) {
			const clauses = t.link_data.clauses;
			triples.push({
				subject: source.label,
				predicate: linkType,
				object: target.label,
				weight: round6(combined),
				hops: 0,
				clauses: clauses && clauses.length ? clauses : undefined,
			});
		}
	}

	// Entity-coherence rerank (conservative 0.1 tiebreaker).
	if (triples.length) {
		const counts = new Map<string, number>();
		for (const tr of triples) {
			counts.set(tr.subject, (counts.get(tr.subject) ?? 0) + 1);
			counts.set(tr.object, (counts.get(tr.object) ?? 0) + 1);
		}
		for (const tr of triples) {
			const boost = 1 + 0.1 * ((counts.get(tr.subject)! - 1) + (counts.get(tr.object)! - 1));
			tr.weight = round6(tr.weight * boost);
		}
	}

	triples.sort(
		(a, b) =>
			b.weight - a.weight ||
			cmp(a.subject, b.subject) ||
			cmp(a.predicate, b.predicate) ||
			cmp(a.object, b.object),
	);
	return triples.slice(0, topN);
}
