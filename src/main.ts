import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	createJavaScriptReplTool,
	IndexedDBStorageBackend,
	// PersistentStorageDialog, // TODO: Fix - currently broken
	ProviderKeysStore,
	SessionListDialog,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "@earendil-works/pi-web-ui";
import { html, render } from "lit";
import { History, Plus, Settings } from "lucide";
import "./app.css";
import { getTranslations, icon, setTranslations } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { CYMBIONT_MODEL, CYMBIONT_THINKING_LEVEL, DEEPSEEK_V4_FLASH } from "./cymbiont-model.js";
import { MemoryTab, OpenRouterKeyTab } from "./settings.js";
import { dbg, dbgError, dbgWarn, installInstrumentation, summarizeMessages } from "./debug.js";
import {
	createKgContextMessage,
	customConvertToLlm,
	registerCustomMessageRenderers,
} from "./custom-messages.js";
import { Graph } from "./kg/graph.js";
import { InjectedLedger } from "./kg/ledger.js";
import { retrieve } from "./kg/retrieve.js";
import { makeOpenRouterCompletion, runIngestion } from "./kg/ingest.js";
import type { StockGraphAsset, TermMatch, Triple } from "./kg/types.js";

// Register custom message renderers
registerCustomMessageRenderers();

// Rename pi-web-ui's "session" vocabulary to the friendlier "chat" everywhere it
// surfaces (the SessionListDialog title etc. render via mini-lit's i18n). We
// can't edit the dependency's strings, but we can override the translations.
const baseTranslations = getTranslations();
setTranslations({
	...baseTranslations,
	en: {
		...baseTranslations.en,
		Sessions: "Chats",
		"No sessions yet": "No chats yet",
		"Delete this session?": "Delete this chat?",
		"Load a previous conversation": "Load a previous chat",
	} as typeof baseTranslations.en,
});

// Personal knowledge graph persistence (Slice 4): one serialized StockGraphAsset
// blob in its own IndexedDB store — the user's memory across all conversations.
const PERSONAL_GRAPH_STORE = "personal-graph";
const PERSONAL_GRAPH_KEY = "graph";

// Create stores
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

// Gather configs
const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
	{ name: PERSONAL_GRAPH_STORE }, // personal knowledge graph (serialized asset)
];

// Create backend
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 3, // v3: added the personal-graph store
	stores: configs,
});

// Wire backend to stores
settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

// Create and set app storage
const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let currentView: "chat" | "about" = "chat";
let agent: Agent;
let chatPanel: ChatPanel;
let headerHost: HTMLDivElement;
let aboutHost: HTMLDivElement;
let agentUnsubscribe: (() => void) | undefined;

// Stall-timing scratch (see the agent listener) — last message_update timestamp
// and per-message update count, used to measure the gap from the last streamed
// token to the terminal event.
let lastUpdateAt = 0;
let updateCount = 0;

// --- Browser-local knowledge graph (no server; retrieval runs in-page) ---
let kgGraph: Graph | undefined;
// Per-conversation injected-ledger (cross-turn dedup). Reset on each createAgent.
// NOTE: a RESTORED session starts with an empty ledger even though its saved
// kg-context breadcrumbs are in the transcript — so the first turns after a
// reload may re-inject already-present context (minor token waste, self-corrects
// as the conversation continues). Acceptable for V1.
let ledger = new InjectedLedger();
// Personal/user knowledge graph — mutable, in-page, PPR-only. Grows via per-turn
// ingestion (agent_end trigger), retrieved alongside the stock graph. Slice 4
// loads/persists it from IndexedDB; until then it lives for the session.
let userGraph = Graph.empty();
// User text of the in-flight turn, stashed by the prompt wrapper for the
// agent_end ingestion trigger.
let pendingTurnUserText = "";
let bodyHost: HTMLDivElement; // flex-row wrapper: [leftGutter, chatPanel, rightGutter]
let leftGutter: HTMLDivElement; // term matches
let rightGutter: HTMLDivElement; // triples
let lastVacuum: { terms: TermMatch[]; triples: Triple[] } | null = null;

