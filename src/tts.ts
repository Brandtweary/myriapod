// tts.ts — the streaming text-to-speech half of the browser-orchestrated voice
// cascade. Unlike the old server-side Unmute cascade (one WebSocket carrying
// STT→LLM→TTS), this module is a *standalone* TTS leg: the Pi agent drives the
// LLM itself and its streamed text is piped through here to be spoken. It talks
// directly to a Kyutai moshi-server `/api/tts_streaming` endpoint (msgpack over a
// WebSocket), requesting raw 24 kHz PCM frames (PcmMessagePack) that are paced to ~1x
// realtime and posted into the shared audio-output-processor worklet — no Opus decode,
// no Ogg state.
//
// moshi treats one WS session as ONE continuous generation and garbles if you feed
// it several sentences, so each sentence gets its own session. PCM output is what
// makes that safe: an Opus decoder holds per-stream demux state and corrupts when fed
// back-to-back independent Ogg streams, whereas PCM frames are stateless and simply
// queue in the worklet's FIFO in arrival order. moshi bursts that PCM faster than
// realtime, so frames are paced to ~1x before the worklet (see scheduleFrame) — the job
// Unmute's backend used to do; without it the worklet buffer overflows and garbles long
// replies.
//
// Three parts:
//   1. SentenceChunker — buffers LLM text tokens, flushes sentence-sized chunks.
//   2. KyutaiTtsSynthesizer — the moshi TTS WebSocket client + PCM playback.
//   3. SpeechSynthesizer — the swappable interface (cloud-TTS fallbacks later
//      implement the same shape for graceful degradation).
//
// The orchestrator owns the AudioContext (created at 24 kHz to match moshi's PCM so
// no resampling is needed) and the audio-output-processor worklet, passing the worklet
// in so playback is shared with the rest of the app.

import { encode, decode } from "@msgpack/msgpack";
import { dbg, dbgWarn, dbgError } from "./debug.js";

// =============================================================================
// PART 1 — token → sentence chunker
// =============================================================================

// A long clause with no terminal punctuation still has to speak eventually, so
// the buffer force-flushes once it grows past this many characters (cut at the
// last word boundary so we never split a word).
const FLUSH_MAX_CHARS = 200;

// Characters that can trail a sentence terminator and still belong to the same
// chunk: stacked terminators ("?!", "..."), closing quotes and brackets.
const TRAILING_CLOSERS = /[.!?)\]}"'»”’]/;

// Streaming/one-shot sentence chunker. Feed tokens with push(); it returns zero
// or more completed chunks each call. At end of input call flush() for the tail.
//
// Boundaries (in priority order):
//   1. A sentence terminator [.!?] (plus any stacked terminators / closing
//      quotes) FOLLOWED BY whitespace or buffer-end-after-flush. The trailing
//      whitespace requirement is what keeps "3.14" or "v1.2" from splitting
//      mid-token — a decimal's '.' is followed by a digit, not a space.
//   2. A newline (a hard break even without terminal punctuation).
//   3. The long-buffer fallback (FLUSH_MAX_CHARS) so an unterminated run speaks.
//
// Punctuation is DELIBERATELY preserved — moshi enunciates it, and the server
// has already stripped markdown (* _ `). We only trim surrounding whitespace.
export class SentenceChunker {
	private buf = "";

	// Feed a token (or any text fragment). Returns the chunks that completed.
	push(token: string): string[] {
		this.buf += token;
		const out: string[] = [];
		let chunk: string | null;
		while ((chunk = this.extract()) !== null) out.push(chunk);
		return out;
	}

	// Emit whatever remains (end of stream / one-shot tail). Null if empty.
	flush(): string | null {
		const rest = this.buf.trim();
		this.buf = "";
		return rest.length ? rest : null;
	}

