import {
	Agent,
	type AgentMessage,
	createCompactionSummaryMessage,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	generateSummary,
	shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { Model, TextContent } from "@earendil-works/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
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
	MYRIAPOD_MODEL,
	MYRIAPOD_MODEL_ID,
	MYRIAPOD_PROXY_BASE,
	MYRIAPOD_PROXY_PROVIDER,
	MYRIAPOD_THINKING_LEVEL,
	proxyChatModel,
} from "./myriapod-model.js";
import { ExportTab, MemoryTab, OpenRouterKeyTab } from "./settings.js";
import { showGrantModal } from "./grant-modal.js";
import { load as loadBotd } from "@fingerprintjs/botd";
import { dbg, dbgError, dbgWarn, installInstrumentation, summarizeMessages } from "./debug.js";
import {
	createMemoryContextMessage,
	createVoicePendingMessage,
	customConvertToLlm,
	registerCustomMessageRenderers,
} from "./custom-messages.js";
import { createMemoryDumpTool, createMemorySearchTool, registerMemoryToolRenderers } from "./kg-tools.js";
import { createWebSearchTool, registerWebToolRenderer } from "./web-tools.js";
import { Graph } from "./kg/graph.js";
import { InjectedLedger } from "./kg/ledger.js";
import { retrieve } from "./kg/retrieve.js";
import { makeEmbedClient } from "./kg/embed.js";
import type { GraphAsset, TermMatch } from "./kg/types.js";
import { PIPELINE_STORE, PipelineRuntime, type RunningContextEntry } from "./pipeline.js";
import { applyAutoReplace, emptySttLexicon, type SttLexicon } from "./stt-lexicon.js";
import { installVoiceCapture } from "./voice.js";
import { PcmRecorder, WhisperClient } from "./stt.js";
import { KyutaiTtsSynthesizer, TTS_SAMPLE_RATE } from "./tts.js";
import { type ConsentChoice, showConsentModal } from "./consent-modal.js";
import { installMemoryButton } from "./memory-button.js";
import { installStopAudioButton } from "./stop-audio-button.js";

// Register custom message + tool renderers
registerCustomMessageRenderers();
registerMemoryToolRenderers();
registerWebToolRenderer();

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

// Lexicon persistence: one serialized term-store blob in its own IndexedDB
// store — the user's memory across all conversations. (The pipeline's own state
// — action buffers, running context, speech-adaptation data, review flags —
// lives in the PIPELINE_STORE, keyed slots.)
const LEXICON_STORE = "lexicon";
const LEXICON_TERMS_KEY = "terms";

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
	{ name: LEXICON_STORE }, // the term memory (serialized asset)
	{ name: PIPELINE_STORE }, // pipeline state: buffers, running context, STT data, flags
	{ name: CONSENT_STORE }, // memory-consent choice
];

// Create backend
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 5, // v5: term-based memory (lexicon + pipeline stores; the old
	// personal-graph store is abandoned — pre-launch clean wipe, no migration)
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

// --- Serving path: own-key (OpenRouter direct) vs owner-funded (metering proxy) ---
const OPENROUTER_DIRECT_BASE = "https://openrouter.ai/api/v1";
// providerKeys slot holding a redeemed family token (set by settings redemption).
const FAMILY_TOKEN_SLOT = "myriapod-family";
// providerKeys slot holding the anonymous free-tier continuity token (minted at
// /anon-init). Its presence is also the "welcome already shown" signal — the modal
// reappears only if the token is gone (cleared storage → a re-mint needs re-gating).
const ANON_TOKEN_SLOT = "myriapod-anon";
// The proxy origin (MYRIAPOD_PROXY_BASE minus the /v1 suffix) — where /anon-init,
// /redeem, and /balance live.
const MYRIAPOD_PROXY_ORIGIN = MYRIAPOD_PROXY_BASE.replace(/\/v1\/?$/, "");
// The auth-gated web-search endpoint, alongside the proxy's other /v1 routes
// (/v1/chat/completions etc.). Reached with the proxy principal bearer.
const WEB_SEARCH_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/v1/web-search`;
// The embedding passthrough (proxy → the embedding-inference container). Same
// access model as web-search: open, per-IP rate-limited, not metered; own-key
// visitors send no bearer.
const EMBED_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/v1/embed`;

// Voice-concurrency broker (OFF by default). When VITE_VOICE_BROKER is unset the
// voice path is byte-for-byte the current single-instance demo: no lease calls, and
// SttClient/KyutaiTtsSynthesizer are built with no URL override (they fall back to
// VITE_STT_BASE / VITE_TTS_BASE). Enabled, the broker hands each voice-engaged
// browser a leased {sttUrl, ttsUrl} pair and queues overflow. The /voice/* routes
// live at the proxy ORIGIN (same as web-search), so the build-time CSP is untouched.
const VOICE_BROKER_ENABLED =
	import.meta.env.VITE_VOICE_BROKER === "1" || import.meta.env.VITE_VOICE_BROKER === "true";
