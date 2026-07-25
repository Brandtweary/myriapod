// tts.ts — the text-to-speech half of the browser-orchestrated voice cascade. The
// Pi agent drives the LLM itself and its streamed text is piped through here to be
// spoken. The speech leg is a batch HTTP call per sentence: each sentence chunk is
// POSTed to the metering proxy's `/v1/audio/speech` route (which injects the owner
// key and forwards to OpenRouter's audio endpoint), and the raw 24 kHz PCM bytes that
// come back are paced to ~1x realtime and posted into the shared
// audio-output-processor worklet — no decode, no WebSocket, no msgpack.
//
// One request per sentence is what keeps latency ≈ streaming: the SentenceChunker
// (PART 1) splits the reply as it generates, so the first sentence is spoken while the
// rest is still being produced, and while sentence N plays its PCM the fetch for
// sentence N+1 is already in flight. The upstream returns a whole sentence's PCM in one
// response; the pacing queue (scheduleFrame) releases those frames at ~1x so the
// worklet's FIFO stays near-empty and playback across sentences is gapless.
//
// Three parts:
//   1. SentenceChunker — buffers LLM text tokens, flushes sentence-sized chunks.
//   2. CloudTtsSynthesizer — the per-sentence /audio/speech client + PCM playback.
//   3. SpeechSynthesizer — the swappable interface.
//
// The orchestrator owns the AudioContext (created at 24 kHz to match the PCM sample
// rate so no resampling is needed) and the audio-output-processor worklet, passing the
// worklet in so playback is shared with the rest of the app.

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

// The synthesizer seam: CloudTtsSynthesizer implements this; a future alternate
// backend could implement the same shape, so the orchestrator can swap synthesizers
// without caring which is live.
export interface SpeechSynthesizer {
	// Streaming: pipe LLM tokens → chunker → per-sentence /audio/speech.
	speak(textStream: AsyncIterable<string>): Promise<void>;
	// One-shot: synthesize a whole, already-complete string.
	speak(fullText: string): Promise<void>;
	// Barge-in: cut audio immediately (reset the playback worklet + abort in-flight fetch).
	stop(): void;
}

export interface TtsConfig {
	// Override the /audio/speech endpoint (else VITE_TTS_BASE / the localhost default).
	baseUrl?: string;
	// Voice id, forwarded to the proxy. Empty → the proxy's server-side default voice
	// (the browser can only pick a voice the forced upstream model exposes).
	voice?: string;
	// Fired (at most once per synth) when a whole run() produced zero audio bytes —
	// i.e. the text rendered but nothing spoke (backend unreachable/failing all turn).
	// The orchestrator wires this to a user-facing notice; unset = silent (default).
	onVoiceUnavailable?: () => void;
}

// =============================================================================
// PART 2 — cloud TTS client (batch /audio/speech, per sentence)
// =============================================================================

const ENV = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};

// The /audio/speech endpoint. Dev points at the local proxy; deploy overrides via
// VITE_TTS_BASE (an https:// URL on the public host, same origin as the proxy).
const DEFAULT_TTS_BASE = ENV.VITE_TTS_BASE ?? "http://127.0.0.1:8790/v1/audio/speech";
// Voice id, forwarded to the proxy. Empty by default → the proxy's server-side
// default voice; override with VITE_TTS_VOICE to pick another voice the upstream
// model exposes.
const DEFAULT_VOICE = ENV.VITE_TTS_VOICE ?? "";

// The upstream returns raw 16-bit LE mono PCM at 24 kHz (response_format "pcm"). The
// shared AudioContext is created at this rate (see main.ts) so frames play without
// any resampling.
export const TTS_SAMPLE_RATE = 24000;

// A whole sentence's PCM arrives in one response; it's sliced into frames of this many
// samples before pacing, so the drain timer has fine-enough granularity to release
// audio at ~1x realtime (80 ms per frame at 24 kHz).
const FRAME_SAMPLES = 1920;

// Ceiling on how long one sentence's /audio/speech fetch may take before it's
// abandoned so the loop advances to the next sentence. OpenRouter caps audio upstreams
// at 60 s; a sentence synthesizes in well under that.
const SPEECH_FETCH_TIMEOUT_MS = 60_000;

