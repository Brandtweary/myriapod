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
import { CYMBIONT_MODEL, CYMBIONT_THINKING_LEVEL } from "./cymbiont-model.js";
import { OpenRouterKeyTab } from "./settings.js";
import { dbg, dbgError, dbgWarn, installInstrumentation, summarizeMessages } from "./debug.js";
import { customConvertToLlm, registerCustomMessageRenderers } from "./custom-messages.js";

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
];

// Create backend
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 2, // Incremented for custom-providers store
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
	if (!chatPanel || !aboutHost) return;
	const showAbout = currentView === "about";
	chatPanel.style.display = showAbout ? "none" : "";
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

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: `You are a helpful AI assistant with access to various tools.

Available tools:
- JavaScript REPL: Execute JavaScript code in a sandboxed browser environment (can do calculations, get time, process data, create visualizations, etc.)
- Artifacts: Create interactive HTML, SVG, Markdown, and text artifacts

Feel free to use these tools when needed to provide accurate and helpful responses.`,
			model: CYMBIONT_MODEL,
			thinkingLevel: CYMBIONT_THINKING_LEVEL,
			messages: [],
			tools: [],
		},
		// Custom transformer: convert custom messages to LLM-compatible format
		convertToLlm: customConvertToLlm,
	});

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

			// Light logging — skip the per-token message_update spam.
			if (type !== "message_update") {
				dbg(`event ${type}: ${summarizeMessages(messages)}`);
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
						onClick: () => SettingsDialog.open([new OpenRouterKeyTab()]),
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

	aboutHost = document.createElement("div");
	aboutHost.className = "flex-1 min-h-0 overflow-y-auto";
	render(renderAbout(), aboutHost);

	app.append(headerHost, chatPanel, aboutHost);

	// TODO: PersistentStorageDialog is broken upstream — export/import is the
	// durability story instead.

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
