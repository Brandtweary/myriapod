// The per-turn memory pipeline runtime — the thin tick orchestrator.
//
// After every conversation turn (agent_end), one tick fires: the audit agent
// and the memory agent run serially (both mutate the term store; audit first,
// so it judges the turn's retrieval before the store shifts under it), while
// the summary agent runs in parallel (it writes only its own running-context
// entry). All three are fire-and-forget from the conversation's point of view.
//
// Cross-turn memory is the per-agent ACTION BUFFER: a bounded rolling log of
// each agent's past tool calls + its one-line self-summary, injected into its
// instructions every tick. The buffer is the signal integrator that lets
// destructive ops (merge/remove/rename) require recurrence across turns.
//
// The tooled agents run on pi-agent-core's runAgentLoop (the same loop the
// interactive Agent wraps) with a no-op event sink; the summary agent is a
// bare completion. Every call rides the active serving path, so the proxy
// meters it against the same principal as chat.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { defaultConvertToLlm } from "@earendil-works/pi-web-ui";
import { dbg, dbgError } from "./debug.js";
import type { Graph } from "./kg/graph.js";
import type { EmbedFn } from "./kg/embed.js";
import { makeCompletion } from "./kg/ingest.js";
import { MYRIAPOD_REASONING_EFFORT } from "./myriapod-model.js";
import { createPipelineTools, type ReviewFlag } from "./pipeline-tools.js";
import {
	buildAuditInstructions,
	buildMemoryManagerInstructions,
	buildSummaryInstructions,
	NO_ACTION_SENTINEL,
	NO_ENTRY_SENTINEL,
	PIPELINE_SYSTEM_STUB,
} from "./pipeline-prompts.js";
import { dumpExistingContext } from "./kg/ingest.js";
import { emptySttLexicon, type SttLexicon } from "./stt-lexicon.js";

// -- Persistence shapes -------------------------------------------------------

export interface BufferEntry {
	ts: string;
	actions: string[]; // one line per tool call, recorded by the tools themselves
	note: string; // the agent's one-line self-summary
}

export interface RunningContextEntry {
	sessionKey: string;
	ts: string;
	text: string;
}

export interface ActivityItem {
	ts: string;
	agent: PipelineAgentName;
	line: string;
}

export type PipelineAgentName = "audit" | "memory" | "summary";

// One tick's inputs, captured at TRIGGER time (turn end), never re-read at run time.
// The messages snapshot + sessionKey are frozen when the turn ends so a tick that runs
// after a New Chat / loadSession still summarizes ITS OWN conversation and writes under
// ITS OWN running-context key — not whatever conversation happens to be live when it runs.
interface TickInput {
	messages: AgentMessage[];
	isVoiceTurn: boolean;
	sessionKey: string;
}

// The pi-ai thinking LEVEL for the tooled pipeline agents (runAgentLoop). Kimi K3 is
// always-on single-mode, so this maps to the same "max" wire effort the chat agent uses
// (thinkingLevelMap: { high → "max" } in myriapod-model.ts). Kept as its own constant
// because the runAgentLoop path takes a pi-ai LEVEL, whereas the summary agent's
// hand-built ingest path takes the raw wire effort (MYRIAPOD_REASONING_EFFORT) directly.
const PIPELINE_THINKING = "high" as const;

const BUFFER_MAX_ENTRIES = 30; // per agent, rolling
const FLAGS_MAX_ENTRIES = 100; // review-flags store, rolling (was unbounded → grew forever)
const RUNNING_CONTEXT_MAX_WORDS = 8000; // rolling cap across entries
const ACTIVITY_MAX_ITEMS = 100; // in-memory feed cap
const AGENT_MAX_TURNS = 12; // runaway-loop backstop per tooled agent
const AGENT_TIMEOUT_MS = 180_000; // hard wall per agent per tick

// One IndexedDB store, keyed slots.
export const PIPELINE_STORE = "pipeline";
const KEY_BUFFERS = "buffers";
const KEY_STT = "stt-lexicon";
const KEY_FLAGS = "flags";
const KEY_RUNNING_CONTEXT = "running-context";