// The upstream returns a whole sentence's PCM in one response, faster than realtime.
// The playback worklet's FIFO is sized for ~1x realtime input; fed a whole reply's PCM
// at once it overflows its 30s cap and collapses to an 80ms cap, shredding most of the
// audio. So we pace: hold each frame and release it to the worklet at its playout
// position minus a small lookahead, keeping the worklet at ~1x and its buffer
// near-empty. The pace clock spans the whole utterance (across the per-sentence
// fetches), so a sentence keeps playing while the next one is being fetched — gapless.
const PLAYBACK_LOOKAHEAD_MS = 300;
const DRAIN_INTERVAL_MS = 15;

export class CloudTtsSynthesizer implements SpeechSynthesizer {
	// AbortController for the in-flight sentence fetch, so stop() cancels it promptly.
	private inflight?: AbortController;
	// Set by stop(); checked throughout run() so a barge-in unwinds promptly.
	private aborted = false;
	// Whether any audio arrived during the current run() (reset per run).
	private sawAudio = false;
	// One-shot latch so the "voice unavailable" signal fires at most once per synth.
	private voiceUnavailableNotified = false;
	// Monotonic run epoch. Each run() and stop() bumps it so a superseded run's
	// still-decoding sentence can't leak audio into the shared worklet: the loop and
	// the frame scheduler both check their captured gen against the current one.
	private gen = 0;

	// Realtime pacing state (see PLAYBACK_LOOKAHEAD_MS). A sentence's PCM frames are
	// queued here with a scheduled release time instead of posting to the worklet on
	// arrival; a timer drains the queue to the worklet at ~1x realtime. The play
	// clock spans the whole utterance (across the per-sentence fetches), so it is
	// reset only at the start of a run() and on stop().
	private paceQueue: Array<{ releaseAt: number; frame: Float32Array }> = [];
	private paceCumulativeSamples = 0;
	private paceClockStart = 0;
	private paceTimer: ReturnType<typeof setInterval> | undefined;

	// The orchestrator passes its audio-output-processor worklet; PCM frames are paced
	// into it (see scheduleFrame). No decoder to own.
	constructor(
		private outputWorklet: AudioWorkletNode,
		private config: TtsConfig = {},
	) {}

	// Overload dispatch: a string is the one-shot path, an AsyncIterable is the
	// streaming path.
	speak(input: AsyncIterable<string>): Promise<void>;
	speak(input: string): Promise<void>;
	speak(input: AsyncIterable<string> | string): Promise<void> {
		return typeof input === "string" ? this.speakText(input) : this.speakStream(input);
	}

	// Streaming: token stream → chunker → per-sentence /audio/speech. Synthesis of the
	// next sentence overlaps playback of the current one.
	speakStream(textStream: AsyncIterable<string>): Promise<void> {
		return this.run(chunkStream(textStream));
	}

	// One-shot: a whole string, chunked then spoken sentence by sentence.
	speakText(fullText: string): Promise<void> {
		return this.run(asyncFrom(chunkText(fullText)));
	}

	// Barge-in: cut audio immediately. Clears the worklet's frame buffer and aborts the
	// in-flight sentence fetch so no further frames arrive. Cheap to call when idle.
	stop(): void {
		this.aborted = true;
		// Bump the epoch so any run still unwinding is now stale: a late fetch's frames
		// are dropped by the gen guard instead of leaking into the worklet.
		this.gen++;
		this.resetPacing();
		try {
			this.outputWorklet.port.postMessage({ type: "reset" });
		} catch (err) {
			dbg(`[tts] stop: worklet reset ${String(err)}`);
		}
		try {
			this.inflight?.abort();
		} catch {
			/* already settled */
		}
		this.inflight = undefined;
		dbg("[tts] stopped (audio cut, fetch aborted)");
	}

	// Teardown for when the synthesizer is discarded for good (not part of the
	// swappable interface). stop() already clears the pacing timer + aborts the fetch.
	dispose(): void {
		this.stop();
	}