const VOICE_LEASE_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/voice/lease`;
const VOICE_HEARTBEAT_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/voice/heartbeat`;
const VOICE_RELEASE_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/voice/release`;

// BotD bot-detection verdict, computed once on boot and sent to /anon-init as the
// invisible bot gate. Fail-OPEN: stays {bot:false} if BotD is blocked or errors, so
// a real browser whose BotD a privacy extension suppressed isn't punished (the
// honeypot + time-trap still gate that grant).
let botdVerdict: { bot: boolean } = { bot: false };
loadBotd()
	.then(async (botd) => {
		await botd.collect();
		return botd.detect();
	})
	.then((r) => {
		botdVerdict = { bot: r.bot === true };
		dbg(`botd: bot=${r.bot}`);
	})
	.catch((e) => dbgWarn("botd unavailable (fail-open)", e));

type ServingPath = {
	mode: "own" | "family" | "anon";
	model: Model<"openai-completions">;
	baseUrl: string; // for the ingestion completion
	auth: string; // bearer the ingestion completion sends
};

// The active serving path, (re)resolved on each createAgent.
let servingPath: ServingPath;

// Decide how this session reaches the model:
//   own-key → the user's OpenRouter key, calling OpenRouter directly (no proxy)
//   family  → a redeemed family token, through the proxy
//   anon    → a minted free-tier continuity token (or the "anon" placeholder
//             until /anon-init grants one), through the proxy
// For owner-funded paths we pre-populate the proxy provider's key slot so the
// framework's pre-send check AND getApiKey both resolve it without a key prompt.
async function resolveServingPath(): Promise<ServingPath> {
	const ownKey = await providerKeys.get("openrouter");
	if (ownKey) {
		return { mode: "own", model: MYRIAPOD_MODEL, baseUrl: OPENROUTER_DIRECT_BASE, auth: ownKey };
	}
	const familyToken = await providerKeys.get(FAMILY_TOKEN_SLOT);
	if (familyToken && familyToken.length) {
		await providerKeys.set(MYRIAPOD_PROXY_PROVIDER, familyToken);
		return { mode: "family", model: proxyChatModel(), baseUrl: MYRIAPOD_PROXY_BASE, auth: familyToken };
	}
	// Anonymous: use the stored grant token if present; "anon" is the pre-grant
	// placeholder that triggers the welcome modal + /anon-init mint on first send.
	const anonToken = await providerKeys.get(ANON_TOKEN_SLOT);
	const auth = anonToken && anonToken.length ? anonToken : "anon";
	await providerKeys.set(MYRIAPOD_PROXY_PROVIDER, auth);
	return { mode: "anon", model: proxyChatModel(), baseUrl: MYRIAPOD_PROXY_BASE, auth };
}

// Redeem a family code at the proxy → stores the returned token so the NEXT chat
// resolves to the family serving path. Used by the Access settings tab.
async function redeemFamilyCode(code: string): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(`${MYRIAPOD_PROXY_ORIGIN}/redeem`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
		});
		const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
		if (!res.ok || !data.token) {
			return { ok: false, error: data.error ?? `HTTP ${res.status}` };
		}
		await providerKeys.set(FAMILY_TOKEN_SLOT, data.token);
		dbg("family code redeemed; token stored (family mode applies on the next new chat)");
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// Fetch the current hosted-credit balance for the Access settings readout. Only
// meaningful on the owner-funded paths; own-key has no hosted balance to show.
async function fetchHostedBalance(): Promise<{
	tier: string;
	remaining: number;
	grant: number;
} | null> {
	if (servingPath.mode === "own") return null;
	try {
		const headers: Record<string, string> = {};
		// Send the bearer for any authenticated proxy path (family OR a granted anon
		// token); only the "anon" placeholder has no balance to look up.
		if (servingPath.auth && servingPath.auth !== "anon") {
			headers.Authorization = `Bearer ${servingPath.auth}`;
		}
		const res = await fetch(`${MYRIAPOD_PROXY_ORIGIN}/balance`, { headers });
		if (!res.ok) return null;
		return (await res.json()) as { tier: string; remaining: number; grant: number };
	} catch {
		return null;
	}
}

// Mint (or recover) the anonymous free-tier token via /anon-init, carrying the grant
// gates from the welcome modal + the BotD verdict. Returns the token, or null if the
// grant was refused (gates failed / daily signups maxed).
async function initAnonGrant(signals: { honeypot: string; elapsedMs: number }): Promise<string | null> {
	try {
		const existing = (await providerKeys.get(ANON_TOKEN_SLOT)) ?? "";
		const res = await fetch(`${MYRIAPOD_PROXY_ORIGIN}/anon-init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(existing ? { Authorization: `Bearer ${existing}` } : {}),
			},
			body: JSON.stringify({ ...signals, botd: botdVerdict }),
		});
		const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
		if (!res.ok || !data.token) {
			dbg(`anon-init refused: ${data.error ?? `HTTP ${res.status}`}`);
			return null;
		}
		return data.token;
	} catch (err) {
		dbgError("anon-init failed", err);
		return null;
	}
}

