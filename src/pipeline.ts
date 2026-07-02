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

// The async pipeline agents THINK — unlike the frontend chat agent (thinking off
// for spoken snappiness), these run in the background where latency is free, so
// they reason for quality (the whole point of moving the memory workload async).
// GLM 5.2 exposes only two thinking tiers: "high" and "max" (max = xhigh, the
// default, recommended by Z.ai for hard coding/architecture). There is NO
// low/medium. "high" is the lighter tier — plenty for tending memory, and it
// avoids max's token blowout. Bump to "xhigh" only if judgment quality demands it.
const PIPELINE_THINKING = "high" as const;

const BUFFER_MAX_ENTRIES = 30; // per agent, rolling
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
	private queued: { getMessages: () => AgentMessage[]; isVoiceTurn: boolean } | null = null;

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
		// Seed the activity feed with the tail of past actions so the gutter isn't
		// empty on load.
		const seeded: ActivityItem[] = [];
		for (const agent of Object.keys(this.buffers) as PipelineAgentName[]) {
			for (const entry of this.buffers[agent]) {
				for (const line of entry.actions) seeded.push({ ts: entry.ts, agent, line });
			}
		}
		seeded.sort((a, b) => (a.ts < b.ts ? -1 : 1));
		this.activity.push(...seeded.slice(-ACTIVITY_MAX_ITEMS));
	}

	/** A new conversation began (createAgent). The summary agent keys its
	 *  running-context entry off this. */
	startSession(): void {
		this.sessionKey = crypto.randomUUID();
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
	 *  follow-up tick, which reads the LATEST transcript when it runs. */
	onTurnEnd(getMessages: () => AgentMessage[], isVoiceTurn: boolean): void {
		if (this.running) {
			this.queued = { getMessages, isVoiceTurn };
			return;
		}
		void this.tick(getMessages, isVoiceTurn);
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
			addFlag: (f) => this.flags.push(f),
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

	private async runSummaryAgent(transcript: string): Promise<void> {
		const prior = this.runningContext.filter((e) => e.sessionKey !== this.sessionKey);
		const priorBlock = prior.length
			? prior.map((e) => `### ${e.ts.slice(0, 10)}\n${e.text}`).join("\n\n")
			: "(no prior conversations yet)";

		const completion = makeCompletion({
			baseUrl: this.deps.getBaseUrl(),
			model: this.deps.getModelId(),
			apiKey: this.deps.getAuth(),
			reasoningEffort: PIPELINE_THINKING, // async agent → think for quality
			onUsage: ({ promptTokens, completionTokens }) => {
				this.deps.addCost(promptTokens, completionTokens);
				dbg(`pipeline[summary]: ${promptTokens}p/${completionTokens}c tok`);
			},
		});

		const raw = await completion([
			{ role: "system", content: PIPELINE_SYSTEM_STUB },
			{
				role: "user",
				content: `## Conversation transcript\n\n${transcript}\n\n---\n\n${buildSummaryInstructions(priorBlock)}`,
			},
		]);
		const entry = raw.trim();
		if (!entry || entry.includes(NO_ENTRY_SENTINEL)) return;

		// Rewrite-not-append: replace this session's entry, newest first.
		const now = new Date().toISOString();
		const existing = this.runningContext.find((e) => e.sessionKey === this.sessionKey);
		if (existing) {
			existing.text = entry;
			existing.ts = now;
		} else {
			this.runningContext.unshift({ sessionKey: this.sessionKey, ts: now, text: entry });
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

	private async tick(getMessages: () => AgentMessage[], isVoiceTurn: boolean): Promise<void> {
		this.running = true;
		this.deps.onStateChange("running");
		const tickStart = performance.now();
		try {
			const transcript = formatTranscript(getMessages());
			if (!transcript.trim()) return;

			// Summary runs in parallel with the serial audit → memory pair.
			const summaryP = this.runSummaryAgent(transcript).catch((err) =>
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

			await this.deps.saveGraph();
			await this.persist();
			dbg(`pipeline tick done in ${Math.round(performance.now() - tickStart)}ms`);
		} finally {
			this.running = false;
			this.deps.onStateChange("idle");
			if (this.queued) {
				const q = this.queued;
				this.queued = null;
				void this.tick(q.getMessages, q.isVoiceTurn);
			}
		}
	}
}
