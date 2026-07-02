// Unit tests for the shared pipeline machinery — injected-context stripping,
// the existing-memory dump, and the thin-turn guard. (Extraction is now a
// tooled agent loop, verified live, not a JSON parser.) Also covers the
// similarity primitives that back mint-time dedup.
// Run from myriapod/:  node_modules/.bin/tsx scripts/test-ingest.ts

import { Graph } from "../src/kg/graph.ts";
import { dumpExistingContext, hasContentWords, stripInjectedContext } from "../src/kg/ingest.ts";
import { cosineSimilarity, findSimilarTerms, jaroWinkler } from "../src/kg/similarity.ts";
import { applyAutoReplace, emptySttLexicon, mistranscriptionCount } from "../src/stt-lexicon.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failures++;
}

// -- stripInjectedContext ---------------------------------------------------
{
	const s = stripInjectedContext("hello <memory>SECRET</memory> world");
	check("memory block removed", !s.includes("memory") && !s.includes("SECRET"));
	check("surrounding text preserved", s.includes("hello") && s.includes("world"));
}

// -- hasContentWords (thin-turn guard) -------------------------------------
{
	check("thin turn has no content words", !hasContentWords("ok so"));
	check("substantive turn has content words", hasContentWords("tell me about vector databases"));
}

// -- dumpExistingContext ----------------------------------------------------
{
	check("empty memory dump message", dumpExistingContext(Graph.empty()).includes("empty"));
	const g = Graph.empty();
	g.getOrCreate("lisbon", "A city in Portugal.", "place");
	g.addAlias("lisbon", "lisboa");
	const dump = dumpExistingContext(g);
	check("dump lists the term", dump.includes("- lisbon (place)"));
	check("dump lists aliases", dump.includes("aliases: lisboa"));
}

// -- similarity: Jaro-Winkler + cosine + findSimilarTerms ------------------
{
	check("JW identical is 1", jaroWinkler("kubernetes", "kubernetes") === 1);
	check("JW near-variant is high", jaroWinkler("kubernetes", "kubernete") > 0.9);
	// The meaningful property: unrelated terms fall below the 0.87 dedup threshold
	// (findSimilarTerms uses that gate), not that JW is near-zero.
	check("JW unrelated is below the dedup threshold", jaroWinkler("postgres", "sqlite") < 0.87);
	check("cosine identical is ~1", Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
	check("cosine orthogonal is 0", cosineSimilarity([1, 0], [0, 1]) === 0);

	const g = Graph.empty();
	g.getOrCreate("kubernetes", "Container orchestration platform.");
	g.getOrCreate("postgres", "Relational database.");
	const hits = findSimilarTerms(g, "kubernetized", null);
	check("string-similar term surfaces", hits.some((c) => c.term.label === "kubernetes"));
	check("unrelated term does not surface", !hits.some((c) => c.term.label === "postgres"));
	check("exact-label match is excluded (upsert, not dup)", findSimilarTerms(g, "kubernetes", null).every((c) => c.term.label !== "kubernetes"));
}

// -- STT lexicon: count + auto-replace --------------------------------------
{
	const lex = emptySttLexicon();
	lex.mistranscriptions.push({ spoken: "swarm", transcribed: "storm", kind: "phonetic", ts: "t" });
	lex.mistranscriptions.push({ spoken: "swarm", transcribed: "storm", kind: "phonetic", ts: "t2" });
	check("mistranscription count tallies repeats", mistranscriptionCount(lex, "swarm", "storm") === 2);

	const rules = [{ from: "kuber netties", to: "Kubernetes", ts: "t" }];
	check("auto-replace rewrites the phrase", applyAutoReplace("deploying kuber netties now", rules) === "deploying Kubernetes now");
	check("auto-replace is case-insensitive", applyAutoReplace("Kuber Netties rocks", rules) === "Kubernetes rocks");
	check("auto-replace leaves unrelated text", applyAutoReplace("no match here", rules) === "no match here");
}

console.log(failures === 0 ? "\nAll pipeline-machinery tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
