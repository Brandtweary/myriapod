// Unit tests for the term-store API — getOrCreate / aliases / rename / merge /
// remove / 100-word cap / serialize / term-match.
// Run from myriapod/:  node_modules/.bin/tsx scripts/test-graph-mutation.ts

import { DescriptionTooLongError, Graph } from "../src/kg/graph.ts";
import { boundaryAssertions, escapeRegExp } from "../src/regex-utils.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failures++;
}

const termCount = (g: Graph) => g.thoughts.size;

// -- getOrCreate (label-upsert) --------------------------------------------
{
	const g = Graph.empty();
	const a = g.getOrCreate("lisbon", "A city in Portugal.", "place");
	check("create returns term", a.label === "lisbon" && a.entity_type === "place");
	check("get is case-insensitive", g.get("Lisbon")?.id === a.id);

	const a2 = g.getOrCreate("lisbon", "A city in Portugal; a popular destination.");
	check("upsert hits same term", a2.id === a.id);
	check("upsert updates description", a2.description === "A city in Portugal; a popular destination.");
	check("upsert creates no duplicate", termCount(g) === 1);
	check("description change nulls the embedding", a2.embedding === null);
}

// -- 100-word description cap ----------------------------------------------
{
	const g = Graph.empty();
	let threw = false;
	try {
		g.getOrCreate("bignode", Array(101).fill("word").join(" "));
	} catch (e) {
		threw = e instanceof DescriptionTooLongError;
	}
	check("101 words throws DescriptionTooLongError", threw);
	check("rejected term not created", g.get("bignode") === null);
	g.getOrCreate("okaynode", Array(100).fill("word").join(" "));
	check("exactly 100 words allowed", g.get("okaynode") !== null);
}

// -- aliases: add / route / collision / remove -----------------------------
{
	const g = Graph.empty();
	g.getOrCreate("kubernetes", "Container orchestration.");
	check("add alias ok", g.addAlias("kubernetes", "k8s"));
	check("alias routes in term-match", g.termMatch("deploying k8s today").some((m) => m.label === "kubernetes"));
	check("duplicate alias rejected", !g.addAlias("kubernetes", "k8s"));
	g.getOrCreate("docker", "Container runtime.");
	check("alias colliding with another label rejected", !g.addAlias("docker", "kubernetes"));
	check("remove alias ok", g.removeAlias("kubernetes", "k8s"));
	check("removed alias no longer routes", !g.termMatch("k8s").some((m) => m.label === "kubernetes"));
}

// -- rename (in place) ------------------------------------------------------
{
	const g = Graph.empty();
	g.getOrCreate("same", "The same-origin policy.");
	g.get("same")!.hit_count = 5;
	check("rename ok", g.rename("same", "same-origin-policy"));
	check("old label gone", g.get("same") === null);
	check("new label present, hit_count preserved", g.get("same-origin-policy")?.hit_count === 5);
	g.getOrCreate("taken", "x");
	check("rename onto existing label rejected", !g.rename("same-origin-policy", "taken"));
}

// -- merge (loser label + aliases → survivor aliases, hits sum) ------------
{
	const g = Graph.empty();
	g.getOrCreate("honeybee", "The common honeybee.");
	g.get("honeybee")!.hit_count = 3;
	g.getOrCreate("apis-mellifera", "Western honeybee, binomial name.");
	g.get("apis-mellifera")!.hit_count = 1;
	check("merge ok", g.merge("apis-mellifera", "honeybee"));
	check("loser gone", g.get("apis-mellifera") === null);
	check("loser label becomes survivor alias", g.get("honeybee")!.aliases.includes("apis-mellifera"));
	check("hit counts summed", g.get("honeybee")!.hit_count === 4);
	// The merged-away binomial routes to the survivor when spoken (the realistic
	// form — STT emits no hyphens; aliases are spoken variants).
	check("merged-away label still routes via alias", g.termMatch("saw an apis mellifera").some((m) => m.label === "honeybee"));
}

// -- remove -----------------------------------------------------------------
{
	const g = Graph.empty();
	g.getOrCreate("noise", "junk term.");
	check("remove ok", g.remove("noise"));
	check("removed term gone", g.get("noise") === null);
	check("remove missing term is false", !g.remove("nope"));
}

// -- serialize round-trip ---------------------------------------------------
{
	const g = Graph.empty();
	g.getOrCreate("alpha", "First term.", "concept");
	g.addAlias("alpha", "a1");
	const asset = g.serialize();
	check("serialize term count", asset.meta.node_count === 1);

	const g2 = new Graph(asset);
	check("round-trip description", g2.get("alpha")?.description === "First term.");
	check("round-trip alias routes", g2.termMatch("a1 mentioned").some((m) => m.label === "alpha"));
	check("round-trip term_match", g2.termMatch("alpha").some((m) => m.label === "alpha"));
}

// -- non-ASCII / punctuated surface forms retrieve --------------------------
{
	// Accented single-word label: the tokenizer must keep the accent so the stored
	// key ("café") is reproducible from an input token.
	const g = Graph.empty();
	g.getOrCreate("café", "A coffeehouse.");
	check("accented single-word term retrieves", g.termMatch("met them at a café today").some((m) => m.label === "café"));

	// Apostrophe label: gets a punct→space auto-variant so a form typed with the
	// apostrophe still routes.
	g.getOrCreate("O'Brien", "A person we discussed.");
	check("apostrophe label retrieves", g.termMatch("spoke with O'Brien yesterday").some((m) => m.label === "O'Brien"));

	// Hyphenated alias typed WITH the hyphen (the live apis-mellifera class).
	g.getOrCreate("honeybee", "The common honeybee.");
	check("add hyphenated alias ok", g.addAlias("honeybee", "apis-mellifera"));
	check("hyphenated alias typed with hyphen retrieves", g.termMatch("found an apis-mellifera specimen").some((m) => m.label === "honeybee"));

	// Multi-word alias with a punctuation-bounded (sentence-final) edge — the
	// STT-garble class this alias mechanism exists for. termMatch happens to
	// also index a punctuation-stripped auto-variant of a multi-word alias
	// (the tokenizer's punct-to-space normalization), which shadows the raw
	// key here and matches regardless of whether its own boundary logic is
	// correct — so this exercises the live retrieval path but does not by
	// itself discriminate the boundary fix; the regex-utils tests below do.
	g.getOrCreate("orchestration", "Container orchestration platform.");
	check("add punctuation-edged alias ok", g.addAlias("orchestration", "k8s cluster."));
	check(
		"punctuation-edged multi-word alias matches at sentence end",
		g.termMatch("we stood up a k8s cluster. it works well").some((m) => m.label === "orchestration"),
	);
}

// -- regex-utils: edge-aware boundary assertions -----------------------------
// The primitive termMatch's multi-word path is built on. Isolated here since
// termMatch's own auto punct-stripped alias variant (above) can shadow a
// broken boundary and mask the defect at that layer.
{
	const matches = (key: string, text: string): boolean => {
		const [lead, trail] = boundaryAssertions(key);
		return new RegExp(`${lead}${escapeRegExp(key)}${trail}`, "i").test(text);
	};
	check(
		"punctuation-trailing key matches at sentence end",
		matches("claude.", "please open claude. thanks"),
	);
	check(
		"word-edged key still refuses a mid-word hit",
		!matches("cat", "concatenate"),
	);
}

console.log(failures === 0 ? "\nAll term-store tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
