// Unit tests for the mutable Graph API — getOrCreate / addLink /
// expireLink / clause-merge / commutative reverse / 100-word cap / serialize.
// Run from myriapod/:  node_modules/.bin/tsx scripts/test-graph-mutation.ts

import { DescriptionTooLongError, Graph } from "../src/kg/graph.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failures++;
}

const nodeCount = (g: Graph) => [...g.thoughts.values()].filter((t) => !t.link_data).length;
const edgeCount = (g: Graph) => [...g.thoughts.values()].filter((t) => !!t.link_data).length;

// -- getOrCreate (label-upsert) --------------------------------------------
{
	const g = Graph.empty();
	const a = g.getOrCreate("lisbon", 1, "A city in Portugal.", "place");
	check("create returns node", a.label === "lisbon" && a.entity_type === "place");
	check("get is case-insensitive", g.get("Lisbon")?.id === a.id);

	const a2 = g.getOrCreate("lisbon", 1, "A city in Portugal; a popular destination.");
	check("upsert hits same node", a2.id === a.id);
	check("upsert updates description", a2.description === "A city in Portugal; a popular destination.");
	check("upsert creates no duplicate", nodeCount(g) === 1);
}

// -- 100-word description cap ----------------------------------------------
{
	const g = Graph.empty();
	let threw = false;
	try {
		g.getOrCreate("bignode", 1, Array(101).fill("word").join(" "));
	} catch (e) {
		threw = e instanceof DescriptionTooLongError;
	}
	check("101 words throws DescriptionTooLongError", threw);
	check("rejected node not created", g.get("bignode") === null);
	g.getOrCreate("okaynode", 1, Array(100).fill("word").join(" "));
	check("exactly 100 words allowed", g.get("okaynode") !== null);
}

// -- addLink: implicit endpoints, wiring, self-link, non-commutative -------
{
	const g = Graph.empty();
	const link = g.addLink("vim", "is-a", "text-editor");
	check("addLink creates both endpoints", g.get("vim") !== null && g.get("text-editor") !== null);
	check("addLink returns link Thought", link?.link_data?.link_type === "is-a");
	check("hasLink forward true", g.hasLink("vim", "is-a", "text-editor"));
	check("source.links_to wired", g.get("vim")!.links_to.length === 1);
	check("target.links_from wired", g.get("text-editor")!.links_from.length === 1);
	check("is-a creates no reverse", !g.hasLink("text-editor", "is-a", "vim"));
	check("self-link returns null", g.addLink("vim", "relates-to", "vim") === null);
}

// -- commutative reverse (relates-to) --------------------------------------
{
	const g = Graph.empty();
	g.addLink("kubernetes", "relates-to", "docker");
	check("relates-to forward", g.hasLink("kubernetes", "relates-to", "docker"));
	check("relates-to reverse auto-created", g.hasLink("docker", "relates-to", "kubernetes"));
	check("commutative = two edges", edgeCount(g) === 2);
}

// -- clause merge-by-type --------------------------------------------------
{
	const g = Graph.empty();
	g.addLink("alpha", "uses", "beta", 1, [{ type: "because" as const, text: "first reason" }]);
	const link = g.findLink(g.get("alpha")!.id, "uses", g.get("beta")!.id)!;
	check("because clause set on create", link.link_data!.clauses?.length === 1);

	g.addLink("alpha", "uses", "beta", 1, [{ type: "because" as const, text: "second reason" }]);
	const becauses = link.link_data!.clauses!.filter((c) => c.type === "because");
	check("same-type clause replaced not duplicated", becauses.length === 1);
	check("clause is the latest value", becauses[0].text === "second reason");

	g.addLink("alpha", "uses", "beta", 1, [{ type: "with" as const, text: "via x" }]);
	check("different-type clause appended", link.link_data!.clauses!.length === 2);
	// created on call 1 (no fire), fired on the 2 subsequent existing-edge re-adds.
	check("existing edge fired on each re-add", link.hit_count === 2);
}

// -- expireLink + commutative reverse + hasLink-counts-expired -------------
{
	const g = Graph.empty();
	g.addLink("x", "relates-to", "y");
	const xid = g.get("x")!.id;
	const yid = g.get("y")!.id;
	const expired = g.expireLink(xid, "relates-to", yid);
	check("expireLink returns the link", expired !== null);
	check("edge is expired", g.isExpired(expired!));
	check("findLink still returns expired edge", g.findLink(xid, "relates-to", yid) !== null);
	check("commutative reverse also expired", g.isExpired(g.findLink(yid, "relates-to", xid)!));
	check("hasLink counts expired as present (matches /ingest gate)", g.hasLink("x", "relates-to", "y"));
}

// -- addLink reactivates an expired edge -----------------------------------
{
	const g = Graph.empty();
	g.addLink("p", "uses", "q");
	const pid = g.get("p")!.id;
	const qid = g.get("q")!.id;
	g.expireLink(pid, "uses", qid);
	check("expired before reactivation", g.isExpired(g.findLink(pid, "uses", qid)!));
	g.addLink("p", "uses", "q");
	check("addLink reactivates expired edge", !g.isExpired(g.findLink(pid, "uses", qid)!));
}

// -- serialize round-trip ---------------------------------------------------
{
	const g = Graph.empty();
	g.getOrCreate("alpha", 1, "First node.", "concept");
	g.addLink("alpha", "relates-to", "beta");
	const asset = g.serialize();
	check("serialize node/edge counts", asset.meta.node_count === 2 && asset.meta.edge_count === 2);

	const g2 = new Graph(asset);
	check("round-trip description", g2.get("alpha")?.description === "First node.");
	check(
		"round-trip edges (both directions)",
		g2.hasLink("alpha", "relates-to", "beta") && g2.hasLink("beta", "relates-to", "alpha"),
	);
	check("round-trip term_match", g2.termMatch("alpha").some((m) => m.label === "alpha"));
}

console.log(failures === 0 ? "\nAll mutation tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