	// Speak each sentence chunk in turn: POST it to /audio/speech, pace the returned
	// PCM into the shared worklet, and move to the next. Fetch of sentence N+1 overlaps
	// playback of sentence N (the pace clock spans the whole utterance), so playback is
	// gapless. Resolves once every chunk has been fetched (audio may still be draining).
	private async run(chunks: AsyncIterable<string>): Promise<void> {
		// A new utterance supersedes any in-flight one: bump the epoch so a prior run's
		// late fetch is stale (its frames are dropped by the gen guard), and capture our
		// gen so the loop notices a still-newer utterance superseding us mid-flight.
		const myGen = ++this.gen;
		this.aborted = false;
		this.sawAudio = false;
		this.resetPacing();

		let attempted = false;
		try {
			for await (const chunk of chunks) {
				// A newer utterance (or stop()) bumped the epoch — abandon this stale loop.
				if (this.aborted || myGen !== this.gen) break;
				const text = chunk.trim();
				if (!text) continue;
				attempted = true;
				await this.fetchSentence(text, myGen);
			}
		} catch (err) {
			dbgError(`[tts] speak loop error: ${String(err)}`);
		}

		// If we sent at least one sentence but not a single audio byte ever came back,
		// the text rendered silently (backend unreachable/failing all turn) — surface a
		// one-shot signal so the failure isn't invisible. Suppressed on abort/supersede.
		if (
			attempted &&
			!this.sawAudio &&
			!this.aborted &&
			myGen === this.gen &&
			!this.voiceUnavailableNotified
		) {
			this.voiceUnavailableNotified = true;
			dbgWarn("[tts] no audio this turn; TTS may be unavailable");
			try {
				this.config.onVoiceUnavailable?.();
			} catch (err) {
				dbgWarn(`[tts] onVoiceUnavailable callback threw: ${String(err)}`);
			}
		}
	}

	// POST one sentence to /audio/speech and pace the returned raw PCM into the worklet.
	// A transient failure only loses THIS sentence (logged, skipped) rather than
	// abandoning the rest of the reply. The gen check after the await drops audio from a
	// superseded run.
	private async fetchSentence(text: string, myGen: number): Promise<void> {
		const base = this.config.baseUrl ?? DEFAULT_TTS_BASE;
		const voice = this.config.voice ?? DEFAULT_VOICE;
		const controller = new AbortController();
		this.inflight = controller;
		const timer = setTimeout(() => controller.abort(), SPEECH_FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(base, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: text, voice, response_format: "pcm" }),
				signal: controller.signal,
			});
			if (!res.ok) {
				dbgWarn(`[tts] /audio/speech ${res.status}; skipping sentence`);
				return;
			}
			const buf = await res.arrayBuffer();
			// A superseded run (barge-in / newer utterance) must not play — drop the audio.
			if (this.aborted || myGen !== this.gen) return;
			this.enqueuePcm(buf);
			dbg(`[tts] spoke "${text.slice(0, 40)}" (${buf.byteLength} bytes)`);
		} catch (err) {
			// AbortError on barge-in is expected; anything else is a transient loss.
			if (!this.aborted) dbgWarn(`[tts] sentence fetch failed: ${String(err)}`);
		} finally {
			clearTimeout(timer);
			if (this.inflight === controller) this.inflight = undefined;
		}
	}

	// Convert a raw 16-bit LE mono PCM buffer to Float32 and slice it into fixed-size
	// frames, each queued for paced release. Little-endian is the wire format the
	// upstream emits (audio/pcm;rate=24000;channels=1).
	private enqueuePcm(buf: ArrayBuffer): void {
		const int16 = new Int16Array(buf.byteLength % 2 === 0 ? buf : buf.slice(0, buf.byteLength - 1));
		if (!int16.length) return;
		this.sawAudio = true;
		for (let off = 0; off < int16.length; off += FRAME_SAMPLES) {
			const end = Math.min(off + FRAME_SAMPLES, int16.length);
			const frame = new Float32Array(end - off);
			for (let i = off; i < end; i++) frame[i - off] = int16[i] / 32768;
			this.scheduleFrame(frame);
		}
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
}

// Wrap a synchronous array as an AsyncIterable so the one-shot path can reuse
// the same streaming run() loop.
async function* asyncFrom<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}