	// Pull a single completed chunk off the front of the buffer, or null if no
	// boundary is present yet (wait for more input).
	private extract(): string | null {
		for (let i = 0; i < this.buf.length; i++) {
			const c = this.buf[i];

			if (c === "." || c === "!" || c === "?") {
				// Extend over stacked terminators and trailing closers.
				let j = i + 1;
				while (j < this.buf.length && TRAILING_CLOSERS.test(this.buf[j])) j++;
				// We can only confirm a sentence boundary when we can see what
				// follows the terminator: if it's whitespace, cut. If we've run to
				// the end of the buffer, hold — more tokens may extend it (another
				// terminator, a closing quote, or a decimal digit). The held tail is
				// emitted by flush() at end of stream.
				if (j >= this.buf.length) return null;
				const next = this.buf[j];
				if (next === " " || next === "\n" || next === "\t" || next === "\r") {
					const chunk = this.buf.slice(0, j).trim();
					this.buf = this.buf.slice(j);
					return chunk.length ? chunk : null;
				}
			}

			if (c === "\n") {
				const chunk = this.buf.slice(0, i).trim();
				this.buf = this.buf.slice(i + 1);
				// An empty line yields nothing; keep scanning the remainder.
				return chunk.length ? chunk : this.extract();
			}
		}

		// Long-buffer fallback: no boundary in sight but the clause is long. Cut at
		// the last space before the cap so we don't split a word.
		if (this.buf.length >= FLUSH_MAX_CHARS) {
			const space = this.buf.lastIndexOf(" ", FLUSH_MAX_CHARS);
			const at = space > 0 ? space : FLUSH_MAX_CHARS;
			const chunk = this.buf.slice(0, at).trim();
			this.buf = this.buf.slice(at);
			return chunk.length ? chunk : null;
		}

		return null;
	}
}

// One-shot: split a complete string into speakable chunks (Tier-3 fallback path).
export function chunkText(text: string): string[] {
	const chunker = new SentenceChunker();
	const out = chunker.push(text);
	const tail = chunker.flush();
	if (tail) out.push(tail);
	return out;
}

// Streaming: pipe a token stream through the chunker, yielding chunks as
// boundaries complete (Tier-1 path — overlaps generation with synthesis).
export async function* chunkStream(tokens: AsyncIterable<string>): AsyncIterable<string> {
	const chunker = new SentenceChunker();
	for await (const tok of tokens) {
		for (const chunk of chunker.push(tok)) yield chunk;
	}
	const tail = chunker.flush();
	if (tail) yield tail;
}

// =============================================================================
// PART 3 (interface) — the swappable synthesizer seam
// =============================================================================

// The degradation seam: the Tier-1 self-hosted moshi backend implements this,
// and later cloud-TTS fallbacks implement the same shape, so the orchestrator
// can swap synthesizers without caring which is live.
export interface SpeechSynthesizer {
	// Streaming: pipe LLM tokens → chunker → TTS WS (Tier-1 path).
	speak(textStream: AsyncIterable<string>): Promise<void>;
	// One-shot fallback: synthesize a whole, already-complete string (Tier-3 path).
	speak(fullText: string): Promise<void>;
	// Barge-in: cut audio immediately (reset the playback worklet + close the WS).
	stop(): void;
}

export interface TtsConfig {
	// Override the WS endpoint (else VITE_TTS_BASE / the localhost default).
	baseUrl?: string;
	// moshi voice id (a path_on_server). Defaults to the Václav "developer-1" voice.
	voice?: string;
	// Classifier-free-guidance strength.
	cfgAlpha?: number;
	// moshi `public_token` (see the auth caveat below).
	apiKey?: string;
}

// =============================================================================
// PART 2 — Kyutai moshi TTS WebSocket client
// =============================================================================

const ENV = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};

// Dev default points at a local moshi-server. Deploy overrides via VITE_TTS_BASE
// (a wss:// URL on the public host).
const DEFAULT_TTS_BASE = ENV.VITE_TTS_BASE ?? "ws://localhost:8123/api/tts_streaming";
// The "developer-1" (Václav Volhejn) voice — the male voice.
const DEFAULT_VOICE = "unmute-prod-website/developer-1.mp3";
const DEFAULT_CFG_ALPHA = 1.5;

// AUTH: moshi reads the token from the `auth_id` query param when no kyutai-api-key
// header is present; a browser WS can't set headers, so auth_id is the path. Verified
// against moshi-server main.rs (`PyStreamingQuery { auth_id, format, voice }` backs the
// /api/tts_streaming Py module). tts.toml authorized_ids = ["public_token"].
const DEFAULT_API_KEY = "public_token";

// moshi streams PCM at 24 kHz (PcmMessagePack). The shared AudioContext is created at
// this rate (see main.ts) so frames play without any resampling.
export const TTS_SAMPLE_RATE = 24000;

// moshi generates ~3-4x faster than realtime and dumps a whole reply's PCM in a
// burst. The playback worklet's FIFO is sized for ~1x realtime input (the rate
// Unmute's server-side RealtimeQueue used to enforce before we ripped Unmute out);
// fed the raw burst, it overflows its 30s cap on a long reply and collapses to an
// 80ms cap, shredding most of the audio. So we re-add the pacing here: hold each
// frame and release it to the worklet at its playout position minus a small
// lookahead, keeping the worklet at ~1x and its buffer near-empty.
const PLAYBACK_LOOKAHEAD_MS = 300;
const DRAIN_INTERVAL_MS = 15;

