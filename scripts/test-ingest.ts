// Unit tests for the ingestion pipeline (Slice 3) — tolerant parse + truncation
// salvage, the _handle_ingest apply control flow (orphan reject / clause-merge
// gate / expiration), and the text helpers. Network completion is verified live.
// Run from cymbiont/:  node_modules/.bin/tsx scripts/test-ingest.ts

import { Graph } from "../src/kg/graph.ts";
import {
	applyExtraction,
	dumpExistingContext,
	extractJsonObject,
	parseExtraction,
	stripInjectedContext,
} from "../src/kg/ingest.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failures++;
}

// -- parseExtraction: valid + truncation salvage ---------------------------
{
	const valid = parseExtraction('{"entities":[],"relationships":[],"expirations":[]}');
	check("valid JSON parses ok", valid.ok === true);

	// Truncated mid second entity object — salvage the first, drop the partial.
	const truncated = parseExtraction(
		'{"entities":[{"label":"alpha","type":"concept","summary":"x"},{"label":"be',
	);
	check("truncated JSON flagged ok=false", truncated.ok === false);
	check("truncated salvages first complete object", truncated.payload.entities?.length === 1);
	check("salvaged object intact", truncated.payload.entities?.[0].label === "alpha");
}

// -- extractJsonObject: strip preamble -------------------------------------
{
	const j = extractJsonObject('Sure, here:\n{"entities":[]}\nDone.');
	check("brace-bracket strips preamble", j === '{"entities":[]}');
	check("no JSON returns null", extractJsonObject("no json here") === null);
}

// -- stripInjectedContext ---------------------------------------------------
{
	const s = stripInjectedContext("hello <kg-context>SECRET</kg-context> world");
	check("kg-context block removed", !s.includes("kg-context") && !s.includes("SECRET"));
	check("surrounding text preserved", s.includes("hello") && s.includes("world"));
}

// -- applyExtraction: orphan reject + link create + implicit endpoints -----
{
	const g = Graph.empty();
	const stats = applyExtraction(g, {
		entities: [
			{ label: "lisbon", type: "place", summary: "A city in Portugal." },
			{ label: "brother", type: "person", summary: "The user's brother." },
			{ label: "orphan-node", type: "concept", summary: "Referenced by nothing." },
		],
		relationships: [
			{ subject: "user", predicate: "plans-trip-to", object: "lisbon", because: "a conference" },
			{ subject: "user", predicate: "has", object: "brother" },
		],
		expirations: [],
	});
	check("orphan entity rejected", stats.rejectedOrphan === 1 && g.get("orphan-node") === null);
	check("referenced entities added", stats.entitiesAdded === 2 && stats.newEntities === 2);
	check("links created", stats.linksAdded === 2);
	check("implicit endpoint node created", g.get("user") !== null);
	check("relationship present", g.hasLink("user", "plans-trip-to", "lisbon"));
	const link = g.findLink(g.get("user")!.id, "plans-trip-to", g.get("lisbon")!.id)!;
	check("because clause attached", link.link_data!.clauses?.some((c) => c.type === "because") === true);

	// Existing edge: a second payload with a `with` clause merges only (no new link).
	const stats2 = applyExtraction(g, {
		relationships: [
			{ subject: "user", predicate: "plans-trip-to", object: "lisbon", with: "next spring" },
		],
	});
	check("existing edge → clause merge only, no new link", stats2.linksAdded === 0 && stats2.clausesMerged === 1);
	check("both clause types now present", link.link_data!.clauses?.length === 2);

	// Expiration applies only when both endpoints exist.
	const stats3 = applyExtraction(g, {
		expirations: [{ subject: "user", predicate: "plans-trip-to", object: "lisbon", reason: "cancelled" }],
	});
	check("expiration applied", stats3.expirationsApplied === 1 && g.isExpired(link));
	const statsNo = applyExtraction(g, {
		expirations: [{ subject: "ghost", predicate: "uses", object: "phantom", reason: "n/a" }],
	});
	check("expiration on missing endpoints is a no-op", statsNo.expirationsApplied === 0);
}

// -- dumpExistingContext ----------------------------------------------------
{
	check("empty graph dump message", dumpExistingContext(Graph.empty()).includes("empty"));
	const g = Graph.empty();
	g.getOrCreate("lisbon", 1, "A city in Portugal.", "place");
	g.addLink("lisbon", "is-a", "city");
	const dump = dumpExistingContext(g);
	check("dump lists the node", dump.includes("- lisbon (place)"));
	check("dump lists active edge", dump.includes("--is-a--> city"));
}

console.log(failures === 0 ? "\nAll ingestion tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