// PROVEN ROOT-CAUSE FIX. pi-web-ui's <message-list> only re-renders when its
// `.messages` prop changes by IDENTITY, but pi-agent-core mutates
// `state.messages` in place (push). So committed messages never repaint — the
// render-call logs showed AgentInterface.renderMessages() running with the new
// count while MessageList.render() never fired (mlRows frozen, sameArrayRef=true).
// Reassigning to a fresh array reference makes the prop identity change, forcing
// MessageList to re-render. requestUpdate() then re-runs renderMessages with the
// new reference. (Also fixes the stuck stop button: a post-finishRun repaint
// re-renders the editor with isStreaming=false.)
const forceChatRepaint = () => {
	if (!agent || !chatPanel?.agentInterface) return;
	agent.state.messages = [...agent.state.messages];
	chatPanel.agentInterface.requestUpdate();
};

// The chat panel is mounted once and lives OUTSIDE the reactive render root, so
// no host render ever touches it (re-committing it mid-turn is what wiped the
// streaming message). We only toggle which body element is visible.
const updateBodyVisibility = () => {
	if (!bodyHost || !aboutHost) return;
	const showAbout = currentView === "about";
	bodyHost.style.display = showAbout ? "none" : "";
	aboutHost.style.display = showAbout ? "" : "none";
};