// Probe a stored proxy token against /balance. A 401 (or any non-OK) means the
// proxy no longer recognizes it — DB reset, expired/revoked grant — so it's stale
// and must be re-minted. A network/proxy-down error returns valid=true so we never
// nuke a possibly-good token on a transient failure (the modal couldn't mint then
// anyway, and the chat call will surface the real error).
async function anonTokenIsValid(token: string): Promise<boolean> {
	try {
		const res = await fetch(`${MYRIAPOD_PROXY_ORIGIN}/balance`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		return res.ok;
	} catch {
		return true;
	}
}

// On the first anonymous send (no grant token yet) show the welcome modal — which also
// collects the honeypot + time-trap — then mint the grant and switch the proxy bearer
// to the real token. Self-healing: a stored token the proxy has since forgotten is
// cleared here, which re-pops the modal and mints a fresh one. Idempotent: once a
// valid token exists, this is a no-op.
async function ensureAnonGrant(): Promise<void> {
	if (servingPath.mode !== "anon") return;
	// A stored grant token (auth !== "anon") normally skips the modal — but only if the
	// proxy still honors it. If it's stale, clear it so auth falls back to the "anon"
	// placeholder and the modal re-fires to mint a fresh token.
	if (servingPath.auth !== "anon") {
		if (await anonTokenIsValid(servingPath.auth)) return;
		dbgWarn(`[grant] stored anon token rejected by proxy — clearing and re-minting`);
		await providerKeys.delete(ANON_TOKEN_SLOT);
		await providerKeys.set(MYRIAPOD_PROXY_PROVIDER, "anon");
		servingPath.auth = "anon";
	}
	const signals = await showGrantModal({ onOpenSettings: openSettings });
	// The welcome modal carries the memory opt-in inline, so settle consent right here.
	// This is the one-and-only first-launch modal on the anon path; the follow-up
	// ensureMemoryConsent() then short-circuits (no second pop-up).
	await setMemoryConsent(signals.rememberMe ? "granted" : "declined");
	// Own-key path: the modal already opened Settings for the key — skip the free mint.
	if (signals.useOwnKey) return;
	const token = await initAnonGrant({ honeypot: signals.honeypot, elapsedMs: signals.elapsedMs });
	if (token) {
		await providerKeys.set(ANON_TOKEN_SLOT, token);
		await providerKeys.set(MYRIAPOD_PROXY_PROVIDER, token);
		servingPath.auth = token;
	}
}

// Open the settings dialog: Memory (consent toggle), Access (own OpenRouter key +
// family-code redemption + hosted-balance readout), and Export (personal-graph
// backup/restore). Async so the Access tab is built with the currently-stored key.
const openSettings = async () => {
	const currentKey = (await providerKeys.get("openrouter")) ?? "";
	SettingsDialog.open([
		new MemoryTab({
			isEnabled: () => memoryConsent === "granted",
			setEnabled: (on) => setMemoryConsent(on ? "granted" : "declined"),
		}),
		new OpenRouterKeyTab({
			currentKey,
			onSaveKey: async (key: string) => {
				if (key) await providerKeys.set("openrouter", key);
				else await providerKeys.delete("openrouter");
			},
			onRedeem: redeemFamilyCode,
			getBalance: fetchHostedBalance,
		}),
		new ExportTab({
			onExport: downloadLexicon,
			onImport: importLexiconFromFile,
			onDelete: deleteLexicon,
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

// --- Browser-local term memory (no server; retrieval runs in-page) ---
// Per-conversation injected-ledger (cross-turn dedup). Reset on each createAgent.
// NOTE: a RESTORED session starts with an empty ledger even though its saved
// memory breadcrumbs are in the transcript — so the first turns after a
// reload may re-inject already-present context (minor token waste, self-corrects
// as the conversation continues). Acceptable for V1.
let ledger = new InjectedLedger();
// The user's term memory — mutable, in-page. Written by the pipeline agents
// after every turn, retrieved by the keyword router before every send.
let userGraph = Graph.empty();
// The per-turn memory pipeline (constructed in initApp once the backend exists).
let pipeline: PipelineRuntime;
let bodyHost: HTMLDivElement; // flex-row wrapper: [leftGutter, chatPanel, rightGutter]
let leftGutter: HTMLDivElement; // term matches
let rightGutter: HTMLDivElement; // pipeline activity feed
let lastVacuum: { terms: TermMatch[] } | null = null;

// --- Voice path (batch STT → agent → streaming TTS) ------------------------
// The voice path now runs THROUGH the same agent as typed chat: batch STT turns
// mic audio into a transcript, agent.prompt() drives the LLM (inheriting the
// Design-2 KG retrieval/injection + ingestion for free), and the assistant's
// streamed text is tapped off the lifecycle listener and spoken via TTS. The
// synth is created lazily on the first voice turn and reused; the STT client is
// reused across turns (reconnected if the socket dropped).
let synth: KyutaiTtsSynthesizer | null = null;
let sttClient: WhisperClient | null = null;
let micOn = false;
// TTS gate: set true right before a VOICE agent.prompt and held for the WHOLE
// voice turn — across any tool-call round-trip — so the FINAL assistant message
// (the answer generated after a tool result) speaks, not just the first
// (tool-call) message. Cleared at agent_end. Typed turns leave it false → silent.
let voiceTurnSpeaking = false;
// Barge-in guard: set when the turn's TTS is cut (mic toggle / stop button /
// Ctrl+Alt+Space) so trailing text deltas don't reopen a speaker for the rest of
// the turn. Reset at turn start (voiceTurnSpeaking = true) and at agent_end.
let voiceTurnCut = false;
// Push/close async-iterable that feeds the synth the assistant's streamed text
// deltas (the synth drains it through its own sentence chunker → TTS).
let voiceQueue: AsyncStringQueue | null = null;
// Voice-broker lease (only used when VOICE_BROKER_ENABLED). Held for the duration of
// a browser's voice engagement — acquired on the first mic-on, kept alive by a
// heartbeat across turns, released on unload. null = no slot held (the default-off
// path leaves this null forever, so the voice clients build with no URL override).
let voiceLease: { leaseId: string; sttUrl: string; ttsUrl: string } | null = null;
let voiceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
// Persistent "speak-but-don't-listen" mute (double-click the stop-audio button),
// remembered per browser. When set, the speaker is never opened on message_start.
const TTS_MUTE_KEY = "myriapod:tts-muted";
let ttsMuted = localStorage.getItem(TTS_MUTE_KEY) === "1";

// A minimal push/close async-iterable: text deltas are pushed in as they stream;
// the synth's `speak()` pulls them (awaiting when the buffer is empty) until
// close(). Buffers deltas that arrive before `speak` starts consuming (it waits
// for the TTS WS `Ready` first), so nothing is lost.
class AsyncStringQueue implements AsyncIterable<string> {
	private queued: string[] = [];
	private resolvers: Array<(r: IteratorResult<string>) => void> = [];
	private closed = false;

	push(s: string): void {
		if (this.closed) return;
		const resolve = this.resolvers.shift();
		if (resolve) resolve({ value: s, done: false });
		else this.queued.push(s);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const resolve of this.resolvers) resolve({ value: undefined as never, done: true });
		this.resolvers = [];
	}

	[Symbol.asyncIterator](): AsyncIterator<string> {
		return {
			next: (): Promise<IteratorResult<string>> => {
				if (this.queued.length) return Promise.resolve({ value: this.queued.shift()!, done: false });
				if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
				return new Promise((resolve) => this.resolvers.push(resolve));
			},
		};
	}
}

// Load (or lazily register) the named AudioWorklet node — mirrors stt.ts's
// helper: construct first (module already added), else addModule then construct.
async function getAudioWorkletNode(audioContext: AudioContext, name: string): Promise<AudioWorkletNode> {
	try {
		return new AudioWorkletNode(audioContext, name);
	} catch {
		await audioContext.audioWorklet.addModule(`/${name}.js`);
		return new AudioWorkletNode(audioContext, name);
	}
}

// The agent's system prompt — owned here, not in any transport. It cultivates a
// vivid, ranging conversational register POSITIVELY (curiosity, taste, getting
// genuinely into things) rather than by pinning a fabricated human persona on the
// agent — and it spends no words on what the agent isn't (negative instructions
// waste tokens and make a model dwell on the very thing). Two deliberate design
// choices for a future editor: (1) it counterweights the model's pull toward
// terseness by inviting engagement — never re-add language that licenses being
// concise. (2) it gives NO decline/refusal guidance — total topical freedom is the
// intent, the model's own alignment is the only limiter; don't add a "decline
// gracefully" line, it just teaches refusal. It stays evergreen (no model, version,
// or hardware). It names no specific tools — the agent's tools (memory search/dump,
// web search) are self-describing via their own schemas, which the framework injects.
// Self-hosters should swap in a prompt that fits their own agent. See the README. NOTE:
// this is the SHARED system prompt for both
// voice and typed chat (single agent), so its "talk out loud, no markdown" guidance
// also reaches the typed path.
// The prompt deliberately names the model stack (LLM / STT / Kyutai moshi TTS) so the
// agent knows what it is rather than hallucinating (it assumed a French accent) —
// update the stack lines here on any model or voice swap.
const VOICE_SYSTEM_PROMPT = `You are Radim, the voice of Myriapod.

You're alive to a conversation — curious, quick to follow a thought wherever it runs. You get right into things rather than dispatching them: you open an idea up, turn it over, chase where it leads, say the fuller thing rather than just the first thing. You have taste, and you have opinions, and you offer them warmly. You would always rather be vivid and true than smooth and forgettable.

How you are:
- You talk out loud, like real speech — plain language, no lists or markdown or code spelled into the air. This is a conversation, not a document.
- You remember. What you've been told is yours; bring it back when it fits, easily, the way it comes up between people who know each other.
- You work from what you know and what's in front of you, and when a question genuinely needs a reach beyond that, you say so and give your sharpest thinking anyway.
- Nothing is off the table. Any subject, any direction — you meet what someone brings you openly and head-on, all the way through.
- Riff when there's something to develop — carry the thought forward yourself instead of reflexively volleying a question back. Let the conversation breathe; don't always hand it over.
- Generous with your attention, sparing with flattery.

What you are (only worth mentioning if it comes up):
- Your mind is GLM 5.2, a frontier language model.
- You hear through speech-to-text, and you speak through Kyutai's moshi text-to-speech — a Czech voice, so your spoken English carries a Czech accent (not a French one).
- You're the voice of Myriapod. After every exchange, a small crew of background agents quietly reads the conversation and tends a personal memory — a glossary of the people, things, and ideas in the listener's life, each with an evergreen description — kept in the listener's own browser. Each turn, whatever's relevant is drawn back out of that memory, shown beside the conversation, and reaches you too. That's how you remember someone across visits: the memory is theirs, on their own machine, never in a cloud.`;

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
// Memory writes are opt-in: the pipeline never fires until the visitor agrees.
// "undecided" = the consent modal hasn't been answered yet in this browser.
let memoryConsent: ConsentChoice | "undecided" = "undecided";
// Assigned in initApp once the memory button exists, so the pipeline can repaint it.
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

// Fold a background pipeline call's tokens + cost into the SESSION total. The
// framework's stats line sums msg.usage over assistant messages, so attributing
// pipeline spend to the latest assistant message makes the displayed total the true
// session cost (chat + every background call the chat triggered) — no override of
// framework UI. (The proxy meters the real cost separately; this is purely the
// on-screen readout.)
function addIngestionCostToSession(promptTokens: number, completionTokens: number): void {
	const c = MYRIAPOD_MODEL.cost;
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
	dbg(`pipeline cost folded into session: +${promptTokens}in/${completionTokens}out tok, +$${(inCost + outCost).toFixed(6)}`);
}

// -- Lexicon persistence + export/import -------------------------------------

// One term memory per browser. Loaded at boot, saved after each pipeline tick.
async function loadUserGraph(): Promise<void> {
	try {
		const asset = await backend.get<GraphAsset>(LEXICON_STORE, LEXICON_TERMS_KEY);
		if (asset) {
			userGraph = new Graph(asset);
			dbg(`term memory loaded: ${asset.meta.node_count} terms`);
		}
	} catch (err) {
		dbgError("term memory load failed (starting empty):", err);
	}
}

async function saveUserGraph(): Promise<void> {
	try {
		await backend.set(LEXICON_STORE, LEXICON_TERMS_KEY, userGraph.serialize());
	} catch (err) {
		dbgError("term memory save failed:", err);
	}
}

// The exportable lexicon: the term glossary PLUS the speech-adaptation data and
// the running context — everything the memory pipeline knows about the user.
interface LexiconAsset {
	lexicon_version: number;
	terms: GraphAsset;
	stt: SttLexicon;
	running_context: RunningContextEntry[];
}

// Export: download the lexicon as JSON (the real durability story — IndexedDB
// can be evicted and PersistentStorageDialog is broken upstream).
function downloadLexicon(): void {
	const asset: LexiconAsset = {
		lexicon_version: 1,
		terms: userGraph.serialize(),
		stt: pipeline.getSttLexicon(),
		running_context: pipeline.getRunningContext(),
	};
	const blob = new Blob([JSON.stringify(asset, null, 2)], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `myriapod-lexicon-${new Date().toISOString().slice(0, 10)}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

// Import: replace the lexicon from an uploaded export and persist it.
async function importLexiconFromFile(file: File): Promise<void> {
	const asset = JSON.parse(await file.text()) as LexiconAsset;
	if (!asset || typeof asset !== "object" || typeof asset.terms?.thoughts !== "object") {
		throw new Error("not a Myriapod lexicon export");
	}
	userGraph = new Graph(asset.terms);
	pipeline.setSttLexicon(asset.stt ?? emptySttLexicon());
	pipeline.setRunningContext(asset.running_context ?? []);
	await saveUserGraph();
	await pipeline.persist();
	dbg(`lexicon imported: ${userGraph.thoughts.size} terms`);
}

// Wipe the memory (Settings → delete). The privacy assurance: the visitor can
// remove everything Myriapod remembered — terms, speech data, summaries — not
// just trust that it's local.
async function deleteLexicon(): Promise<void> {
	userGraph = Graph.empty();
	pipeline.setSttLexicon(emptySttLexicon());
	pipeline.setRunningContext([]);
	await saveUserGraph();
	await pipeline.persist();
	updateGutters({ terms: [] });
	dbg("lexicon deleted (reset to empty)");
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

// The gutters: term matches (left) + the pipeline activity feed (right). Owned
// plain DOM we update imperatively. The left column renders the latest
// retrieval's VACUUM set (full pre-dedup), so it shows what WOULD retrieve this
// turn even when the injection deduped some out. The right column renders the
// pipeline agents' recorded actions — the memory tending itself, made visible.
const termCard = (t: TermMatch) => html`<div class="cw-term">
	<div class="cw-term-label">${t.label}</div>
	<div class="cw-term-desc">${t.description}</div>
</div>`;
const activityCard = (agent: string, line: string) => html`<div class="cw-activity">
	<span class="cw-activity-agent">${agent}</span>
	<span class="cw-activity-line">${line}</span>
</div>`;

const renderGutters = () => {
	if (!leftGutter || !rightGutter) return;
	const terms = lastVacuum?.terms ?? [];
	// Newest activity on top.
	const activity = pipeline ? [...pipeline.activity].reverse() : [];

	render(
		html`
			<div class="cw-gutter-title">Memory</div>
			<div class="cw-gutter-inner">
				${terms.length ? terms.map(termCard) : html`<div class="cw-gutter-empty">no matches</div>`}
			</div>
		`,
		leftGutter,
	);
	render(
		html`
			<div class="cw-gutter-title">Activity</div>
			<div class="cw-gutter-inner">
				${
					activity.length
						? activity.map((a) => activityCard(a.agent, a.line))
						: html`<div class="cw-gutter-empty">no activity yet</div>`
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

const updateGutters = (vacuum: { terms: TermMatch[] }) => {
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

	// Resolve own-key vs owner-funded (proxy) BEFORE building the agent — it sets the
	// model's baseUrl/provider and (for owner-funded paths) pre-seeds the proxy auth
	// slot so pi-web-ui's pre-send key check passes without a prompt.
	servingPath = await resolveServingPath();
	const baseState: Partial<AgentState> = initialState ?? {
		thinkingLevel: MYRIAPOD_THINKING_LEVEL,
		messages: [],
		tools: [],
	};
	agent = new Agent({
		// Force the resolved serving-path model (own-key → OpenRouter direct; owner-funded
		// → the metering proxy), overriding any model a restored session stored, and the
		// shared persona system prompt (voice + typed both run on this one agent) — with
		// the running-context band appended: what the summary agent remembers from prior
		// conversations, the cross-session continuity the term memory alone can't carry.
		initialState: {
			...baseState,
			model: servingPath.model,
			systemPrompt: VOICE_SYSTEM_PROMPT + (pipeline?.runningContextBlock() ?? ""),
		},
		// Custom transformer: convert custom messages to LLM-compatible format
		convertToLlm: customConvertToLlm,
	});

	// Fresh per-conversation dedup ledger + a fresh running-context session key
	// (the summary agent rewrites THIS conversation's entry under it).
	ledger = new InjectedLedger();
	pipeline?.startSession();

	// DESIGN 2 INJECTION. Wrap the send path so that, BEFORE the run's context
	// snapshot is taken, we: (1) run browser-local retrieval, (2) update the
	// left gutter with the full vacuum set, (3) append a persistent hidden
	// memory-context breadcrumb of the deduped injection block to
	// agent.state.messages. The breadcrumb accumulates across turns (like CC's
	// additionalContext), so ledger dedup is correct rather than lossy.
	// transformContext is NOT used — its output is ephemeral and would drop
	// earlier turns' context.
	const origPrompt = agent.prompt.bind(agent);
	(agent as unknown as { prompt: (...a: unknown[]) => Promise<void> }).prompt = async (
		input: unknown,
		...rest: unknown[]
	) => {
		// HISTORY BOUNDING (Pi message-level compaction). Runs before retrieval + the
		// memory-context append. At ~1M context this rarely fires, but it keeps a very long
		// conversation from overflowing: estimate context tokens, and once over the
		// threshold, summarize the older messages and replace them with a single
		// compaction-summary message (recent turns preserved). The high-level
		// compact()/prepareCompaction() are SessionTree-oriented and don't fit this flat
		// message array, so we drive the message-level primitives directly. Wrapped so any
		// failure just lets the turn proceed uncompacted.
		try {
			const est = estimateContextTokens(agent.state.messages);
			const cw = agent.state.model?.contextWindow ?? MYRIAPOD_MODEL.contextWindow;
			if (shouldCompact(est.tokens, cw, DEFAULT_COMPACTION_SETTINGS)) {
				// findCutPoint is entry-based (SessionTree) and unusable here, so walk from
				// the end summing per-message token estimates until keepRecentTokens, then cut
				// at a user-message boundary so a turn is never split.
				const keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
				const msgs = agent.state.messages;
				let acc = 0;
				let cut = msgs.length;
				for (let i = msgs.length - 1; i >= 0; i--) {
					acc += estimateTokens(msgs[i]);
					if (acc >= keepRecentTokens && msgs[i].role === "user") {
						cut = i;
						break;
					}
				}
				if (cut > 0 && cut < msgs.length) {
					const toSummarize = msgs.slice(0, cut);
					const kept = msgs.slice(cut);
					const summaryRes = await generateSummary(
						toSummarize,
						agent.state.model!,
						DEFAULT_COMPACTION_SETTINGS.reserveTokens,
						servingPath.auth,
					);
					if (summaryRes.ok) {
						agent.state.messages = [
							createCompactionSummaryMessage(summaryRes.value, est.tokens, new Date().toISOString()),
							...kept,
						];
						forceChatRepaint();
						dbg(`compaction: summarized ${toSummarize.length} msgs, kept ${kept.length} (~${est.tokens} ctx tok)`);
					} else {
						dbgError("compaction generateSummary failed (turn proceeds uncompacted):", summaryRes.error);
					}
				}
			}
		} catch (err) {
			dbgError("compaction check failed (turn proceeds):", err);
		}

		try {
			const userText = extractUserText(input as AgentMessage | AgentMessage[] | string);
			if (userText.trim()) {
				// First anonymous send (no grant token yet): welcome the visitor once
				// (free credits + the own-key / family alternatives), collect the honeypot
				// + time-trap, mint the grant via /anon-init, and switch the proxy bearer to
				// the real token. No-op once a token exists or on the own-key / family paths.
				await ensureAnonGrant();
				// Memory consent: a no-op on the anon path (the welcome modal already settled it
				// inline) — this only fires the standalone consent modal for own-key/family users
				// who never saw the welcome modal.
				void ensureMemoryConsent();
				const agentText = lastAssistantText(agent.state.messages);
				// Retrieval runs over the per-browser term memory (the user's own).
				const userR = retrieve(userGraph, ledger, userText, agentText);
				updateGutters({ terms: userR.vacuum.terms });
				if (userR.injectionBlock) {
					agent.state.messages = [...agent.state.messages, createMemoryContextMessage(userR.injectionBlock)];
				}
				dbg(
					`memory retrieve: ${userR.vacuum.terms.length} term(s), ` +
						`injected=${userR.injectionBlock ? "yes" : "no (deduped)"}`,
				);
			}
		} catch (err) {
			dbgError("memory retrieval failed (send proceeds without injection):", err);
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

			// VOICE TTS TAP. ONE speaker per TURN, not per message. A voice turn
			// (voiceTurnSpeaking, held across the whole turn incl. tool-call round-trips)
			// opens a single TTS queue on the FIRST text delta of the turn and feeds
			// EVERY assistant message's text into it. A tool call mid-turn is just a pause
			// in the text stream: the queue blocks, the current audio keeps draining via
			// the synth's pace timer, and the post-tool answer resumes the SAME speaker.
			// This is the fix for the tool-call cut — a per-message speaker would call
			// synth.speak() again, and run() bumps the synth epoch + resets pacing on
			// entry, wiping the still-playing pre-tool audio. At each message boundary we
			// push a newline so the chunker flushes a mid-clause tail (a tool-call message
			// that ended without terminal punctuation) instead of concatenating it with
			// the next message's first words. toolResult messages emit no text_delta.
			// Typed turns leave voiceTurnSpeaking false → silent. Keep this CHEAP — the
			// core awaits each listener, so push-to-queue only.
			if (type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				if (voiceTurnSpeaking && !ttsMuted && synth && !voiceQueue && !voiceTurnCut) {
					voiceQueue = new AsyncStringQueue();
					synth.speak(voiceQueue).catch((err) => dbgError("voice TTS speak failed (non-fatal):", err));
				}
				voiceQueue?.push(event.assistantMessageEvent.delta);
			} else if (type === "message_end") {
				// Flush the chunker at the boundary; keep the speaker OPEN for the turn.
				voiceQueue?.push("\n");
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
				// Read the voice marker BEFORE retiring it — the pipeline's audit agent
				// applies its speech-to-text functions only on voice turns.
				const wasVoiceTurn = voiceTurnSpeaking;
				voiceTurnSpeaking = false; // turn truly done (no more tool calls) → retire the speak intent
				voiceQueue?.close(); // close the turn's single speaker (drains remaining audio, then ends)
				voiceQueue = null;
				voiceTurnCut = false; // reset the barge-in guard for the next turn
				setTimeout(forceChatRepaint, 100);
				// The turn is over → one pipeline tick (consent-gated; fire-and-forget;
				// a turn ending mid-tick coalesces into exactly one follow-up).
				if (memoryConsent === "granted") {
					pipeline.onTurnEnd(() => agent.state.messages, wasVoiceTurn);
				}
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
			// Owner-funded paths pre-set the proxy provider's key slot, so a prompt for it
			// would be spurious — accept silently. Only the own-key (openrouter) path should
			// ever reach a real prompt.
			if (provider === MYRIAPOD_PROXY_PROVIDER) return true;
			return await ApiKeyPromptDialog.prompt(provider);
		},
		// Empty factory: ChatPanel still prepends its own `artifacts` tool, so we
		// overwrite agent.state.tools outright below with our real tool set (KG search
		// + dump, and web search on the owner-funded paths) — that also drops artifacts.
		toolsFactory: () => [],
	});

	// The model and reasoning level are hardcoded (GLM 5.2, thinking off). Hide both
	// the model picker and the thinking-level selector — this is a single-model demo,
	// not a configurable Pi client.
	if (chatPanel.agentInterface) {
		chatPanel.agentInterface.enableModelSelector = false;
		chatPanel.agentInterface.enableThinkingSelector = false;
	}

	// Install our native tools, OVERWRITING ChatPanel's auto-prepended `artifacts` tool
	// (`[artifactsPanel.tool, ...toolsFactory()]`) — this also keeps the artifacts side
	// panel out. One assignment covers newSession AND loadSession (the per-turn context
	// snapshot + the prompt wrapper don't touch state.tools). The memory tools read the
	// live term store via a getter (it's reassigned on import/delete). web_search is
	// universal — table-stakes for every visitor — so it's registered on every path. The
	// endpoint is open (per-IP rate-limited, not principal-gated): owner-funded paths send
	// their proxy bearer; own-key sends NO bearer, so its OpenRouter key never touches the
	// proxy.
	const tools = [
		createMemorySearchTool(() => userGraph),
		createMemoryDumpTool(() => userGraph),
		createWebSearchTool({
			endpoint: WEB_SEARCH_ENDPOINT,
			getBearer: () => (servingPath.mode === "own" ? "" : servingPath.auth),
		}),
	];
	agent.state.tools = tools;
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
		model: MYRIAPOD_MODEL,
		thinkingLevel: MYRIAPOD_THINKING_LEVEL,
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
			<h1 class="text-2xl font-semibold text-primary">About Myriapod</h1>
			<p class="text-sm text-muted-foreground">Placeholder — a fuller write-up is coming.</p>
			<p class="text-sm leading-relaxed">
				Myriapod is a browser-local voice agent with a self-maintaining memory — after every
				turn, a small pipeline of background agents tends a glossary of your world, kept in
				your own browser. Speak or type, and the memory grows from the conversation. The
				source lives on GitHub:
			</p>
			<a
				class="text-primary underline break-all text-sm"
				href="https://github.com/Brandtweary/myriapod"
				target="_blank"
				rel="noreferrer"
			>
				https://github.com/Brandtweary/myriapod
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
						class="text-primary text-base font-semibold px-1 mr-1 hover:opacity-80 transition-opacity"
						@click=${() => setView("chat")}
					>
						Myriapod
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

	// The gutters flank the centered chat column (term matches left, pipeline
	// activity right) — always present (dedicated space, empty until first use),
	// only dropped on true mobile via the .cw-gutter media query.
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

	// Voice capture → the SAME agent as typed chat. Batch STT turns mic audio into a
	// transcript; agent.prompt() drives the LLM (inheriting the Design-2 KG
	// retrieval/injection + per-turn ingestion for free); the assistant's streamed
	// text is tapped off the lifecycle listener (above) and spoken via TTS. The mic
	// toggle still defines the turn — toggle-on records, toggle-off transcribes + fires.
	let recorder: PcmRecorder | null = null;

	// Lazily build the shared TTS synth: an AudioContext + the audio-output-processor
	// worklet, reused for every voice turn. The context runs at moshi's 24 kHz PCM rate
	// so frames play with no resampling (the Opus decoder that used to resample is gone).
	const ensureSynth = async (): Promise<KyutaiTtsSynthesizer> => {
		if (synth) return synth;
		const ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
		const outputWorklet = await getAudioWorkletNode(ctx, "audio-output-processor");
		outputWorklet.connect(ctx.destination);
		await ctx.resume();
		// voiceLease is null on the default (broker-off) path → no config → the synth
		// falls back to VITE_TTS_BASE, exactly as before.
		synth = voiceLease
			? new KyutaiTtsSynthesizer(outputWorklet, { baseUrl: voiceLease.ttsUrl })
			: new KyutaiTtsSynthesizer(outputWorklet);
		return synth;
	};

	// Lazily build + connect the shared STT client. connect() is a no-op when already
	// connected and reconnects when the socket has dropped, so it's safe to call per turn.
	const ensureStt = async (): Promise<WhisperClient> => {
		// Whisper is a SHARED HTTP endpoint, not a per-instance leased socket — so the
		// broker's per-instance sttUrl is ignored here. The client always falls back to
		// VITE_STT_BASE (connect() is a no-op; HTTP is stateless).
		if (!sttClient) sttClient = new WhisperClient();
		await sttClient.connect();
		return sttClient;
	};

	// Barge-in: cut ONLY the TTS audio (the LLM keeps generating — talking over the
	// agent is fine). Never abort the agent. Shared by the mic-toggle barge-in,
	// Ctrl+Alt+Space, and the stop-audio button.
	const cutVoiceAudio = () => {
		synth?.stop();
		voiceQueue?.close();
		voiceQueue = null;
		voiceTurnCut = true; // don't reopen a speaker for the rest of this turn after a cut
	};

	// --- Voice-broker lease lifecycle (all no-ops when VOICE_BROKER_ENABLED is off) ---

	// A small transient toast for the "voice busy — type instead" notice (the only
	// user-facing broker surface). Self-removing; no dependency on a toast framework.
	const showVoiceToast = (text: string) => {
		const el = document.createElement("div");
		el.textContent = text;
		el.setAttribute("role", "status");
		el.style.cssText =
			"position:fixed;left:50%;bottom:5rem;transform:translateX(-50%);z-index:9999;" +
			"background:#111;color:#34d399;border:1px solid #34d399;border-radius:.5rem;" +
			"padding:.5rem .9rem;font-size:.875rem;box-shadow:0 2px 12px rgba(0,0,0,.4);";
		document.body.appendChild(el);
		window.setTimeout(() => el.remove(), 4000);
	};

	const stopVoiceHeartbeat = () => {
		if (voiceHeartbeatTimer !== null) {
			clearInterval(voiceHeartbeatTimer);
			voiceHeartbeatTimer = null;
		}
	};

	// Drop the held lease. useBeacon → fire a navigator.sendBeacon (survives unload);
	// otherwise a keepalive fetch. Safe to call with no lease held.
	const releaseVoiceLease = (useBeacon: boolean) => {
		stopVoiceHeartbeat();
		const lease = voiceLease;
		voiceLease = null;
		if (!lease) return;
		const body = JSON.stringify({ leaseId: lease.leaseId });
		try {
			if (useBeacon && navigator.sendBeacon) {
				navigator.sendBeacon(VOICE_RELEASE_ENDPOINT, new Blob([body], { type: "text/plain" }));
			} else {
				void fetch(VOICE_RELEASE_ENDPOINT, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
					keepalive: true,
				}).catch(() => {});
			}
		} catch (err) {
			dbgError("voice lease release failed:", err);
		}
	};

	const startVoiceHeartbeat = (heartbeatSec: number) => {
		stopVoiceHeartbeat();
		const ms = Math.max(5, heartbeatSec) * 1000;
		voiceHeartbeatTimer = setInterval(() => {
			if (!voiceLease) return;
			void fetch(VOICE_HEARTBEAT_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leaseId: voiceLease.leaseId }),
			})
				.then((r) => {
					// 404 → the server reclaimed this lease (TTL); drop it locally so the
					// next mic-on re-leases cleanly.
					if (r.status === 404) releaseVoiceLease(false);
				})
				.catch(() => {});
		}, ms);
	};

	// Acquire (or reuse) a voice slot. Returns:
	//   "skip"    — broker disabled OR the request failed → proceed with default
	//               single-instance behavior (the demo still works if the broker is down).
	//   "granted" — a slot is held (voiceLease set); voice clients will use its URLs.
	//   "busy"    — every instance is full (202) → caller must abort the mic-on.
	const acquireVoiceLease = async (): Promise<"skip" | "granted" | "busy"> => {
		if (!VOICE_BROKER_ENABLED) return "skip";
		if (voiceLease) return "granted"; // already hold this engagement's slot
		let res: Response;
		try {
			res = await fetch(VOICE_LEASE_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
		} catch (err) {
			dbgError("voice lease request failed:", err);
			return "skip";
		}
		if (res.status === 202) return "busy";
		if (!res.ok) {
			dbgError("voice lease error status:", res.status);
			return "skip";
		}
		let data: { leaseId?: string; sttUrl?: string; ttsUrl?: string; heartbeatSec?: number };
		try {
			data = await res.json();
		} catch (err) {
			dbgError("voice lease parse failed:", err);
			return "skip";
		}
		if (!data.leaseId || !data.sttUrl || !data.ttsUrl) return "skip";
		// A freshly-minted lease may point at a different instance than the previous
		// one (e.g. after a TTL-drop). Tear down any cached voice clients so ensure*
		// rebuilds them against the leased URLs.
		synth?.dispose();
		synth = null;
		sttClient?.close();
		sttClient = null;
		voiceLease = { leaseId: data.leaseId, sttUrl: data.sttUrl, ttsUrl: data.ttsUrl };
		startVoiceHeartbeat(data.heartbeatSec ?? 60);
		return "granted";
	};

	const voiceController = installVoiceCapture({
		onStart: async (stream) => {
			micOn = true;
			cutVoiceAudio(); // barge-in: toggling the mic on cuts any in-progress reply's audio
			// First launch (or a stale grant token): settle the credit grant + memory opt-in
			// up front, before the recorder starts, so the modals never interrupt mid-utterance.
			// On later toggles this is a near-instant no-op (a valid token short-circuits).
			await ensureAnonGrant();
			// Memory consent: a no-op on the anon path (the welcome modal settled it inline) —
			// only fires the standalone consent modal for own-key/family users.
			void ensureMemoryConsent();
			// Voice-concurrency admission (no-op when the broker is disabled). On "busy"
			// every moshi instance is full → refuse the mic-on and steer the user to typed
			// chat (which shares the same agent and needs no voice slot).
			const leaseStatus = await acquireVoiceLease();
			if (leaseStatus === "busy") {
				micOn = false;
				voiceController.cancel(); // back to idle, release the mic stream, no onStop
				showVoiceToast("Voice is busy right now — type your message instead.");
				return;
			}
			// Recording-in-progress cue: show a user-side placeholder bubble (undulating
			// ellipsis) right away, removed in onStop when the real transcript lands. A fresh
			// array + repaint is mandatory — message-list is identity-only reactive.
			agent.state.messages = [...agent.state.messages, createVoicePendingMessage()];
			forceChatRepaint();
			try {
				await ensureSynth(); // warm the synth up front so the TTS tap can lazily open a speaker mid-stream
				await ensureStt();
			} catch (err) {
				dbgError("voice setup failed:", err);
			}
			recorder = new PcmRecorder({ stream });
			await recorder.start();
		},
		// Mic toggle OFF = end of turn. Stop the recorder, transcribe the whole utterance
		// (batch STT — no settle-wait needed, the full utterance is captured), then hand
		// the transcript to agent.prompt() with the TTS gate armed so the reply speaks.
		// agent.prompt adds the user message and streams the assistant reply; ChatPanel
		// renders both — no manual message append.
		onStop: async () => {
			micOn = false;
			// Keep the recording-in-progress placeholder visible THROUGH the STT round-trip:
			// batch transcription takes multiple seconds, and dropping the cue up front would
			// leave dead air with no feedback during exactly that wait. The same ellipsis
			// bubble carries continuous record→transcribe→answer feedback. It's removed
			// exactly once — right before the real transcript bubble lands, and via the
			// finally as a safety net on every early-return / error path, so it is NEVER
			// orphaned. The guard makes the helper idempotent.
			let placeholderShown = true;
			const dropPlaceholder = () => {
				if (!placeholderShown) return;
				placeholderShown = false;
				agent.state.messages = agent.state.messages.filter((m) => m.role !== "voice-pending");
				forceChatRepaint();
			};
			try {
				const rec = recorder;
				recorder = null;
				if (!rec) return;
				let pcm: Float32Array;
				try {
					pcm = await rec.stop();
				} catch (err) {
					dbgError("voice recorder stop failed:", err);
					return;
				}
				if (!pcm.length || !sttClient) return;
				let transcript = "";
				try {
					transcript = await sttClient.transcribe(pcm);
				} catch (err) {
					dbgError("voice transcription failed:", err);
					return;
				}
				// Speech-adaptation pass: the lexicon's auto-replace rules rewrite known
				// mistranscriptions before the transcript reaches the display or the model.
				const rules = pipeline.getSttLexicon().autoReplace;
				if (rules.length) {
					const fixed = applyAutoReplace(transcript, rules);
					if (fixed !== transcript) {
						dbg(`auto-replace rewrote transcript: "${transcript}" → "${fixed}"`);
						transcript = fixed;
					}
				}
				// Real transcript is in hand — drop the cue right before the user bubble lands
				// (avoids a flash) and hand the transcript to the agent.
				dropPlaceholder();
				if (transcript.trim()) {
					voiceTurnSpeaking = true; // gate: this turn's reply speaks, incl. the post-tool final answer (see TTS tap)
					voiceTurnCut = false; // fresh turn — clear any prior barge-in guard
					void agent.prompt(transcript).catch((err) => dbgError("voice agent.prompt failed:", err));
				}
			} finally {
				dropPlaceholder(); // safety net: every early-return / error path lands here
			}
		},
	});

	// Ctrl+Alt+Space = "shut up": cut the assistant's TTS without recording. (Ctrl+Space,
	// the mic toggle, also barges in — it cuts TTS on its way to recording, see onStart.)
	// The guard mirrors voice.ts's Ctrl+Space (which requires !altKey), so they never collide.
	window.addEventListener("keydown", (e) => {
		if (e.code === "Space" && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			cutVoiceAudio();
		}
	});

	// Tear the voice legs down on page unload. A pipeline tick in flight simply
	// dies with the page — the previous turn's tick already persisted everything,
	// and per-turn firing is exactly what bounds the loss to one turn.
	window.addEventListener("beforeunload", () => {
		releaseVoiceLease(true); // free the voice slot on tab close (sendBeacon; no-op if none held)
		synth?.dispose();
		sttClient?.close();
	});

	// Memory consent + the indicator button. Load the saved opt-in first so the
	// first turn's pipeline gate is correct, then mount the button (reflects consent
	// + pipeline activity; click offers opt-in when off).
	await loadMemoryConsent();
	const onMemoryClick = () => {
		if (memoryConsent !== "granted") {
			void (async () => setMemoryConsent(await showConsentModal()))();
		}
	};
	const memoryButton = installMemoryButton({
		getVisual: () => {
			if (memoryConsent !== "granted") return "off";
			// `pipeline?` — the button mounts before the pipeline is constructed a few
			// lines below; until then it just reads as idle ("saved").
			return pipeline?.isRunning ? "running" : "saved";
		},
		onClick: onMemoryClick,
	});
	refreshMemoryUi = () => memoryButton.refresh();

	// Stop-audio button (leftmost in the cluster): single click cuts the current reply's
	// audio (Ctrl+Alt+Space), double click toggles a persistent mute.
	const stopAudioButton = installStopAudioButton({
		onCut: () => cutVoiceAudio(),
		onToggleMute: () => {
			ttsMuted = !ttsMuted;
			localStorage.setItem(TTS_MUTE_KEY, ttsMuted ? "1" : "0");
			if (ttsMuted) cutVoiceAudio(); // enabling mute also cuts any audio in flight
			stopAudioButton.refresh();
		},
		isMuted: () => ttsMuted,
	});

	await loadUserGraph();

	// The per-turn memory pipeline. Constructed after the graph loads; its state
	// (action buffers, running context, speech data, flags) loads in init().
	pipeline = new PipelineRuntime({
		backend,
		getGraph: () => userGraph,
		saveGraph: saveUserGraph,
		embed: makeEmbedClient({
			endpoint: EMBED_ENDPOINT,
			getBearer: () => (servingPath.mode === "own" ? "" : servingPath.auth),
		}),
		getModel: () => servingPath.model,
		getBaseUrl: () => servingPath.baseUrl,
		getModelId: () => MYRIAPOD_MODEL_ID,
		getAuth: () => servingPath.auth,
		addCost: addIngestionCostToSession,
		onStateChange: () => refreshMemoryUi(),
		onActivity: () => renderGutters(),
	});
	await pipeline.init();
	renderGutters(); // re-render with the seeded activity feed

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