// moshi has a startup race — the WS opens before the model is loaded and a
// {type:"Ready"} message is sent. We wait for Ready before sending any text,
// polling up to MAX_READY_CHECKS × READY_CHECK_MS before giving up and sending
// anyway (so a missed/renamed Ready can't wedge the turn forever).
const MAX_READY_CHECKS = 10;
const READY_CHECK_MS = 1000;


// Inbound message shapes (msgpack). We act on Ready + Audio; Text timing
// frames are accepted and ignored for now.
type TtsServerMessage =
	| { type: "Ready" }
	| { type: "Audio"; pcm: number[] }
	| { type: "Text"; text: string; start_s?: number; stop_s?: number }
	| { type: string; [k: string]: unknown };

export class KyutaiTtsSynthesizer implements SpeechSynthesizer {
	private ws?: WebSocket;
	// Per-connection readiness flag (reset on each new socket).
	private ready = false;
	// Resolvers for in-flight waitForReady() sleeps, fired early when Ready lands.
	private readyResolvers: Array<() => void> = [];
	// Set by stop(); checked throughout run() so a barge-in unwinds promptly.
	private aborted = false;
	// Monotonic session epoch. Each socket is stamped with the gen that was current
	// when it opened; a new utterance (run) and stop() both bump it. handleMessage
	// drops every message whose stamp != the current gen, so a stale session's late
	// or buffered Audio/Ready can never reach the pacing queue or flip readiness —
	// this is the load-bearing guard against overlapping sessions.
	private gen = 0;

	// Realtime pacing state (see PLAYBACK_LOOKAHEAD_MS). moshi's frames are queued
	// here with a scheduled release time instead of posting to the worklet on
	// arrival; a timer drains the queue to the worklet at ~1x realtime. The play
	// clock spans the whole utterance (across the per-sentence sessions), so it is
	// reset only at the start of a run() and on stop().
	private paceQueue: Array<{ releaseAt: number; frame: Float32Array }> = [];
	private paceCumulativeSamples = 0;
	private paceClockStart = 0;
	private paceTimer: ReturnType<typeof setInterval> | undefined;

	// The orchestrator passes its audio-output-processor worklet; moshi's PCM frames
	// are paced into it (see scheduleFrame). No decoder to own anymore.
	constructor(
		private outputWorklet: AudioWorkletNode,
		private config: TtsConfig = {},
	) {}

	// Overload dispatch: a string is the one-shot path, an AsyncIterable is the
	// streaming path. Both end with an EOS and resolve when the server is done.
	speak(input: AsyncIterable<string>): Promise<void>;
	speak(input: string): Promise<void>;
	speak(input: AsyncIterable<string> | string): Promise<void> {
		return typeof input === "string" ? this.speakText(input) : this.speakStream(input);
	}

	// Tier-1: token stream → chunker → TTS WS. Synthesis overlaps generation.
	speakStream(textStream: AsyncIterable<string>): Promise<void> {
		return this.run(chunkStream(textStream));
	}

	// Tier-3 fallback: a whole string, chunked then sent + EOS in one go.
	speakText(fullText: string): Promise<void> {
		return this.run(asyncFrom(chunkText(fullText)));
	}

	// Barge-in: cut audio immediately. Clears the worklet's frame buffer and
	// closes the WS so no further frames arrive. Cheap to call when idle.
	stop(): void {
		this.aborted = true;
		// Bump the epoch so any session still unwinding is now stale: its remaining
		// frames are dropped by the gen guard instead of leaking into the worklet.
		this.gen++;
		this.resetPacing();
		try {
			this.outputWorklet.port.postMessage({ type: "reset" });
		} catch (err) {
			dbg(`[tts] stop: worklet reset ${String(err)}`);
		}
		// Release any pending waitForReady() sleep so run() can unwind.
		this.flushReadyResolvers();
		this.closeWs();
		dbg("[tts] stopped (audio cut, WS closed)");
	}

	// Teardown for when the synthesizer is discarded for good (not part of the
	// swappable interface). stop() already clears the pacing timer + WS — there is
	// no decoder worker to terminate.
	dispose(): void {
		this.stop();
	}

