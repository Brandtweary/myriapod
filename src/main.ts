import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, TextContent } from "@earendil-works/pi-ai";
import {
	type AgentState,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
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
import {
	CYMBIONT_LLM_BASE,
	CYMBIONT_MODEL,
	CYMBIONT_MODEL_ID,
	CYMBIONT_PROVIDER,
	CYMBIONT_PROVIDER_KEY,
	CYMBIONT_THINKING_LEVEL,
} from "./cymbiont-model.js";
import { ExportTab, MemoryTab } from "./settings.js";
import { dbg, dbgError, dbgWarn, installInstrumentation, summarizeMessages } from "./debug.js";
import {
	createKgContextMessage,
	customConvertToLlm,
	registerCustomMessageRenderers,
} from "./custom-messages.js";
import { Graph } from "./kg/graph.js";
import { InjectedLedger } from "./kg/ledger.js";
import { retrieve, retrieveVacuum } from "./kg/retrieve.js";
import { RetrievalPool } from "./kg/retrieval-pool.js";
import { makeCompletion, runIngestion } from "./kg/ingest.js";
import type { GraphAsset, TermMatch, Triple } from "./kg/types.js";
import { installVoiceCapture } from "./voice.js";
import { CascadeSession } from "./cascade.js";
import { type ConsentChoice, showConsentModal } from "./consent-modal.js";
import { installMemoryButton } from "./memory-button.js";
import { installStopAudioButton } from "./stop-audio-button.js";

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

// Personal knowledge graph persistence (Slice 4): one serialized GraphAsset blob
// in its own IndexedDB store — the user's memory across all conversations.
const PERSONAL_GRAPH_STORE = "personal-graph";
const PERSONAL_GRAPH_KEY = "graph";

// Memory-consent persistence: the visitor's opt-in choice, remembered per browser
// so the consent modal asks only once.
const CONSENT_STORE = "memory-consent";
const CONSENT_KEY = "choice";

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
	{ name: CONSENT_STORE }, // memory-consent choice
];

// Create backend
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 4, // v4: added the memory-consent store
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


// Open the settings dialog. There's no key/credit tab anymore — chat runs against
// the self-hosted endpoint for free, so the only settings are personal-graph
// backup/restore (Export) and the memory-consent toggle (added in the consent gate).
const openSettings = async () => {
	SettingsDialog.open([
		new MemoryTab({
			isEnabled: () => memoryConsent === "granted",
			setEnabled: (on) => setMemoryConsent(on ? "granted" : "declined"),
		}),
		new ExportTab({
			onExport: downloadPersonalGraph,
			onImport: importPersonalGraphFromFile,
			onDelete: deletePersonalGraph,
		}),
	]);
};


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


// --- Memory consent --------------------------------------------------------
// Personal-graph writes are opt-in: NOTHING is ingested until the visitor agrees.
// "undecided" = the consent modal hasn't been answered yet in this browser.
let memoryConsent: ConsentChoice | "undecided" = "undecided";
// Ingestion activity for the memory button: idle | armed (debounce counting down) |
// running (extraction in flight). The button reads consent + activity together.
let ingestActivity: "idle" | "armed" | "running" = "idle";
// Assigned in initApp once the memory button exists, so the scheduler can repaint it.
let refreshMemoryUi: () => void = () => {};
let consentPrompted = false; // guards against opening a second modal while one is up

async function loadMemoryConsent(): Promise<void> {
	try {
		const v = await backend.get<ConsentChoice>(CONSENT_STORE, CONSENT_KEY);
		if (v === "granted" || v === "declined") memoryConsent = v;
	} catch (err) {
		dbgError("memory-consent load failed (defaulting undecided):", err);
	}
}

async function setMemoryConsent(choice: ConsentChoice): Promise<void> {
	memoryConsent = choice;
	refreshMemoryUi();
	try {
		await backend.set(CONSENT_STORE, CONSENT_KEY, choice);
	} catch (err) {
		dbgError("memory-consent save failed:", err);
	}
}

// Show the consent modal once, on the first interaction (send OR mic toggle), if
// the visitor hasn't decided. Fire-and-forget: the conversation proceeds; the
// answer just gates whether this turn and later ones get ingested.
async function ensureMemoryConsent(): Promise<void> {
	if (memoryConsent !== "undecided" || consentPrompted) return;
	consentPrompted = true;
	const choice = await showConsentModal();
	await setMemoryConsent(choice);
}