interface StorageLike {
	get<T>(store: string, key: string): Promise<T | null | undefined>;
	set(store: string, key: string, value: unknown): Promise<void>;
}

export interface PipelineDeps {
	backend: StorageLike;
	getGraph: () => Graph;
	saveGraph: () => Promise<void>;
	embed: EmbedFn;
	getModel: () => Model<"openai-completions">;
	getBaseUrl: () => string;
	getModelId: () => string;
	getAuth: () => string;
	// Fold a background call's tokens into the visible session stats.
	addCost: (promptTokens: number, completionTokens: number) => void;
	// Brain icon: any pipeline agent in flight?
	onStateChange: (state: "running" | "idle") => void;
	// Right-gutter activity feed repaint.
	onActivity: () => void;
	// Current memory-consent state, re-checked right before persisting so a consent
	// revoked mid-tick is honored. Absent/undefined is treated as granted.
	getConsent?: () => string;
}

// -- Transcript formatting ----------------------------------------------------

/** Render agent.state.messages as the pipeline transcript. The <memory>
 *  breadcrumbs are KEPT — retrieval visibility is the audit agent's subject
 *  matter. UI-only roles are dropped. */
export function formatTranscript(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		const role = (m as { role: string }).role;
		if (role === "user" || role === "assistant") {
			const c = (m as { content?: unknown }).content;
			let textContent = "";
			if (typeof c === "string") textContent = c;
			else if (Array.isArray(c)) {
				textContent = c
					.filter((b): b is { type: string; text?: string } => !!b && typeof b === "object")
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join(" ");
			}
			if (textContent.trim()) {
				parts.push(`[${role.toUpperCase()}]\n${textContent.trim()}`);
			}
		} else if (role === "memory-context") {
			// Self-delimiting <memory>…</memory> block — inject verbatim.
			parts.push((m as { block: string }).block);
		} else if (role === "compactionSummary") {
			parts.push(`[EARLIER CONVERSATION, SUMMARIZED]\n${(m as { summary: string }).summary}`);
		}
		// voice-pending / system-notification / toolResult: dropped.
	}
	return parts.join("\n\n");
}

// -- The runtime ---------------------------------------------------------------

export class PipelineRuntime {
	private deps: PipelineDeps;
	private buffers: Record<PipelineAgentName, BufferEntry[]> = {
		audit: [],
		memory: [],
		summary: [],
	};
	private sttLexicon: SttLexicon = emptySttLexicon();
	private flags: ReviewFlag[] = [];
	private runningContext: RunningContextEntry[] = [];
	private sessionKey = crypto.randomUUID();

	readonly activity: ActivityItem[] = [];

	private running = false;
	private queued: TickInput | null = null;

	constructor(deps: PipelineDeps) {
		this.deps = deps;
	}

	async init(): Promise<void> {
		const b = this.deps.backend;
		try {
			// Normalize to the CURRENT agent keys: a persisted buffer from before an
			// agent rename (e.g. "memory-manager" → "memory") carries a stale key, and a
			// bare `?? this.buffers` would leave the renamed agent's key missing →
			// undefined lookup in renderBuffer. Unknown/stale keys are dropped.
			const loadedBuffers = await b.get<Partial<Record<PipelineAgentName, BufferEntry[]>>>(
				PIPELINE_STORE,
				KEY_BUFFERS,
			);
			this.buffers = {
				audit: loadedBuffers?.audit ?? [],
				memory: loadedBuffers?.memory ?? [],
				summary: loadedBuffers?.summary ?? [],
			};
			this.sttLexicon = (await b.get(PIPELINE_STORE, KEY_STT)) ?? emptySttLexicon();
			this.flags = (await b.get(PIPELINE_STORE, KEY_FLAGS)) ?? [];
			this.runningContext = (await b.get(PIPELINE_STORE, KEY_RUNNING_CONTEXT)) ?? [];
		} catch (err) {
			dbgError("pipeline state load failed (starting fresh):", err);
		}
		// The activity feed starts empty every session — it's a live view of this
		// session's pipeline work, not a persisted log. (The action buffers above
		// still load; they're the agents' cross-turn memory, not the gutter feed.)
	}