	// Open a fresh WS, wait for Ready, stream the chunks as {type:"Text"} frames,
	// signal end-of-input with a null byte, then resolve once the server closes
	// (all audio has been sent — playback may still be draining in the worklet).
	private async run(chunks: AsyncIterable<string>): Promise<void> {
		// A new utterance supersedes any in-flight one: bump the epoch so every prior
		// session is now stale (its frames/Ready are dropped by the gen guard), and
		// capture our gen so the loop below can notice if a still-newer utterance
		// supersedes us mid-flight and stop opening sessions.
		const myGen = ++this.gen;
		this.closeWs();
		this.aborted = false;
		this.resetPacing();

		// moshi concatenates every Text message in a session into ONE generation, and
		// garbles after just a few concatenated sentences — we can't stop it concatenating,
		// so we never give it more than one sentence: each chunk gets its own session
		// (connect → Text → Eos → close). Single sentences synthesize cleanly (the only thing
		// that ever worked). moshi generates faster than realtime, so the paced frame queue
		// (scheduleFrame) stays ahead of playback and a sentence keeps playing while the next
		// session spins up — no audible gap. Generation is serialized per sentence; playback
		// stays continuous.
		try {
			for await (const chunk of chunks) {
				// A newer utterance (or stop()) bumped the epoch — abandon this stale
				// loop so it stops spinning up sessions for a superseded utterance.
				if (this.aborted || myGen !== this.gen) break;
				const session = await this.openSession();
				if (!session) return;
				if (this.aborted || session.ws.readyState !== WebSocket.OPEN) break;
				session.ws.send(encode({ type: "Text", text: chunk }));
				dbg(`[tts] -> Text (${chunk.length} chars)`);
				await this.endSession(session);
			}
		} catch (err) {
			dbgError(`[tts] text stream error: ${String(err)}`);
		}
	}

	// Open a fresh TTS WS, wait for Ready, and return it with a promise that resolves
	// when the server finishes (close / transport error). Null if aborted or the
	// socket never came up.
	private async openSession(): Promise<{ ws: WebSocket; done: Promise<void> } | null> {
		const ws = this.openSocket();
		this.ws = ws;
		const done = new Promise<void>((resolve) => {
			ws.addEventListener("close", () => resolve(), { once: true });
			ws.addEventListener("error", () => resolve(), { once: true });
		});
		await this.waitForReady(ws);
		if (this.aborted || ws.readyState !== WebSocket.OPEN) {
			this.closeWs();
			return null;
		}
		return { ws, done };
	}

	// Signal end-of-input ({type:"Eos"} — matches Unmute's proven TTSClientEosMessage),
	// then wait for the server to finish generating + close so the next session doesn't
	// interleave audio frames into the shared worklet.
	private async endSession(session: { ws: WebSocket; done: Promise<void> }): Promise<void> {
		if (!this.aborted && session.ws.readyState === WebSocket.OPEN) {
			session.ws.send(encode({ type: "Eos" }));
			dbg("[tts] -> Eos");
		}
		await session.done;
	}

	private openSocket(): WebSocket {
		const base = this.config.baseUrl ?? DEFAULT_TTS_BASE;
		const params = new URLSearchParams({
			voice: this.config.voice ?? DEFAULT_VOICE,
			format: "PcmMessagePack",
			cfg_alpha: String(this.config.cfgAlpha ?? DEFAULT_CFG_ALPHA),
			// See the auth caveat above — header isn't settable from a browser WS.
			auth_id: this.config.apiKey ?? DEFAULT_API_KEY,
		});
		const url = `${base}?${params.toString()}`;

		this.ready = false;
		// Stamp the socket with the current epoch so handleMessage can tell, on every
		// inbound frame, whether this session is still the live one.
		const myGen = this.gen;
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		ws.onmessage = (event: MessageEvent) => this.handleMessage(event, myGen);
		ws.onerror = () => dbgWarn("[tts] websocket error");
		dbg(`[tts] connecting → ${base}`);
		return ws;
	}

	// Wait for the server's {type:"Ready"} before sending text. Each iteration
	// sleeps READY_CHECK_MS but is woken early when Ready lands (or on abort /
	// socket close). After MAX_READY_CHECKS we proceed regardless, with a warning.
	private async waitForReady(ws: WebSocket): Promise<void> {
		for (let i = 0; i < MAX_READY_CHECKS; i++) {
			if (this.ready || this.aborted) return;
			if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, READY_CHECK_MS);
				this.readyResolvers.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		if (!this.ready && !this.aborted) {
			dbgWarn("[tts] server not Ready after readiness checks; sending text anyway");
		}
	}