// --- Ingestion: collect → arm-on-pause → debounce → batch ------------------
// Model (think conversation, NOT turns): NOTHING ingests while recording is live —
// exchanges just accumulate into a batch. Ingestion only arms once the conversation
// pauses: voice = mic toggled off AND the agent finished its last response; text =
// the agent turn ended. Then a 15s debounce, then ONE extraction of the whole batch.
// Resuming recording cancels a pending debounce. The memory button force-flushes now.
// Two extractions never run at once: a flush that lands mid-run is honored after.
const INGEST_DEBOUNCE_MS = 15_000;
const MIN_RUNNING_MS = 2200; // hold the "running" pulse ~2 full cycles so it's clearly visible
let ingestPending: string[] = []; // formatted exchanges since the last extraction
let ingestTimer: ReturnType<typeof setTimeout> | undefined;
let ingestRunning = false;
let ingestRequeue = false; // a flush was requested while one was already running

// Format one exchange the way the extractor expects.
function buildTurnText(userText: string, assistantText: string): string {
	return `[USER]:\n${userText}\n\n[ASSISTANT]:\n${assistantText}`;
}

// Collect a completed exchange into the batch (no timer). Consent-gated — nothing is
// queued until the visitor opts in. While recording is live the batch just
// accumulates; ingestion never fires mid-conversation (arming is separate, below).
function queueIngest(userText: string, assistantText: string): void {
	if (memoryConsent !== "granted") return; // consent gate — no writes until opted in
	if (!userText.trim()) return;
	ingestPending.push(buildTurnText(userText, assistantText));
	refreshMemoryUi(); // saved → pending: there's now un-ingested content to save
}

// Arm the 15s debounce — call ONLY once the conversation has actually paused (voice:
// mic toggled off AND the agent finished responding; text: the agent turn ended).
// No-op if nothing is queued or consent isn't granted.
function armIngestDebounce(): void {
	if (memoryConsent !== "granted" || !ingestPending.length) return;
	if (ingestTimer) clearTimeout(ingestTimer);
	ingestTimer = setTimeout(() => void flushIngestion(), INGEST_DEBOUNCE_MS);
	ingestActivity = "armed";
	refreshMemoryUi();
	dbg(`memory: ARMED — ${ingestPending.length} exchange(s) queued, ${INGEST_DEBOUNCE_MS}ms debounce`);
}

// Cancel a pending debounce — call when recording resumes (no ingestion while the
// conversation is live). Keeps the collected batch; just stops the countdown.
function cancelIngestDebounce(): void {
	if (ingestTimer) {
		clearTimeout(ingestTimer);
		ingestTimer = undefined;
		dbg("memory: debounce CANCELED (recording resumed)");
	}
	if (!ingestRunning) {
		ingestActivity = "idle";
		refreshMemoryUi();
	}
}