	/** A new conversation began (createAgent). The summary agent keys its
	 *  running-context entry off this. */
	startSession(): void {
		this.sessionKey = crypto.randomUUID();
	}

	/** Wipe the pipeline's conversation-derived state: the per-agent action buffers,
	 *  the review-flags store, and the live activity feed. Paired with the lexicon
	 *  delete (Settings → delete memory) so a memory wipe leaves no shadow copy of
	 *  conversation content in IndexedDB — the buffers + flags both hold verbatim
	 *  transcript-derived text and are re-injected into future pipeline prompts. */
	async reset(): Promise<void> {
		this.buffers = { audit: [], memory: [], summary: [] };
		this.flags = [];
		this.activity.length = 0;
		await this.persist();
		this.deps.onActivity();
	}

	/** Append a review flag, rolling-capped so the store can't grow without bound. */
	private addFlag(f: ReviewFlag): void {
		this.flags.push(f);
		if (this.flags.length > FLAGS_MAX_ENTRIES) {
			this.flags = this.flags.slice(-FLAGS_MAX_ENTRIES);
		}
	}

	/** The human-review flags the audit agent raised, newest first — surfaced in the
	 *  Memory settings tab so they're not a write-only store nobody ever reads. */
	getFlags(): ReviewFlag[] {
		return [...this.flags].reverse();
	}

	getSttLexicon(): SttLexicon {
		return this.sttLexicon;
	}

	getRunningContext(): RunningContextEntry[] {
		return this.runningContext;
	}

	/** The band-1 block injected into the MAIN agent's system prompt: entries
	 *  from prior conversations, newest first. Empty string when none. */
	runningContextBlock(): string {
		const prior = this.runningContext.filter((e) => e.sessionKey !== this.sessionKey);
		if (!prior.length) return "";
		const lines = prior.map((e) => `### ${e.ts.slice(0, 10)}\n${e.text}`);
		return `\n\n## Running context (what you remember from recent conversations)\n${lines.join("\n\n")}`;
	}

	setRunningContext(entries: RunningContextEntry[]): void {
		this.runningContext = entries;
	}