	private handleMessage(event: MessageEvent, gen: number): void {
		// Epoch guard: drop everything from a session whose gen has been superseded by
		// a new utterance or a stop(). A stale socket's onmessage stays bound until it
		// finishes closing and can deliver late/buffered frames; ignoring them here
		// means a stale Audio frame never reaches the pacing queue and a stale Ready
		// never flips this.ready for the live run.
		if (gen !== this.gen) return;
		let msg: TtsServerMessage;
		try {
			msg = decode(new Uint8Array(event.data as ArrayBuffer)) as TtsServerMessage;
		} catch (err) {
			dbgWarn(`[tts] msgpack decode failed: ${String(err)}`);
			return;
		}
		switch (msg.type) {
			case "Ready":
				this.ready = true;
				this.flushReadyResolvers();
				dbg("[tts] <- Ready");
				return;
			case "Audio": {
				// Raw 24 kHz PCM frame (PcmMessagePack). No Opus decoder, no Ogg-stream
				// state — so the per-sentence sessions can't corrupt a shared decoder.
				// The frame is NOT posted to the worklet on arrival: moshi bursts faster
				// than realtime, so we queue it for paced release (see scheduleFrame).
				const pcm = (msg as { pcm?: number[] }).pcm;
				if (!pcm || !pcm.length) return;
				this.scheduleFrame(Float32Array.from(pcm));
				return;
			}
			case "Text":
				// Optional {text,start_s,stop_s} word-timing frame — ignored for now.
				return;
			default:
				return;
		}
	}

	private flushReadyResolvers(): void {
		const resolvers = this.readyResolvers;
		this.readyResolvers = [];
		for (const r of resolvers) r();
	}

	// Clear the pacing queue + timer and reset the play clock. Called at the start
	// of a run() (fresh utterance) and on stop() (barge-in drops queued audio).
	private resetPacing(): void {
		if (this.paceTimer) {
			clearInterval(this.paceTimer);
			this.paceTimer = undefined;
		}
		this.paceQueue = [];
		this.paceCumulativeSamples = 0;
		this.paceClockStart = 0;
	}

	// Queue a PCM frame for paced release instead of posting it straight to the
	// worklet. Each frame is scheduled at its playout position (cumulative samples
	// so far / sample rate) minus PLAYBACK_LOOKAHEAD_MS, so the worklet receives
	// audio at ~1x realtime (plus the lookahead as its initial buffer) and its FIFO
	// never fills. The clock is anchored on the first frame and spans the whole
	// utterance, so the gaps between per-sentence sessions don't reset it.
	private scheduleFrame(frame: Float32Array): void {
		const nowMs = performance.now();
		if (this.paceClockStart === 0) this.paceClockStart = nowMs;
		const releaseAt =
			this.paceClockStart +
			(this.paceCumulativeSamples / TTS_SAMPLE_RATE) * 1000 -
			PLAYBACK_LOOKAHEAD_MS;
		this.paceCumulativeSamples += frame.length;
		this.paceQueue.push({ releaseAt, frame });
		if (!this.paceTimer) {
			this.paceTimer = setInterval(() => this.drainPaceQueue(), DRAIN_INTERVAL_MS);
		}
	}

	// Timer tick: post every frame whose scheduled release time has arrived to the
	// worklet, in order. Stops the timer when the queue empties (a later frame
	// restarts it via scheduleFrame).
	private drainPaceQueue(): void {
		const nowMs = performance.now();
		while (this.paceQueue.length && this.paceQueue[0].releaseAt <= nowMs) {
			const { frame } = this.paceQueue.shift()!;
			try {
				this.outputWorklet.port.postMessage({ frame, type: "audio", micDuration: 0 });
			} catch (err) {
				dbgWarn(`[tts] worklet post failed: ${String(err)}`);
			}
		}
		if (!this.paceQueue.length && this.paceTimer) {
			clearInterval(this.paceTimer);
			this.paceTimer = undefined;
		}
	}

	private closeWs(): void {
		const ws = this.ws;
		if (!ws) return;
		this.ws = undefined;
		ws.onmessage = null;
		ws.onerror = null;
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
			try {
				ws.close();
			} catch {
				/* already closing */
			}
		}
	}
}

// Wrap a synchronous array as an AsyncIterable so the one-shot path can reuse
// the same streaming run() loop.
async function* asyncFrom<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}