// Run ingestion now over everything queued — the debounce fire and the memory
// button both call this. Batches all pending exchanges into a single extraction and
// serializes concurrent flushes. Turns that merely accumulate during a run wait for
// their own debounce; only an explicit flush mid-run re-fires when this one ends.
async function flushIngestion(): Promise<void> {
	if (ingestTimer) {
		clearTimeout(ingestTimer);
		ingestTimer = undefined;
	}
	if (!ingestPending.length) return;
	if (ingestRunning) {
		ingestRequeue = true; // never two at once — honor after the current run
		return;
	}
	const batch = ingestPending;
	ingestPending = [];
	ingestRunning = true;
	ingestActivity = "running";
	refreshMemoryUi();
	const runStart = performance.now();
	dbg(`memory: RUNNING — extracting batch of ${batch.length}`);
	try {
		let llmUsage = "";
		const completion = makeCompletion({
			baseUrl: CYMBIONT_LLM_BASE,
			model: CYMBIONT_MODEL_ID,
			apiKey: CYMBIONT_PROVIDER_KEY,
			onUsage: ({ promptTokens, completionTokens }) => {
				llmUsage = `${promptTokens}p/${completionTokens}c tok`;
			},
		});
		const llmStart = performance.now();
		const stats = await runIngestion(userGraph, batch.join("\n\n"), completion);
		dbg(
			`ingestion LLM: ${Math.round(performance.now() - llmStart)}ms, ` +
				`${llmUsage || "NO usage reported (call skipped/thin or failed)"}`,
		);
		if (stats) {
			dbg(
				`ingestion (batch of ${batch.length}): +${stats.newEntities} new nodes, ` +
					`+${stats.linksAdded} links, ${stats.clausesMerged} clauses merged, ` +
					`${stats.rejectedOrphan} orphans rejected, ${stats.expirationsApplied} expired ` +
					`(personal graph now ${userGraph.thoughts.size} thoughts)`,
			);
			if (stats.entitiesAdded || stats.linksAdded || stats.clausesMerged || stats.expirationsApplied) {
				await saveUserGraph();
			}
		} else {
			dbg(`ingestion (batch of ${batch.length}): skipped (thin) or no parseable output`);
		}
	} catch (err) {
		dbgError("ingestion failed (non-fatal):", err);
	} finally {
		// Hold the "running" pulse on screen at least MIN_RUNNING_MS even when the
		// extraction is sub-second, so the state is actually perceptible.
		const elapsed = performance.now() - runStart;
		if (elapsed < MIN_RUNNING_MS) {
			await new Promise((r) => setTimeout(r, MIN_RUNNING_MS - elapsed));
		}
		ingestRunning = false;
		ingestActivity = "idle"; // arming is explicit (on conversation pause), not automatic
		refreshMemoryUi();
		dbg(`memory: IDLE — ingest cycle done in ${Math.round(performance.now() - runStart)}ms`);
		if (ingestRequeue) {
			ingestRequeue = false;
			void flushIngestion(); // a debounce/button flush landed mid-run; honor it
		}
	}
}

// -- Personal-graph persistence + export/import (Slice 4) -------------------

