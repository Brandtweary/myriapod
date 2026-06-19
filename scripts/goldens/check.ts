// Golden test: TS retrieval port vs Python ground truth (goldens.json).
// Run from cymbiont-web/ after gen_python_goldens.py:
//     node_modules/.bin/tsx scripts/goldens/check.ts
//
// Gates (hard, exit 1 on failure):
//   - term_match: exact label-set match
//   - ppr_from_py_seeds: TS PPR fed Python's seeds must match Python's triples
//     (isolates PPR fidelity from the seed approximation)
// Informational (reported, never fails — diverge by design):
//   - seeds: POS-approximation divergence
//   - full_pipeline: end-to-end (carries the seed divergence)
//   - stemmer: original-Porter vs NLTK-Porter divergence

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Graph } from "../../src/kg/graph.ts";
import { extractSeedLabels } from "../../src/kg/seeds.ts";
import { queryPpr } from "../../src/kg/ppr.ts";
import { mmrRerankTriples } from "../../src/kg/mmr.ts";
import { retrieve } from "../../src/kg/retrieve.ts";
import { InjectedLedger } from "../../src/kg/ledger.ts";
import { stemWord } from "../../src/kg/stem.ts";
import { MMR_CANDIDATES, MMR_LAMBDA, TRIPLES_PER_RETRIEVE } from "../../src/kg/config.ts";
import type { StockGraphAsset, Triple } from "../../src/kg/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const OVERFETCH = Math.max(MMR_CANDIDATES, TRIPLES_PER_RETRIEVE);
const WEIGHT_TOL = 1e-4;

const asset = JSON.parse(readFileSync(join(root, "public", "stock-kg.json"), "utf8")) as StockGraphAsset;
type GTriple = { subject: string; predicate: string; object: string; weight: number };
const goldens = JSON.parse(readFileSync(join(here, "goldens.json"), "utf8")) as {
	term_match: Record<string, string[]>;
	seeds: Record<string, string[]>;
	ppr_from_py_seeds: Record<string, GTriple[]>;
	full_pipeline: Record<string, GTriple[]>;
	retriever_triples: Record<string, GTriple[]>;
	retriever_terms: Record<string, string[]>;
	retrieve_block: Record<string, string | null>;
	stems: Record<string, string>;
};

const g = new Graph(asset);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const spo = (t: { subject: string; predicate: string; object: string }) =>
	`${t.subject}::${t.predicate}::${t.object}`;

// Compare ordered triple lists: s/p/o sequence exact, weights within tolerance.
function tripleDiff(got: Triple[], exp: GTriple[]): string | null {
	const gSeq = got.map(spo);
	const eSeq = exp.map(spo);
	if (!eq(gSeq, eSeq)) {
		const missing = eSeq.filter((s) => !gSeq.includes(s));
		const extra = gSeq.filter((s) => !eSeq.includes(s));
		return `seq differs (len ts=${gSeq.length} py=${eSeq.length})\n     missing: ${JSON.stringify(missing.slice(0, 6))}\n     extra:   ${JSON.stringify(extra.slice(0, 6))}`;
	}
	let maxW = 0;
	for (let i = 0; i < got.length; i++) maxW = Math.max(maxW, Math.abs(got[i].weight - exp[i].weight));
	if (maxW > WEIGHT_TOL) return `weights diverge (max Δ=${maxW.toExponential(2)})`;
	return null;
}

// --- term_match (gate) ---
let tmPass = 0;
const tmFails: string[] = [];
for (const [q, exp] of Object.entries(goldens.term_match)) {
	const got = g.termMatch(q).map((m) => m.label).sort();
	if (eq(got, [...exp].sort())) tmPass++;
	else tmFails.push(`  "${q}" ts=${JSON.stringify(got)} py=${JSON.stringify(exp)}`);
}