const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c): c is TextContent => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m) => m.role === "user");
	const hasAssistantMsg = messages.some((m) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Create session data
		const sessionData = {
			id: currentSessionId,
			title: currentTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
		};

		// Create session metadata
		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt: sessionData.createdAt,
			lastModified: sessionData.lastModified,
			messageCount: state.messages.length,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			modelId: state.model?.id || null,
			thinkingLevel: state.thinkingLevel,
			preview: generateTitle(state.messages),
		};

		await storage.sessions.save(sessionData, metadata);
		dbg(`saveSession OK — id=${currentSessionId}, ${summarizeMessages(state.messages)}`);
	} catch (err) {
		dbgWarn(`saveSession FAILED — id=${currentSessionId}:`, err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

// Load the frozen stock graph (static asset, built by scripts/build-stock-kg.py)
// into an in-page Graph. Retrieval is fully client-side — nothing hits a server.
const loadStockGraph = async () => {
	try {
		const base = import.meta.env.BASE_URL ?? "/";
		const res = await fetch(`${base}stock-kg.json`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const asset = (await res.json()) as StockGraphAsset;
		kgGraph = new Graph(asset);
		dbg(`stock KG loaded: ${asset.meta.node_count} nodes, ${asset.meta.edge_count} edges`);
	} catch (err) {
		dbgError("stock KG load failed — retrieval disabled:", err);
		kgGraph = undefined;
	}
};

// Fold an ingestion call's tokens + cost into the SESSION total. The framework's
// stats line sums msg.usage over assistant messages, so attributing ingestion to
// the latest assistant message makes the displayed total the true session cost
// (chat + every ingestion the chat triggered) — no override of framework UI.
function addIngestionCostToSession(promptTokens: number, completionTokens: number): void {
	const c = DEEPSEEK_V4_FLASH.cost;
	const inCost = (promptTokens / 1_000_000) * c.input;
	const outCost = (completionTokens / 1_000_000) * c.output;
	type Usage = {
		input: number;
		output: number;
		cost?: { input?: number; output?: number; total?: number };
	};
	const msgs = agent.state.messages as unknown as Array<{ role: string; usage?: Usage }>;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role === "assistant" && m.usage) {
			m.usage.input += promptTokens;
			m.usage.output += completionTokens;
			if (m.usage.cost) {
				m.usage.cost.input = (m.usage.cost.input ?? 0) + inCost;
				m.usage.cost.output = (m.usage.cost.output ?? 0) + outCost;
				m.usage.cost.total = (m.usage.cost.total ?? 0) + inCost + outCost;
			}
			break;
		}
	}
	chatPanel.agentInterface?.requestUpdate?.();
	dbg(`ingestion cost folded into session: +${promptTokens}in/${completionTokens}out tok, +$${(inCost + outCost).toFixed(6)}`);
}

// Fire-and-forget per-turn ingestion into the personal graph. Reads the user's
// own OpenRouter key (Phase 3 is own-key only — a no-op on the hosted free tier
// until the Phase 4 proxy supplies an ingestion route). Always Flash: cheap
// structured extraction, independent of the chat model.
async function triggerIngestion(userText: string, messages: AgentMessage[]): Promise<void> {
	if (!userText.trim()) return;
	const apiKey = await providerKeys.get("openrouter");
	if (!apiKey) {
		dbg("ingestion skipped: no OpenRouter key (own-key path only in Phase 3)");
		return;
	}
	const turnText = `[USER]:\n${userText}\n\n[ASSISTANT]:\n${lastAssistantText(messages)}`;
	const completion = makeOpenRouterCompletion({
		apiKey,
		model: DEEPSEEK_V4_FLASH.id,
		onUsage: ({ promptTokens, completionTokens }) =>
			addIngestionCostToSession(promptTokens, completionTokens),
	});
	const stats = await runIngestion(userGraph, turnText, completion);
	if (stats) {
		dbg(
			`ingestion: +${stats.newEntities} new nodes, +${stats.linksAdded} links, ` +
				`${stats.clausesMerged} clauses merged, ${stats.rejectedOrphan} orphans rejected, ` +
				`${stats.expirationsApplied} expired (personal graph now ${userGraph.thoughts.size} thoughts)`,
		);
		if (stats.entitiesAdded || stats.linksAdded || stats.clausesMerged || stats.expirationsApplied) {
			await saveUserGraph();
		}
	} else {
		dbg("ingestion: skipped (thin turn) or no parseable output");
	}
}

// -- Personal-graph persistence + export/import (Slice 4) -------------------

// One global graph per browser. Loaded at boot, saved after each ingestion.
async function loadUserGraph(): Promise<void> {
	try {
		const asset = await backend.get<StockGraphAsset>(PERSONAL_GRAPH_STORE, PERSONAL_GRAPH_KEY);
		if (asset) {
			userGraph = new Graph(asset);
			dbg(`personal graph loaded: ${asset.meta.node_count} nodes, ${asset.meta.edge_count} edges`);
		}
	} catch (err) {
		dbgError("personal graph load failed (starting empty):", err);
	}
}

async function saveUserGraph(): Promise<void> {
	try {
		await backend.set(PERSONAL_GRAPH_STORE, PERSONAL_GRAPH_KEY, userGraph.serialize());
	} catch (err) {
		dbgError("personal graph save failed:", err);
	}
}

// Export: download the personal graph as JSON (the real durability story —
// IndexedDB can be evicted and PersistentStorageDialog is broken upstream).
function downloadPersonalGraph(): void {
	const blob = new Blob([JSON.stringify(userGraph.serialize(), null, 2)], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `cymbiont-personal-graph-${new Date().toISOString().slice(0, 10)}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

// Import: replace the personal graph from an uploaded export and persist it.
async function importPersonalGraphFromFile(file: File): Promise<void> {
	const asset = JSON.parse(await file.text()) as StockGraphAsset;
	if (!asset || typeof asset !== "object" || typeof asset.thoughts !== "object") {
		throw new Error("not a Cymbiont personal-graph export");
	}
	userGraph = new Graph(asset);
	await saveUserGraph();
	dbg(`personal graph imported: ${userGraph.thoughts.size} thoughts`);
}

// agent.prompt accepts a string or an AgentMessage[]; pull the user's text out.
const extractUserText = (input: AgentMessage | AgentMessage[] | string): string => {
	if (typeof input === "string") return input;
	const msgs = Array.isArray(input) ? input : [input];
	const parts: string[] = [];
	for (const m of msgs) {
		const c = (m as { content?: unknown }).content;
		if (typeof c === "string") parts.push(c);
		else if (Array.isArray(c))
			for (const blk of c) {
				if (blk && typeof blk === "object" && (blk as TextContent).type === "text") {
					parts.push((blk as TextContent).text ?? "");
				}
			}
	}
	return parts.join(" ");
};

const lastAssistantText = (messages: AgentMessage[]): string => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const c = (m as { content?: unknown }).content;
		if (typeof c === "string") return c;
		if (Array.isArray(c))
			return c
				.filter((b): b is TextContent => !!b && (b as TextContent).type === "text")
				.map((b) => b.text ?? "")
				.join(" ");
		return "";
	}
	return "";
};

// The gutters: term matches (left) + triples (right). Owned plain DOM we update
// imperatively from the latest retrieval's VACUUM set (full pre-dedup), so they
// show what WOULD retrieve this turn even when the injection deduped some out.
// Provenance split: personal-graph items (the common case) render first in the
// default green; stock-graph items (the marked exception) group below a
// subheading in violet + serif. "stock" is the rare case, so it's the one we mark.
const termCard = (t: TermMatch) => html`<div class="cw-term${t.source === "stock" ? " cw-term--stock" : ""}">
	<div class="cw-term-label">${t.label}</div>
	<div class="cw-term-desc">${t.description}</div>
</div>`;
const tripleCard = (t: Triple) => html`<div class="cw-triple${t.source === "stock" ? " cw-triple--stock" : ""}">
	<span class="cw-tri-s">${t.subject}</span>
	<span class="cw-tri-p">--${t.predicate}--&gt;</span>
	<span class="cw-tri-o">${t.object}</span>
	${(t.clauses ?? []).map((c) => html`<div class="cw-clause">[${c.type.toUpperCase()}: ${c.text}]</div>`)}
</div>`;

const renderGutters = () => {
	if (!leftGutter || !rightGutter) return;
	const terms = lastVacuum?.terms ?? [];
	const triples = lastVacuum?.triples ?? [];

	const userTerms = terms.filter((t) => t.source !== "stock");
	const stockTerms = terms.filter((t) => t.source === "stock");
	const userTriples = triples.filter((t) => t.source !== "stock");
	const stockTriples = triples.filter((t) => t.source === "stock");

	render(
		html`
			<div class="cw-gutter-title">Nodes</div>
			<div class="cw-gutter-inner">
				${
					terms.length
						? html`
								${userTerms.map(termCard)}
								${stockTerms.length ? html`<div class="cw-gutter-sub">from Cymbiont</div>` : null}
								${stockTerms.map(termCard)}
							`
						: html`<div class="cw-gutter-empty">no matches</div>`
				}
			</div>
		`,
		leftGutter,
	);
	render(
		html`
			<div class="cw-gutter-title">Relationships</div>
			<div class="cw-gutter-inner">
				${
					triples.length
						? html`
								${userTriples.map(tripleCard)}
								${stockTriples.length ? html`<div class="cw-gutter-sub">from Cymbiont</div>` : null}
								${stockTriples.map(tripleCard)}
							`
						: html`<div class="cw-gutter-empty">no triples</div>`
				}
			</div>
		`,
		rightGutter,
	);
};

// Dynamic truncation: keep EVERY term visible, but progressively clamp the
// descriptions (uniformly) until the column fits without scrolling. Few terms →
// full descriptions; many terms → each shrinks toward its first line. Measured
// against the live gutter height so it adapts to viewport + term count.
const fitTermDescriptions = () => {
	if (!leftGutter || leftGutter.clientHeight === 0) return;
	const inner = leftGutter.querySelector<HTMLElement>(".cw-gutter-inner");
	const descs = [...leftGutter.querySelectorAll<HTMLElement>(".cw-term-desc")];
	if (!inner || !descs.length) return;
	const apply = (n: number) => {
		for (const d of descs) d.style.webkitLineClamp = String(n);
	};
	let clamp = 8; // generous start: a full ~60-word desc is ~8 lines at this width
	apply(clamp);
	// Reading scrollHeight forces a reflow; bounded to ≤7 iterations, once/turn.
	while (clamp > 1 && inner.scrollHeight > leftGutter.clientHeight) {
		clamp -= 1;
		apply(clamp);
	}
};

const updateGutters = (vacuum: { terms: TermMatch[]; triples: Triple[] }) => {
	lastVacuum = vacuum;
	renderGutters();
	// Fit term descriptions to the column height after layout settles.
	requestAnimationFrame(fitTermDescriptions);
};

// Re-fit on viewport resize (descriptions stay in the DOM; just re-clamp).
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(fitTermDescriptions, 150);
});

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: `You are a helpful AI assistant with access to a JavaScript REPL: execute JavaScript code in a sandboxed browser environment (calculations, data processing, etc.). Use it when it helps you give an accurate, correct answer.`,
			model: CYMBIONT_MODEL,
			thinkingLevel: CYMBIONT_THINKING_LEVEL,
			messages: [],
			tools: [],
		},
		// Custom transformer: convert custom messages to LLM-compatible format
		convertToLlm: customConvertToLlm,
	});

	// Fresh per-conversation dedup ledger.
	ledger = new InjectedLedger();

	// DESIGN 2 INJECTION. Wrap the send path so that, BEFORE the run's context
	// snapshot is taken, we: (1) run browser-local retrieval, (2) update the
	// gutters with the full vacuum set, (3) append a persistent hidden kg-context
	// breadcrumb of the deduped injection block to agent.state.messages. The
	// breadcrumb accumulates across turns (like CC's additionalContext), so
	// ledger dedup is correct rather than lossy. transformContext is NOT used —
	// its output is ephemeral and would drop earlier turns' context.
	const origPrompt = agent.prompt.bind(agent);
	(agent as unknown as { prompt: (...a: unknown[]) => Promise<void> }).prompt = async (
		input: unknown,
		...rest: unknown[]
	) => {
		try {
			const userText = extractUserText(input as AgentMessage | AgentMessage[] | string);
			pendingTurnUserText = userText; // stash for the agent_end ingestion trigger
			if (userText.trim()) {
				const agentText = lastAssistantText(agent.state.messages);
				// Personal graph retrieves FIRST (privileged) so its facts win the
				// shared-ledger cross-turn dedup; stock retrieves against the same ledger.
				const userR = retrieve(userGraph, ledger, userText, agentText);
				const stockR = kgGraph ? retrieve(kgGraph, ledger, userText, agentText) : null;
				const vacuum = {
					terms: [
						...userR.vacuum.terms.map((t) => ({ ...t, source: "user" as const })),
						...(stockR?.vacuum.terms ?? []).map((t) => ({ ...t, source: "stock" as const })),
					],
					triples: [
						...userR.vacuum.triples.map((t) => ({ ...t, source: "user" as const })),
						...(stockR?.vacuum.triples ?? []).map((t) => ({ ...t, source: "stock" as const })),
					],
				};
				updateGutters(vacuum);
				const blocks = [userR.injectionBlock, stockR?.injectionBlock].filter(
					(b): b is string => !!b,
				);
				if (blocks.length) {
					agent.state.messages = [...agent.state.messages, createKgContextMessage(blocks.join("\n\n"))];
				}
				dbg(
					`kg retrieve: user[${userR.vacuum.terms.length}t/${userR.vacuum.triples.length}r] ` +
						`stock[${stockR?.vacuum.terms.length ?? 0}t/${stockR?.vacuum.triples.length ?? 0}r] ` +
						`injected=${blocks.length ? "yes" : "no (deduped)"}`,
				);
			}
		} catch (err) {
			dbgError("kg retrieval failed (send proceeds without injection):", err);
		}
		return origPrompt(input as AgentMessage | AgentMessage[], ...(rest as []));
	};

	agentUnsubscribe = agent.subscribe((event: any) => {
		// pi-agent-core 0.75.3 emits raw lifecycle events (message_start,
		// message_update, message_end, turn_end, agent_end, tool_execution_*) —
		// NOT a synthetic "state-update" with an attached `event.state`. The
		// shipped example listened for "state-update", so its bookkeeping never
		// ran and nothing was persisted. We read state straight off the agent.
		//
		// CRITICAL: the core AWAITS each listener, so a throw here (or heavy work
		// on every streamed token) stalls the run and can wipe the in-flight
		// message. So: wrap everything in try/catch, and only re-render / persist
		// on meaningful events — NOT on every message_update token. ChatPanel
		// renders the streaming message itself; our renderApp is just for the
		// header shell.
		try {
			const type = event?.type;
			const isTerminal = type === "message_end" || type === "agent_end";
			const messages = agent.state.messages;

			// STALL TIMING — correlate the agent lifecycle against the wire tap.
			// We DON'T log every message_update (per-token fetch would itself stall
			// the run), but we track the last-update timestamp + count locally and
			// report the gap on terminal events. A large "last update → end" gap
			// here, combined with the [stream] wire log, localizes the ~13s stall:
			// if the wire shows the same gap it's the provider; if the wire closed
			// fast but this gap is large it's pi-ai/agent-core post-processing.
			const tNow = Math.round(performance.now());
			if (type === "message_start") {
				lastUpdateAt = tNow;
				updateCount = 0;
			} else if (type === "message_update") {
				lastUpdateAt = tNow;
				updateCount++;
			}

			// Light logging — skip the per-token message_update spam.
			if (type !== "message_update") {
				const gapNote =
					lastUpdateAt > 0 ? ` [t=${tNow}ms, ${updateCount} updates, +${tNow - lastUpdateAt}ms since last update]` : "";
				dbg(`event ${type}: ${summarizeMessages(messages)}${gapNote}`);
			}

			let headerChanged = false;

			// Generate title after the first user+assistant exchange.
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
				headerChanged = true;
			}

			// Mint the session id as soon as there's something worth saving, so
			// the URL carries ?session= and the conversation survives a reload.
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				dbg(`session id minted: ${currentSessionId}`);
				updateUrl(currentSessionId);
			}

			// Persist on terminal events (not once per streamed token).
			if (currentSessionId && isTerminal) {
				saveSession();
			}

			// Repaint the committed message list when a message lands — see
			// forceChatRepaint (works around <message-list>'s identity-only
			// reactivity vs agent-core's in-place array mutation).
			if (isTerminal) {
				forceChatRepaint();
			}
			// finishRun() flips isStreaming=false AFTER agent_end with no event, so
			// repaint once more on the next tick to restore the send button.
			if (type === "agent_end") {
				setTimeout(forceChatRepaint, 100);
				// Fire-and-forget: ingest the just-completed turn into the personal
				// graph. Newly-minted nodes surface on the next turn's retrieval.
				const turnUserText = pendingTurnUserText;
				pendingTurnUserText = "";
				void triggerIngestion(turnUserText, agent.state.messages).catch((err) =>
					dbgError("ingestion failed (non-fatal):", err),
				);
			}

			// Re-render ONLY the header (its own DOM node) and ONLY when its
			// contents change — e.g. the title appears after the first exchange.
			// The chat panel is mounted once and is NEVER touched by the host.
			if (headerChanged) {
				renderHeader();
			}
		} catch (err) {
			dbgError("agent listener threw (suppressed so the run survives):", err);
		}
	});

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			// Create javascript_repl tool with access to attachments + artifacts
			const replTool = createJavaScriptReplTool();
			replTool.runtimeProvidersFactory = runtimeProvidersFactory;
			return [replTool];
		},
	});

	// The model and reasoning level are hardcoded (DeepSeek V4 via OpenRouter,
	// reasoning: high). Hide both the model picker and the thinking-level
	// selector — this is a single-model demo, not a configurable Pi client.
	if (chatPanel.agentInterface) {
		chatPanel.agentInterface.enableModelSelector = false;
		chatPanel.agentInterface.enableThinkingSelector = false;
	}
};

const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!storage.sessions) return false;

	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		dbgWarn(`loadSession: session not found in storage: ${sessionId}`);
		return false;
	}
	dbg(`loadSession OK: ${sessionId} — ${summarizeMessages(sessionData.messages ?? [])}`);

	currentSessionId = sessionId;
	currentView = "chat";
	const metadata = await storage.sessions.getMetadata(sessionId);
	currentTitle = metadata?.title || "";

	await createAgent({
		// Always use the hardcoded model/reasoning, ignoring whatever a stored
		// session was saved with — the model is not user-selectable.
		model: CYMBIONT_MODEL,
		thinkingLevel: CYMBIONT_THINKING_LEVEL,
		messages: sessionData.messages,
		tools: [],
	});

	updateUrl(sessionId);
	updateBodyVisibility();
	renderHeader();
	return true;
};

const newSession = async () => {
	dbg("newSession() — resetting to a fresh chat (no page reload)");
	currentSessionId = undefined;
	currentTitle = "";
	isEditingTitle = false;
	currentView = "chat";
	// Clear ?session= without reloading the page (Brandt: buttons shouldn't
	// refresh the page; a reload mid-stream is also how conversations vanished).
	const url = new URL(window.location.href);
	url.search = "";
	window.history.replaceState({}, "", url);
	await createAgent();
	updateBodyVisibility();
	renderHeader();
};

const setView = (view: "chat" | "about") => {
	// No-op (and no reset) if already on this view — clicking the brand while on
	// the chat page must NOT wipe the chat.
	if (currentView === view) return;
	currentView = view;
	updateBodyVisibility();
	renderHeader();
};

const renderAbout = () => html`
	<div class="flex-1 overflow-y-auto">
		<div class="max-w-2xl mx-auto px-6 py-10 flex flex-col gap-4">
			<h1 class="text-2xl font-semibold text-primary">About Cymbiont</h1>
			<p class="text-sm text-muted-foreground">Placeholder — a fuller write-up is coming.</p>
			<p class="text-sm leading-relaxed">
				Cymbiont is a self-maintaining knowledge-graph memory harness for LLM agents. This site is
				a lightweight, hosted demo of it. The full harness (Linux + Hyprland) lives on GitHub:
			</p>
			<a
				class="text-primary underline break-all text-sm"
				href="https://github.com/Brandtweary/cymbiont"
				target="_blank"
				rel="noreferrer"
			>
				https://github.com/Brandtweary/cymbiont
			</a>
		</div>
	</div>
`;

// ============================================================================
// RENDER
// ============================================================================
const renderHeader = () => {
	if (!headerHost) return;
	dbg(`renderHeader view=${currentView}`);

	const headerHtml = html`
			<!-- Header -->
			<div class="cw-header flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-1 px-4 py-2">
					<button
						class="text-base font-semibold text-primary px-1 mr-1 hover:opacity-80 transition-opacity"
						@click=${() => setView("chat")}
					>
						Cymbiont
					</button>
					${Button({
						variant: "ghost",
						size: "sm",
						children: "About",
						onClick: () => setView("about"),
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SessionListDialog.open(
								async (sessionId) => {
									await loadSession(sessionId);
								},
								(deletedSessionId) => {
									// Only reload if the current session was deleted
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Chats",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Chat",
					})}

					${
						currentView === "chat" && currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-64",
										onChange: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderHeader();
										},
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderHeader();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderHeader();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-sm text-foreground hover:bg-secondary rounded transition-colors"
									@click=${() => {
										isEditingTitle = true;
										renderHeader();
										requestAnimationFrame(() => {
											const input = headerHost?.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: ""
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () =>
						SettingsDialog.open([
							new OpenRouterKeyTab(),
							new MemoryTab({ onExport: downloadPersonalGraph, onImport: importPersonalGraphFromFile }),
						]),
						title: "Settings",
					})}
				</div>
			</div>
	`;

	// Render ONLY the header into its own host. The chat panel and about page are
	// separate, statically-mounted DOM siblings (see initApp) that the host never
	// re-renders.
	render(headerHtml, headerHost);
};

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	installInstrumentation();

	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Build the STATIC scaffold once. #app is the column; the chat panel and the
	// about page are mounted directly as siblings of the header host and are NEVER
	// re-rendered by the host. This is the README's pattern (appendChild the panel
	// once) — the broken example app instead re-rendered the panel inside a lit
	// template, which is what wiped streaming messages.
	app.className = "w-full h-screen flex flex-col bg-background text-foreground overflow-hidden";
	app.replaceChildren();

	headerHost = document.createElement("div");
	headerHost.className = "shrink-0";

	chatPanel = new ChatPanel(); // mounted once, owns its own rendering/scrolling
	chatPanel.classList.add("cw-chat");

	// Retrieval gutters flank the centered chat column (term matches left, triples
	// right) — always present (dedicated space, empty until the first match), only
	// dropped on true mobile via the .cw-gutter media query.
	leftGutter = document.createElement("div");
	leftGutter.className = "cw-gutter cw-gutter-left";
	rightGutter = document.createElement("div");
	rightGutter.className = "cw-gutter cw-gutter-right";

	bodyHost = document.createElement("div");
	bodyHost.className = "cw-body";
	bodyHost.append(leftGutter, chatPanel, rightGutter);

	aboutHost = document.createElement("div");
	aboutHost.className = "flex-1 min-h-0 overflow-y-auto";
	render(renderAbout(), aboutHost);

	app.append(headerHost, bodyHost, aboutHost);
	renderGutters(); // initial empty state

	await loadStockGraph();
	await loadUserGraph();

	// PersistentStorageDialog is broken upstream — export/import (Memory settings
	// tab) is the durability story instead.

	const urlParams = new URLSearchParams(window.location.search);
	const sessionIdFromUrl = urlParams.get("session");

	if (sessionIdFromUrl) {
		const loaded = await loadSession(sessionIdFromUrl);
		if (!loaded) {
			// Session doesn't exist — start a fresh chat in place (no reload).
			await newSession();
			return;
		}
	} else {
		await createAgent();
	}

	updateBodyVisibility();
	renderHeader();
}

initApp();