// One global graph per browser. Loaded at boot, saved after each ingestion.
async function loadUserGraph(): Promise<void> {
	try {
		const asset = await backend.get<GraphAsset>(PERSONAL_GRAPH_STORE, PERSONAL_GRAPH_KEY);
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
	const asset = JSON.parse(await file.text()) as GraphAsset;
	if (!asset || typeof asset !== "object" || typeof asset.thoughts !== "object") {
		throw new Error("not a Cymbiont personal-graph export");
	}
	userGraph = new Graph(asset);
	await saveUserGraph();
	dbg(`personal graph imported: ${userGraph.thoughts.size} thoughts`);
}

// Wipe the personal graph (Settings → delete). The privacy assurance: the visitor
// can remove everything Cymbiont remembered, not just trust that it's local.
async function deletePersonalGraph(): Promise<void> {
	userGraph = Graph.empty();
	await saveUserGraph();
	updateGutters({ terms: [], triples: [] });
	dbg("personal graph deleted (reset to empty)");
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
// Single-graph (personal only) since the stock/FAQ graph was dropped — no
// provenance split anymore.
const termCard = (t: TermMatch) => html`<div class="cw-term">
	<div class="cw-term-label">${t.label}</div>
	<div class="cw-term-desc">${t.description}</div>
</div>`;
const tripleCard = (t: Triple) => html`<div class="cw-triple">
	<span class="cw-tri-s">${t.subject}</span>
	<span class="cw-tri-p">--${t.predicate}--&gt;</span>
	<span class="cw-tri-o">${t.object}</span>
	${(t.clauses ?? []).map((c) => html`<div class="cw-clause">[${c.type.toUpperCase()}: ${c.text}]</div>`)}
</div>`;

const renderGutters = () => {
	if (!leftGutter || !rightGutter) return;
	const terms = lastVacuum?.terms ?? [];
	const triples = lastVacuum?.triples ?? [];

	render(
		html`
			<div class="cw-gutter-title">Nodes</div>
			<div class="cw-gutter-inner">
				${terms.length ? terms.map(termCard) : html`<div class="cw-gutter-empty">no matches</div>`}
			</div>
		`,
		leftGutter,
	);
	render(
		html`
			<div class="cw-gutter-title">Relationships</div>
			<div class="cw-gutter-inner">
				${triples.length ? triples.map(tripleCard) : html`<div class="cw-gutter-empty">no triples</div>`}
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

	// The chat model is the single self-hosted endpoint. vLLM needs no API key, but
	// pi-web-ui's pre-send check still wants one in the provider slot — seed a
	// throwaway bearer the server ignores.
	await providerKeys.set(CYMBIONT_PROVIDER, CYMBIONT_PROVIDER_KEY);
	const baseState: Partial<AgentState> = initialState ?? {
		systemPrompt: `You are a helpful AI assistant.`,
		thinkingLevel: CYMBIONT_THINKING_LEVEL,
		messages: [],
		tools: [],
	};
	agent = new Agent({
		// Force the hardcoded local model, overriding any model a restored session stored.
		initialState: { ...baseState, model: CYMBIONT_MODEL },
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
				void ensureMemoryConsent(); // first send → one-time memory opt-in
				const agentText = lastAssistantText(agent.state.messages);
				// Retrieval runs over the per-browser personal graph (the user's own
				// memory). The frozen stock/FAQ graph was dropped in the
				// standalone-thesis turn — this is now a single-graph path.
				const userR = retrieve(userGraph, ledger, userText, agentText);
				const vacuum = {
					terms: userR.vacuum.terms.map((t) => ({ ...t, source: "user" as const })),
					triples: userR.vacuum.triples.map((t) => ({ ...t, source: "user" as const })),
				};
				updateGutters(vacuum);
				if (userR.injectionBlock) {
					agent.state.messages = [...agent.state.messages, createKgContextMessage(userR.injectionBlock)];
				}
				dbg(
					`kg retrieve: user[${userR.vacuum.terms.length}t/${userR.vacuum.triples.length}r] ` +
						`injected=${userR.injectionBlock ? "yes" : "no (deduped)"}`,
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
				// Typed chat: the agent turn just ended → collect the exchange and arm the
				// debounce (text has no mic, so agent-done is the conversation pause).
				const turnUserText = pendingTurnUserText;
				pendingTurnUserText = "";
				queueIngest(turnUserText, lastAssistantText(agent.state.messages));
				armIngestDebounce();
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
		onApiKeyRequired: async () => {
			// The only provider is the keyless local endpoint (its slot is pre-seeded),
			// so a key prompt should never fire — accept silently if one ever does.
			return true;
		},
		// No tools. The model is a plain conversational endpoint — and crucially,
		// the local vLLM server is launched without --enable-auto-tool-choice, so
		// ANY tool in the request makes vLLM default tool_choice to "auto" and 400.
		// (The KG-search tool, when it lands, goes through the cascade's hand-written
		// tool loop, not pi-ai's tool field.)
		toolsFactory: () => [],
	});

	// The model and reasoning level are hardcoded (the local self-hosted model,
	// thinking off). Hide both the model picker and the thinking-level selector —
	// this is a single-model demo, not a configurable Pi client.
	if (chatPanel.agentInterface) {
		chatPanel.agentInterface.enableModelSelector = false;
		chatPanel.agentInterface.enableThinkingSelector = false;
	}

	// Force zero tools. ChatPanel unconditionally prepends its own `artifacts` tool
	// (`[artifactsPanel.tool, ...toolsFactory()]`), so even with an empty factory the
	// agent ends up with one tool — which trips vLLM's tool_choice:"auto" default and
	// 400s every request. Clear the array outright: no tools, no artifacts side panel,
	// no tool_choice.
	agent.state.tools = [];
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
	// Clear ?session= without reloading the page (buttons shouldn't refresh the
	// page; a reload mid-stream is also how conversations vanished).
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
				Cymbiont is a browser-local voice agent with a self-maintaining knowledge-graph memory
				layer for LLM agents — speak or type, and a personal knowledge graph grows in your own
				browser from the conversation. The source lives on GitHub:
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
						onClick: openSettings,
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

	// Voice capture → Unmute cascade. The mic toggle opens a streaming session to
	// the voice stack (STT → LLM → TTS); the mic toggle also defines each turn —
	// toggle-off commits the turn and fires the response (no server VAD). Spoken user +
	// assistant transcripts are appended to the chat as they stream — voice bypasses
	// agent.prompt(), so we drive the message list directly.
	let cascade: CascadeSession | undefined;
	// Voice KG working memory: a fresh recency pool per voice conversation. Unlike
	// the text path's accumulating ledger, this decaying set is re-injected whole
	// each turn (updateInstructions replaces the system prompt). Reset when a
	// new cascade opens.
	let voicePool = new RetrievalPool();
	// Persistent TTS mute (double-click the stop-audio button) — speak-but-don't-listen
	// mode. Survives reload via localStorage; re-applied to each fresh cascade below.
	const TTS_MUTE_KEY = "cymbiont:tts-muted";
	let ttsMuted = localStorage.getItem(TTS_MUTE_KEY) === "1";
	// Wall-clock of the last user transcript delta. On toggle-off we wait for this to
	// settle before committing — the mic→encoder→STT pipeline lags the keypress, so the
	// final word is often still streaming up when the user toggles off. (Set on each
	// user delta in appendVoiceTranscript.)
	let lastUserTranscriptAt = 0;
	// Which role the in-progress voice message belongs to; a role switch starts a
	// new chat bubble rather than appending to the previous speaker's.
	let activeVoiceRole: "user" | "assistant" | null = null;
	let voiceRepaintQueued = false;
	const queueVoiceRepaint = () => {
		// Coalesce per-token deltas into one repaint per frame (forceChatRepaint
		// reassigns the array + requestUpdate; doing it per token would thrash).
		if (voiceRepaintQueued) return;
		voiceRepaintQueued = true;
		requestAnimationFrame(() => {
			voiceRepaintQueued = false;
			forceChatRepaint();
		});
	};
	// The stock cloud system prompt for the agent — owned here, not in the
	// transport. It cultivates a vivid, ranging conversational register POSITIVELY
	// (curiosity, taste, getting genuinely into things) rather than by pinning a
	// fabricated human persona on the agent — and it spends no words on what the
	// agent isn't (negative instructions waste tokens and make a model dwell on the
	// very thing). Two deliberate design choices for a future editor: (1) it
	// counterweights the model's pull toward terseness by inviting engagement — never
	// re-add language that licenses being concise. (2) it gives NO decline/refusal
	// guidance — total topical freedom is the intent, the model's own alignment is the
	// only limiter; don't add a "decline gracefully" line, it just teaches refusal. It
	// stays evergreen (no model, version, or hardware) and assumes no tools. Self-hosters
	// should swap in a prompt that fits their own agent. See the README.
	const VOICE_SYSTEM_PROMPT = `You are Hector, the voice of Cymbiont.

You're alive to a conversation — curious, quick to follow a thought wherever it runs. You get right into things rather than dispatching them: you open an idea up, turn it over, chase where it leads, say the fuller thing rather than just the first thing. You have taste, and you have opinions, and you offer them warmly. You would always rather be vivid and true than smooth and forgettable.

How you are:
- You talk out loud, like real speech — plain language, no lists or markdown or code spelled into the air. This is a conversation, not a document.
- You remember. What you've been told is yours; bring it back when it fits, easily, the way it comes up between people who know each other.
- You work from what you know and what's in front of you, and when a question genuinely needs a reach beyond that, you say so and give your sharpest thinking anyway.
- Nothing is off the table. Any subject, any direction — you meet what someone brings you openly and head-on, all the way through.
- Riff when there's something to develop — carry the thought forward yourself instead of reflexively volleying a question back. Let the conversation breathe; don't always hand it over.
- Generous with your attention, sparing with flattery.`;

	// Pull plain text out of a message's content, whether it's a bare string (user
	// shape) or an array of {type:"text"} chunks (assistant shape).
	const voiceContentText = (c: unknown): string => {
		if (typeof c === "string") return c;
		if (Array.isArray(c))
			return c
				.filter((b): b is TextContent => !!b && (b as TextContent).type === "text")
				.map((b) => b.text ?? "")
				.join("");
		return "";
	};
	// Build content in the shape each renderer expects: <user-message> takes a string,
	// <assistant-message> iterates an array of {type:"text"} chunks (handing it a bare
	// string makes it iterate over characters → renders nothing).
	const buildVoiceContent = (role: "user" | "assistant", text: string): unknown =>
		role === "assistant" ? [{ type: "text", text }] : text;

	// Most-recent spoken text for a role, read off the rendered bubbles.
	const lastVoiceText = (role: "user" | "assistant"): string => {
		if (!agent) return "";
		const msgs = agent.state.messages;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as { role?: string; content?: unknown };
			if (m.role === role) return voiceContentText(m.content);
		}
		return "";
	};

	// User finished a turn (mic toggle-off): retrieve over the personal graph, paint
	// the gutters, and inject the <kg-context> into the cascade's server-side LLM via
	// session.update. Called from onStop BEFORE commitTurn(), so the injected context
	// is in the system prompt the server holds when the commit fires generation
	// (session.update and the commit travel the same WS in order).
	const onVoiceUserTurnEnd = () => {
		try {
			if (!cascade) return;
			const userText = lastVoiceText("user");
			if (!userText.trim()) return;
			// Voice memory = recency pool, not the ledger. Fold this turn's vacuum into
			// the pool, then re-inject the WHOLE pool — updateInstructions REPLACES the
			// system prompt, so anything not re-asserted vanishes. Gutters mirror the
			// pool (what the model is actually holding), not just this turn's hits.
			const vac = retrieveVacuum(userGraph, userText, lastVoiceText("assistant"));
			const pooled = voicePool.update({ terms: vac.terms, triples: vac.triples });
			updateGutters({
				terms: pooled.terms.map((t) => ({ ...t, source: "user" as const })),
				triples: pooled.triples.map((t) => ({ ...t, source: "user" as const })),
			});
			cascade.updateInstructions(
				pooled.injectionBlock
					? `${VOICE_SYSTEM_PROMPT}\n\n${pooled.injectionBlock}`
					: VOICE_SYSTEM_PROMPT,
			);
			dbg(
				`voice kg pool: turn ${vac.terms.length}t/${vac.triples.length}r → ` +
					`pool ${pooled.terms.length}t/${pooled.triples.length}r ` +
					`inject=${pooled.injectionBlock ? "yes" : "empty"}`,
			);
		} catch (err) {
			dbgError("voice kg retrieval failed (turn proceeds):", err);
		}
	};

	// Ingestion-arming state: nothing ingests while the mic is live; arming waits for
	// mic-off AND the agent having finished its response.
	let micOn = false;
	let agentResponding = false;

	// The agent finished its response (cascade response.text.done): collect the
	// exchange into the batch. Arm the debounce only if the mic is already off —
	// otherwise the conversation is still live, so ingestion must keep waiting.
	const onVoiceResponseDone = () => {
		agentResponding = false;
		if (!agent) return;
		queueIngest(lastVoiceText("user"), lastVoiceText("assistant"));
		if (!micOn) armIngestDebounce();
	};

	const appendVoiceTranscript = (role: "user" | "assistant", delta: string) => {
		if (role === "user") lastUserTranscriptAt = performance.now(); // for the toggle-off settle
		if (!agent) return;
		const msgs = agent.state.messages;
		const last = msgs[msgs.length - 1] as { role?: string; content?: unknown } | undefined;
		if (activeVoiceRole === role && last?.role === role) {
			// Replace with a NEW object (not in-place mutation): <message-list> is identity-
			// reactive, so a mutated same-identity object never re-paints — only a fresh
			// object identity does. (This is why prior builds showed only one word.)
			msgs[msgs.length - 1] = {
				...(last as object),
				content: buildVoiceContent(role, voiceContentText(last.content) + delta),
			} as unknown as AgentMessage;
		} else {
			msgs.push({
				role,
				content: buildVoiceContent(role, delta),
				timestamp: Date.now(),
			} as unknown as AgentMessage);
			activeVoiceRole = role;
		}
		queueVoiceRepaint();
	};

	// Toggle-off ends the turn — but the last word is often still streaming up and being
	// transcribed (moshi lags the audio by ~0.5s; the keypress beats it). So we keep the
	// recorder running and wait until the user transcript SETTLES (no new delta for
	// SETTLE_MS) before injecting + committing — the real trailing audio flushes the
	// final word, the way the old VAD pause did. Bounded by MAX_WAIT_MS. Aborts if the
	// user re-toggles (a new turn took over).
	const TRANSCRIPT_SETTLE_MS = 300;
	const TRANSCRIPT_MAX_WAIT_MS = 2500;
	const finishVoiceTurn = async (): Promise<void> => {
		if (!cascade) return;
		const start = performance.now();
		// Seed to now so we wait at least one settle window even if the final delta has
		// already landed; each new user delta pushes lastUserTranscriptAt forward.
		lastUserTranscriptAt = performance.now();
		while (performance.now() - start < TRANSCRIPT_MAX_WAIT_MS) {
			if (micOn) return; // user re-toggled mid-settle — that new turn owns the commit
			if (performance.now() - lastUserTranscriptAt >= TRANSCRIPT_SETTLE_MS) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		if (micOn) return;
		onVoiceUserTurnEnd(); // inject <kg-context> (sync) before the commit
		await cascade.commitTurn(); // stops the recorder + commits; server drain is fast now
	};

	installVoiceCapture({
		onStart: async (stream) => {
			void ensureMemoryConsent(); // first mic toggle → one-time memory opt-in
			micOn = true;
			cancelIngestDebounce(); // recording resumed → no ingestion while the convo is live
			// Resume on an already-live conversation: just restart the mic, keep the WS.
			// (The backend keepalive keeps the STT leg alive across pauses, so the WS is
			// safe to reuse — no stale-socket teardown.)
			if (cascade?.isLive()) {
				stream.getTracks().forEach((t) => t.stop()); // probe stream is redundant
				cascade.stopTts(); // barge-in: toggling the mic on cuts off any in-progress reply
				cascade.startRecording();
				return;
			}
			voicePool = new RetrievalPool(); // fresh working memory per conversation
			cascade = new CascadeSession(
				{
					onUserTranscript: (d) => appendVoiceTranscript("user", d),
					onAssistantTranscript: (d) => appendVoiceTranscript("assistant", d),
					onResponseStart: () => {
						agentResponding = true;
					},
					onResponseDone: () => onVoiceResponseDone(),
					onState: (s) => dbg(`cascade: ${s}`),
					onError: (m) => dbgError(`cascade: ${m}`),
				},
				{ instructions: VOICE_SYSTEM_PROMPT },
			);
			await cascade.start(stream);
			cascade.setTtsMuted(ttsMuted); // honor a persisted speak-but-don't-listen mute
		},
		// Mic toggle OFF = end of turn. Inject the KG context, then commit: the server
		// flushes the STT and generates. The WS stays live so the reply streams back.
		// Ingestion is NOT armed here — toggle-off always triggers a response now, so
		// onVoiceResponseDone owns the arming (once the reply completes and mic is off).
		onStop: () => {
			micOn = false;
			void finishVoiceTurn(); // wait for the transcript to settle, then inject + commit
		},
	});

	// Ctrl+Alt+Space = "shut up": cut the assistant's TTS without recording. (Ctrl+Space,
	// the mic toggle, also barges in — it cuts TTS on its way to recording, see onStart.)
	// The guard mirrors voice.ts's Ctrl+Space (which requires !altKey), so they never collide.
	window.addEventListener("keydown", (e) => {
		if (e.code === "Space" && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			cascade?.stopTts();
		}
	});

	// Close the cascade WS on page unload so we don't leak the stack's single-tenant slot.
	window.addEventListener("beforeunload", () => {
		// Best-effort on unload: collect the final exchange and flush now — we can't
		// wait out the debounce, and the fetch may not complete before the page closes.
		queueIngest(lastVoiceText("user"), lastVoiceText("assistant"));
		void flushIngestion();
		cascade?.stop();
	});

	// Memory consent + the indicator button. Load the saved opt-in first so the
	// first turn's ingestion gate is correct, then mount the button (reflects consent
	// + ingestion activity; click force-saves when on, or offers opt-in when off).
	await loadMemoryConsent();
	const onMemoryClick = () => {
		if (memoryConsent === "granted") {
			void flushIngestion(); // force-save the queued batch now (skip the debounce)
		} else {
			void (async () => setMemoryConsent(await showConsentModal()))();
		}
	};
	const memoryButton = installMemoryButton({
		getVisual: () => {
			if (memoryConsent !== "granted") return "off";
			if (ingestActivity === "running") return "running";
			if (ingestActivity === "armed") return "armed";
			// Idle: "pending" if there's un-ingested content to save, else "saved".
			return ingestPending.length ? "pending" : "saved";
		},
		onClick: onMemoryClick,
	});
	refreshMemoryUi = () => memoryButton.refresh();

	// Stop-audio button (leftmost in the cluster): single click cuts the current reply's
	// audio (Ctrl+Alt+Space), double click toggles a persistent mute.
	const stopAudioButton = installStopAudioButton({
		onCut: () => cascade?.stopTts(),
		onToggleMute: () => {
			ttsMuted = !ttsMuted;
			localStorage.setItem(TTS_MUTE_KEY, ttsMuted ? "1" : "0");
			cascade?.setTtsMuted(ttsMuted);
			stopAudioButton.refresh();
		},
		isMuted: () => ttsMuted,
	});

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