// --- PPR from Python seeds (gate) ---
let pprPass = 0;
const pprFails: string[] = [];
let pprMaxW = 0;
for (const [q, exp] of Object.entries(goldens.ppr_from_py_seeds)) {
	const pySeeds = goldens.seeds[q];
	const got = queryPpr(g, pySeeds, { topN: OVERFETCH });
	const diff = tripleDiff(got, exp);
	if (!diff) {
		pprPass++;
		for (let i = 0; i < got.length; i++) pprMaxW = Math.max(pprMaxW, Math.abs(got[i].weight - exp[i].weight));
	} else pprFails.push(`  "${q}": ${diff}`);
}

// --- full pipeline (informational) ---
let fpPass = 0;
const fpFails: string[] = [];
for (const [q, exp] of Object.entries(goldens.full_pipeline)) {
	const seeds = extractSeedLabels(q, g);
	const ppr = queryPpr(g, seeds, { topN: OVERFETCH });
	const got = mmrRerankTriples(ppr, g.embeddings, g.labelIndex, TRIPLES_PER_RETRIEVE, MMR_LAMBDA);
	if (!tripleDiff(got, exp)) fpPass++;
	else fpFails.push(`  "${q}": ts=${JSON.stringify(got.map(spo))}\n       py=${JSON.stringify(exp.map(spo))}`);
}

// --- retrieve.ts: vacuum triples/terms + assembled block (gate) ---
let rPass = 0;
const rFails: string[] = [];
for (const q of Object.keys(goldens.term_match)) {
	const ledger = new InjectedLedger(); // fresh ⇒ no dedup, vacuum == injection source
	const r = retrieve(g, ledger, q);
	const triDiff = tripleDiff(r.vacuum.triples, goldens.retriever_triples[q]);
	const termsGot = r.vacuum.terms.map((m) => m.label).sort();
	const termsOk = eq(termsGot, [...goldens.retriever_terms[q]].sort());
	const blockOk = (r.injectionBlock ?? null) === (goldens.retrieve_block[q] ?? null);
	if (!triDiff && termsOk && blockOk) rPass++;
	else {
		const issues: string[] = [];
		if (triDiff) issues.push(`triples: ${triDiff}`);
		if (!termsOk) issues.push(`terms ts=${JSON.stringify(termsGot)} py=${JSON.stringify(goldens.retriever_terms[q])}`);
		if (!blockOk) issues.push(`block mismatch`);
		rFails.push(`  "${q}": ${issues.join("; ")}`);
	}
}

// --- seeds (informational) ---
let seedPass = 0;
const seedFails: string[] = [];
for (const [q, exp] of Object.entries(goldens.seeds)) {
	const got = extractSeedLabels(q, g).sort();
	if (eq(got, [...exp].sort())) seedPass++;
	else {
		const missing = exp.filter((l) => !got.includes(l));
		const extra = got.filter((l) => !exp.includes(l));
		seedFails.push(`  "${q}" missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
	}
}

// --- stemmer (informational) ---
let stPass = 0;
let stDiverge = 0;
for (const [w, exp] of Object.entries(goldens.stems)) {
	if (stemWord(w) === exp) stPass++;
	else stDiverge++;
}

const n = Object.keys(goldens.term_match).length;
const stN = Object.keys(goldens.stems).length;
console.log(`\n=== GATES ===`);
console.log(`term_match:        ${tmPass}/${n} match`);
if (tmFails.length) console.log(tmFails.join("\n"));
console.log(`ppr (py seeds):    ${pprPass}/${n} match (max weight Δ=${pprMaxW.toExponential(2)})`);
if (pprFails.length) console.log(pprFails.join("\n"));
console.log(`retrieve.ts:       ${rPass}/${n} match (triples + terms + <kg-context> block)`);
if (rFails.length) console.log(rFails.join("\n"));
console.log(`\n=== INFORMATIONAL ===`);
console.log(`seeds:             ${seedPass}/${n} exact (POS-approx divergence expected)`);
if (seedFails.length) console.log(seedFails.join("\n"));
console.log(`full_pipeline:     ${fpPass}/${n} match (carries seed divergence)`);
if (fpFails.length) console.log(fpFails.join("\n"));
console.log(`stemmer:           ${stPass}/${stN} match (${stDiverge} diverge)`);

const gateFail = tmFails.length || pprFails.length || rFails.length;
process.exit(gateFail ? 1 : 0);