	setSttLexicon(lex: SttLexicon): void {
		this.sttLexicon = lex;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** The per-turn trigger. Coalesces: a turn ending mid-tick queues exactly one
	 *  follow-up tick (the most recent turn-end wins). The transcript + sessionKey are
	 *  SNAPSHOTTED here, at trigger time — not re-read when the tick runs — so a tick
	 *  can never bind to a conversation the user switched to after this turn ended. */
	onTurnEnd(getMessages: () => AgentMessage[], isVoiceTurn: boolean): void {
		const input: TickInput = {
			messages: [...getMessages()],
			isVoiceTurn,
			sessionKey: this.sessionKey,
		};
		if (this.running) {
			this.queued = input;
			return;
		}
		this.tick(input).catch((e) => dbgError("pipeline tick failed:", e));
	}

	async persist(): Promise<void> {
		const b = this.deps.backend;
		try {
			await b.set(PIPELINE_STORE, KEY_BUFFERS, this.buffers);
			await b.set(PIPELINE_STORE, KEY_STT, this.sttLexicon);
			await b.set(PIPELINE_STORE, KEY_FLAGS, this.flags);
			await b.set(PIPELINE_STORE, KEY_RUNNING_CONTEXT, this.runningContext);
		} catch (err) {
			dbgError("pipeline state save failed:", err);
		}
	}

	// -- internals --------------------------------------------------------------

	private renderBuffer(agent: PipelineAgentName): string {
		const entries = this.buffers[agent] ?? [];
		if (!entries.length) return "(no prior actions)";
		const lines: string[] = [];
		for (const e of entries) {
			const when = e.ts.slice(0, 16).replace("T", " ");
			for (const a of e.actions) lines.push(`- [${when}] ${a}`);
			if (e.note && e.note !== NO_ACTION_SENTINEL) lines.push(`- [${when}] note: ${e.note}`);
		}
		return lines.join("\n");
	}

	private appendBuffer(agent: PipelineAgentName, actions: string[], note: string): void {
		if (!actions.length && (!note || note === NO_ACTION_SENTINEL)) return;
		(this.buffers[agent] ??= []).push({ ts: new Date().toISOString(), actions, note });
		if (this.buffers[agent].length > BUFFER_MAX_ENTRIES) {
			this.buffers[agent] = this.buffers[agent].slice(-BUFFER_MAX_ENTRIES);
		}
	}

	private pushActivity(agent: PipelineAgentName, line: string): void {
		this.activity.push({ ts: new Date().toISOString(), agent, line });
		if (this.activity.length > ACTIVITY_MAX_ITEMS) {
			this.activity.splice(0, this.activity.length - ACTIVITY_MAX_ITEMS);
		}
		this.deps.onActivity();
	}

	/** Run one tooled pipeline agent via runAgentLoop. Returns its recorded
	 *  action lines + final note; token usage is folded + logged. */
	private async runTooledAgent(
		name: PipelineAgentName,
		transcript: string,
		instructions: string,
	): Promise<void> {
		const actions: string[] = [];
		const tools = createPipelineTools({
			getGraph: this.deps.getGraph,
			embed: this.deps.embed,
			getSttLexicon: () => this.sttLexicon,
			addFlag: (f) => this.addFlag(f),
			record: (line) => {
				actions.push(line);
				this.pushActivity(name, line);
			},
		});

		const content =
			`## Conversation transcript\n\n${transcript}\n\n---\n\n${instructions}` +
			(name === "memory"
				? `\n\n## Current memory\n\n${dumpExistingContext(this.deps.getGraph())}`
				: "");

		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), AGENT_TIMEOUT_MS);
		let turns = 0;
		try {
			const messages = await runAgentLoop(
				[{ role: "user", content, timestamp: Date.now() } as AgentMessage],
				{ systemPrompt: PIPELINE_SYSTEM_STUB, messages: [], tools },
				{
					model: this.deps.getModel(),
					convertToLlm: defaultConvertToLlm,
					apiKey: this.deps.getAuth(),
					// Think, at effort — async, so latency is free (see PIPELINE_THINKING).
					reasoning: PIPELINE_THINKING,
					shouldStopAfterTurn: () => ++turns >= AGENT_MAX_TURNS,
				},
				() => {}, // no-op event sink — headless
				abort.signal,
			);

			// Usage: sum over the loop's assistant messages; fold into the visible
			// session cost and log the per-agent instrumentation line.
			let pIn = 0;
			let pOut = 0;
			let note = "";
			for (const m of messages) {
				if ((m as { role: string }).role !== "assistant") continue;
				const u = (m as { usage?: { input?: number; output?: number } }).usage;
				pIn += u?.input ?? 0;
				pOut += u?.output ?? 0;
				const c = (m as { content?: unknown }).content;
				if (Array.isArray(c)) {
					const texts = c
						.filter((b): b is { type: string; text?: string } => !!b && typeof b === "object")
						.filter((b) => b.type === "text")
						.map((b) => b.text ?? "");
					if (texts.length) note = texts.join(" ").trim();
				}
			}
			this.deps.addCost(pIn, pOut);
			dbg(`pipeline[${name}]: ${pIn}p/${pOut}c tok, ${actions.length} action(s), note="${note.slice(0, 120)}"`);
			this.appendBuffer(name, actions, note);
		} finally {
			clearTimeout(timer);
		}
	}

	private async runSummaryAgent(transcript: string, sessionKey: string): Promise<void> {
		const prior = this.runningContext.filter((e) => e.sessionKey !== sessionKey);
		const priorBlock = prior.length
			? prior.map((e) => `### ${e.ts.slice(0, 10)}\n${e.text}`).join("\n\n")
			: "(no prior conversations yet)";

		const completion = makeCompletion({
			baseUrl: this.deps.getBaseUrl(),
			model: this.deps.getModelId(),
			apiKey: this.deps.getAuth(),
			reasoningEffort: MYRIAPOD_REASONING_EFFORT, // raw wire effort (Kimi: "max"); async → think for quality
			onUsage: ({ promptTokens, completionTokens }) => {
				this.deps.addCost(promptTokens, completionTokens);
				dbg(`pipeline[summary]: ${promptTokens}p/${completionTokens}c tok`);
			},
		});

		// Same hard wall as the tooled agents: a hung completion must not wedge the
		// pipeline (leaving this.running = true) for the rest of the session.
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), AGENT_TIMEOUT_MS);
		let raw: string;
		try {
			raw = await completion(
				[
					{ role: "system", content: PIPELINE_SYSTEM_STUB },
					{
						role: "user",
						content: `## Conversation transcript\n\n${transcript}\n\n---\n\n${buildSummaryInstructions(priorBlock)}`,
					},
				],
				abort.signal,
			);
		} finally {
			clearTimeout(timer);
		}
		const entry = raw.trim();
		if (!entry || entry.includes(NO_ENTRY_SENTINEL)) return;

		// Rewrite-not-append: replace this session's entry, newest first.
		const now = new Date().toISOString();
		const existing = this.runningContext.find((e) => e.sessionKey === sessionKey);
		if (existing) {
			existing.text = entry;
			existing.ts = now;
		} else {
			this.runningContext.unshift({ sessionKey, ts: now, text: entry });
		}
		// Rolling word cap: keep newest entries until the budget is spent.
		let words = 0;
		const kept: RunningContextEntry[] = [];
		for (const e of this.runningContext) {
			words += e.text.split(/\s+/).length;
			if (words > RUNNING_CONTEXT_MAX_WORDS && kept.length) break;
			kept.push(e);
		}
		this.runningContext = kept;
		this.pushActivity("summary", "updated conversation summary");
	}

	private async tick(input: TickInput): Promise<void> {
		const { isVoiceTurn } = input;
		const tickStart = performance.now();
		// running + the state repaint go INSIDE the try: if onStateChange throws (it
		// drives a DOM refresh), the finally still resets running, so a repaint fault
		// can't wedge the pipeline for the rest of the session.
		this.running = true;
		try {
			this.deps.onStateChange("running");
			const transcript = formatTranscript(input.messages);
			if (!transcript.trim()) return;

			// Summary runs in parallel with the serial audit → memory pair. It writes under
			// the tick's captured sessionKey (not the live one) so a New Chat mid-tick can't
			// misattribute this conversation's summary.
			const summaryP = this.runSummaryAgent(transcript, input.sessionKey).catch((err) =>
				dbgError("pipeline[summary] failed (non-fatal):", err),
			);

			try {
				await this.runTooledAgent(
					"audit",
					transcript,
					buildAuditInstructions({ bufferBlock: this.renderBuffer("audit"), isVoiceTurn }),
				);
			} catch (err) {
				dbgError("pipeline[audit] failed (non-fatal):", err);
			}

			try {
				await this.runTooledAgent(
					"memory",
					transcript,
					buildMemoryManagerInstructions({
						bufferBlock: this.renderBuffer("memory"),
						isVoiceTurn,
					}),
				);
			} catch (err) {
				dbgError("pipeline[memory] failed (non-fatal):", err);
			}

			await summaryP;

			// Consent can be revoked mid-tick (it's only checked at the trigger). Re-check
			// right before persisting so an opt-out isn't followed seconds later by a write.
			// Absent dep → undefined → treat as granted (don't break if wiring order differs).
			const consent = this.deps.getConsent?.();
			if (consent === undefined || consent === "granted") {
				await this.deps.saveGraph();
				await this.persist();
			} else {
				dbg("pipeline: consent revoked mid-tick — skipping memory writes");
			}
			dbg(`pipeline tick done in ${Math.round(performance.now() - tickStart)}ms`);
		} finally {
			this.running = false;
			// Drain the coalesced follow-up FIRST, then repaint: a throw from the idle
			// repaint must not strand a queued turn's memory update. The idle callback is
			// itself guarded so it can't take down the tick.
			const q = this.queued;
			this.queued = null;
			try {
				this.deps.onStateChange("idle");
			} catch (err) {
				dbgError("pipeline onStateChange(idle) failed:", err);
			}
			if (q) {
				this.tick(q).catch((e) => dbgError("pipeline tick failed:", e));
			}
		}
	}
}
