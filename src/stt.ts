// stt.ts — the batch speech-to-text half of a browser-orchestrated voice cascade.
//
// This is a self-contained module: a PCM mic recorder (PART 1) and a moshi STT
// WebSocket client (PART 2), wrapped in a minimal orchestrator-facing API (PART 3).
// It exists to replace the server-side Unmute STT leg with browser-local capture +
// a direct connection to a Kyutai moshi-server ASR endpoint, so the browser owns the
// STT → … → TTS cascade end to end.
//
// PART 1 (PcmRecorder): captures one utterance of mic audio as 24kHz mono Float32
// PCM — the exact format moshi's STT requires. Capture runs through an AudioWorklet
// (public/pcm-recorder-processor.js); the native-rate mono chunks are accumulated on
// the main thread and resampled to 24kHz when the utterance ends.
//
// PART 2 (SttClient): speaks moshi-server's marker-batch ASR protocol over a
// WebSocket. All frames are msgpack-encoded. Audio is streamed up as 0.08s f32
// frames; a per-turn Marker bookends the utterance and its echo signals "transcript
// complete". Verified against the Kyutai moshi-server source (asr-streaming route).
//
// Uses the project's dbg/dbgWarn/dbgError instrumentation rather than bare console.

import { decode, encode } from "@msgpack/msgpack";
import { dbg, dbgError, dbgWarn } from "./debug.js";

// === Configuration ===========================================================

// moshi-server's STT WebSocket. Override via VITE_STT_BASE for deploy.
const DEFAULT_STT_URL = import.meta.env.VITE_STT_BASE ?? "ws://localhost:8123/api/asr-streaming";

// AUTH: moshi-server reads the token from the `auth_id` query param when no
// `kyutai-api-key` request header is present — and a browser WebSocket cannot set
// headers, so the query param is the only path. Verified against moshi-server
// main.rs (`AsrStreamingQuery { auth_id }` + the "tricky to set ws headers in
// javascript so we pass the token via the query" comment). stt.toml authorized_ids
// = ["public_token"].
const DEFAULT_API_KEY = "public_token";
const AUTH_QUERY_PARAM = "auth_id";
const AUTH_VIA_QUERY_PARAM = true;

// moshi STT runs at exactly 24kHz f32 mono — non-negotiable on the server side.
const STT_SAMPLE_RATE = 24000;
// 1920 samples = 0.08s @ 24kHz: moshi's expected audio frame size.
const FRAME_SAMPLES = 1920;
// Keepalive marker id. moshi silently drops a connection idle for 120s; sending a
// throwaway marker every 60s keeps a between-turns socket alive. Negative so it can
// never collide with a real (non-negative) turn marker.
const KEEPALIVE_MARKER_ID = -1;
const KEEPALIVE_INTERVAL_MS = 60_000;
// moshi only echoes a turn Marker after it has processed ~STT_DELAY of audio FOLLOWING
// the marker (its model lookahead). A marker sent with no trailing audio never echoes
// and the turn hangs forever. So after the marker we send a short trailing-silence burst
// (zeros) to flush the lookahead and trigger the echo. ~0.5s is comfortably past moshi's
// delay; the frames stream up instantly, so this is not 0.5s of added latency.
const TRAILING_SILENCE_SEC = 0.5;
// Safety net: if the echo never arrives (server hiccup), resolve with whatever Words did
// land rather than hanging the turn forever.
const TRANSCRIBE_TIMEOUT_MS = 8000;

// === moshi wire types ========================================================
// The subset of the protocol we send/receive. Inbound is decoded loosely (msgpack
// decode returns `unknown`); we narrow on the `type` discriminant.

type ServerMessage =
	| { type: "Ready" }
	| { type: "Word"; text: string; start_time?: number }
	| { type: "EndWord"; stop_time?: number }
	| { type: "Marker"; id: number }
	| { type: "Step"; [k: string]: unknown }
	| { type: "Error"; message?: string };

// === PART 2: moshi STT WebSocket client ======================================

export interface SttClientOptions {
	// The WS endpoint. Defaults to VITE_STT_BASE / localhost:8090.
	url?: string;
	// The kyutai-api-key value. Defaults to "public_token".
	apiKey?: string;
}

// One in-flight utterance: words accumulate here until the matching marker echoes.
interface PendingTurn {
	id: number;
	transcript: string;
	resolve: (transcript: string) => void;
	reject: (err: Error) => void;
	timer?: number; // safety timeout handle (cleared when the turn settles)
}

/**
 * A moshi-server STT client speaking the marker-batch protocol.
 *
 * Lifecycle: `connect()` (opens the WS, resolves on the server's `Ready`), then any
 * number of `transcribe(pcm)` calls (one per utterance), then `close()`. The socket
 * is held open between turns and kept alive with a 60s heartbeat, so consecutive
 * utterances reuse the connection.
 *
 * `transcribe()` is single-flight: one utterance is decoded at a time. Calling it
 * again before the previous resolves rejects the new call (the orchestrator drives
 * turns sequentially).
 */
export class SttClient {
	private ws?: WebSocket;
	private readonly url: string;
	private readonly apiKey: string;
	private ready = false;
	private pending?: PendingTurn;
	private nextMarkerId = 1;
	private keepaliveTimer?: number;
	// Resolvers for the connect() handshake, settled by the `Ready` frame or a
	// pre-Ready error/close.
	private connectResolve?: () => void;
	private connectReject?: (err: Error) => void;

	constructor(opts: SttClientOptions = {}) {
		this.url = opts.url ?? DEFAULT_STT_URL;
		this.apiKey = opts.apiKey ?? DEFAULT_API_KEY;
	}

	// Build the full WS URL, appending the api-key query param when that auth
	// strategy is selected. (Header auth isn't reachable from a browser WebSocket.)
	private buildUrl(): string {
		if (!AUTH_VIA_QUERY_PARAM) return this.url;
		const sep = this.url.includes("?") ? "&" : "?";
		return `${this.url}${sep}${AUTH_QUERY_PARAM}=${encodeURIComponent(this.apiKey)}`;
	}

	/** Open the WebSocket and resolve once the server sends `{type:"Ready"}`. */
	connect(): Promise<void> {
		if (this.ws && this.ready) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;
			let ws: WebSocket;
			try {
				ws = new WebSocket(this.buildUrl());
			} catch (err) {
				reject(new Error(`stt: failed to open WebSocket: ${String(err)}`));
				return;
			}
			ws.binaryType = "arraybuffer";
			this.ws = ws;

			ws.onopen = () => dbg("[stt] websocket open — awaiting Ready");
			ws.onmessage = (ev) => this.handleMessage(ev);
			ws.onerror = () => dbgWarn("[stt] websocket error");
			ws.onclose = (ev) => this.handleClose(ev);
		});
	}

	/**
	 * Transcribe one utterance. Streams `pcm` (24kHz mono f32) up in 1920-sample
	 * Audio frames, sends a unique Marker, then resolves with the concatenated Word
	 * text once that Marker echoes back. Rejects on a server Error, a socket close,
	 * or if another transcription is already in flight.
	 */
	transcribe(pcm: Float32Array): Promise<string> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) {
			return Promise.reject(new Error("stt: not connected (call connect() first)"));
		}
		if (this.pending) {
			return Promise.reject(new Error("stt: a transcription is already in flight"));
		}

		const id = this.nextMarkerId++;
		dbg(`[stt] transcribe: ${pcm.length} samples (${(pcm.length / STT_SAMPLE_RATE).toFixed(2)}s), marker=${id}`);

		return new Promise<string>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				if (!this.pending || this.pending.id !== id) return;
				const turn = this.pending;
				this.pending = undefined;
				dbgWarn(
					`[stt] marker ${id} never echoed in ${TRANSCRIBE_TIMEOUT_MS}ms — resolving with ` +
						`partial transcript: "${turn.transcript}"`,
				);
				turn.resolve(turn.transcript.trim());
			}, TRANSCRIBE_TIMEOUT_MS);
			this.pending = { id, transcript: "", resolve, reject, timer };

			// Stream the audio as 0.08s frames. moshi wants `pcm` as a plain array of
			// f32 numbers; Array.from() materializes each frame's slice.
			for (let off = 0; off < pcm.length; off += FRAME_SAMPLES) {
				const frame = pcm.subarray(off, off + FRAME_SAMPLES);
				this.send({ type: "Audio", pcm: Array.from(frame) });
			}
			// Bookend the utterance, then flush moshi's lookahead with trailing silence so
			// the marker echoes back (a marker with no following audio never echoes — this
			// was the "STT never returns" bug). Its echo means "all words emitted".
			this.send({ type: "Marker", id });
			const silence = new Array<number>(FRAME_SAMPLES).fill(0);
			const silenceFrames = Math.ceil((TRAILING_SILENCE_SEC * STT_SAMPLE_RATE) / FRAME_SAMPLES);
			for (let i = 0; i < silenceFrames; i++) {
				this.send({ type: "Audio", pcm: silence });
			}
		});
	}

	/** Close the socket and reject any in-flight turn. Idempotent. */
	close(): void {
		this.stopKeepalive();
		this.ready = false;
		if (this.pending) {
			if (this.pending.timer !== undefined) clearTimeout(this.pending.timer);
			this.pending.reject(new Error("stt: client closed mid-transcription"));
			this.pending = undefined;
		}
		if (this.ws) {
			this.ws.onclose = null; // deliberate close — don't route through handleClose
			if (
				this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING
			) {
				this.ws.close();
			}
			this.ws = undefined;
		}
		this.settleConnect(new Error("stt: closed before Ready"));
	}

	// --- internals ---

	private send(msg: unknown): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		// forceFloat32 matches Unmute's `use_single_float=True` (speech_to_text.py:134):
		// moshi's Audio.pcm is Vec<f32>, and float32 halves the payload vs the default
		// float64. encode() returns a Uint8Array view over a possibly-larger buffer;
		// slice to the exact bytes so the socket sends only the encoded payload.
		const bytes = encode(msg, { forceFloat32: true });
		this.ws.send(bytes.slice().buffer);
	}

	private handleMessage(ev: MessageEvent): void {
		if (!(ev.data instanceof ArrayBuffer)) {
			dbgWarn("[stt] non-binary message ignored");
			return;
		}
		let msg: ServerMessage;
		try {
			msg = decode(new Uint8Array(ev.data)) as ServerMessage;
		} catch (err) {
			dbgError("[stt] msgpack decode failed:", err);
			return;
		}

		switch (msg.type) {
			case "Ready":
				dbg("[stt] <- Ready");
				this.ready = true;
				this.startKeepalive();
				this.connectResolve?.();
				this.connectResolve = undefined;
				this.connectReject = undefined;
				return;

			case "Word": {
				if (!this.pending) return; // stray word outside a turn (or keepalive) — ignore
				this.pending.transcript = appendWord(this.pending.transcript, msg.text ?? "");
				return;
			}

			case "Marker": {
				// Keepalive echoes (id -1) and any non-matching id are not turn ends.
				if (!this.pending || msg.id !== this.pending.id) return;
				const turn = this.pending;
				this.pending = undefined;
				if (turn.timer !== undefined) clearTimeout(turn.timer);
				dbg(`[stt] <- Marker ${msg.id} (turn complete): "${turn.transcript}"`);
				turn.resolve(turn.transcript.trim());
				return;
			}

			case "Error": {
				const text = msg.message ?? "unknown moshi error";
				dbgError(`[stt] server Error: ${text}`);
				if (this.pending) {
					if (this.pending.timer !== undefined) clearTimeout(this.pending.timer);
					this.pending.reject(new Error(`stt: server error: ${text}`));
					this.pending = undefined;
				}
				this.settleConnect(new Error(`stt: server error before Ready: ${text}`));
				return;
			}

			// Step (per-frame model progress) and EndWord (word-boundary marker) carry
			// no transcript text we need — ignore.
			case "Step":
			case "EndWord":
				return;

			default:
				dbg(`[stt] <- unhandled message type: ${(msg as { type?: string }).type}`);
				return;
		}
	}

	private handleClose(ev: CloseEvent): void {
		dbgWarn(`[stt] websocket closed (code=${ev.code}${ev.reason ? `, reason=${ev.reason}` : ""})`);
		this.stopKeepalive();
		this.ready = false;
		this.ws = undefined;
		if (this.pending) {
			if (this.pending.timer !== undefined) clearTimeout(this.pending.timer);
			this.pending.reject(new Error(`stt: socket closed mid-transcription (code ${ev.code})`));
			this.pending = undefined;
		}
		this.settleConnect(new Error(`stt: socket closed before Ready (code ${ev.code})`));
	}

	// Resolve-or-reject the pending connect() handshake exactly once.
	private settleConnect(err: Error): void {
		this.connectReject?.(err);
		this.connectResolve = undefined;
		this.connectReject = undefined;
	}

	private startKeepalive(): void {
		this.stopKeepalive();
		this.keepaliveTimer = window.setInterval(() => {
			// Only heartbeat when idle — an in-flight turn already keeps traffic flowing,
			// and an extra marker would be harmless but noisy.
			if (this.pending) return;
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.send({ type: "Marker", id: KEEPALIVE_MARKER_ID });
				dbg("[stt] -> keepalive Marker");
			}
		}, KEEPALIVE_INTERVAL_MS);
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer !== undefined) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = undefined;
		}
	}
}

// Concatenate a moshi Word onto the running transcript with sensible spacing:
// punctuation tokens attach directly, everything else gets a separating space.
function appendWord(transcript: string, raw: string): string {
	const word = raw.trim();
	if (!word) return transcript;
	if (!transcript) return word;
	// Leading punctuation (".", ",", "!", "?", ";", ":", closing brackets/quotes)
	// hugs the previous word rather than getting a space.
	if (/^[.,!?;:)\]}'"]/.test(word)) return transcript + word;
	return `${transcript} ${word}`;
}

// === PART 1: PCM mic recorder ================================================

export interface PcmRecorderOptions {
	// Reuse an existing capture stream (e.g. the permission-grant stream from
	// voice.ts's onStart seam). When omitted, the recorder opens its own via
	// getUserMedia. A passed-in stream is NOT stopped by stop() — the caller owns it.
	stream?: MediaStream;
}

/**
 * Captures one utterance of mic audio as 24kHz mono Float32 PCM.
 *
 * `start()` opens the audio graph (mic → AudioWorklet) and begins accumulating
 * native-rate mono chunks; `stop()` tears the graph down and returns the full
 * utterance resampled to 24kHz — exactly the format `SttClient.transcribe()` wants.
 */
export class PcmRecorder {
	private audioContext?: AudioContext;
	private source?: MediaStreamAudioSourceNode;
	private worklet?: AudioWorkletNode;
	private stream?: MediaStream;
	private ownsStream = false;
	private chunks: Float32Array[] = [];
	private nativeRate = 0;
	private running = false;

	constructor(private opts: PcmRecorderOptions = {}) {}

	/** Acquire the mic (if needed), build the capture graph, and start accumulating. */
	async start(): Promise<void> {
		if (this.running) return;
		this.chunks = [];

		// Mono capture with echo cancellation — same constraints as the Unmute
		// opus path, since this drives a speaker-based conversation.
		if (this.opts.stream) {
			this.stream = this.opts.stream;
			this.ownsStream = false;
		} else {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: false,
					autoGainControl: true,
					channelCount: 1,
				},
				video: false,
			});
			this.ownsStream = true;
		}

		const audioContext = new AudioContext();
		this.audioContext = audioContext;
		this.nativeRate = audioContext.sampleRate; // typically 48000
		dbg(`[stt] recorder start: native rate ${this.nativeRate}Hz`);

		const worklet = await getAudioWorkletNode(audioContext, "pcm-recorder-processor");
		worklet.port.onmessage = (ev: MessageEvent) => {
			if (!this.running) return;
			const samples = (ev.data as { samples?: Float32Array }).samples;
			if (samples) this.chunks.push(samples);
		};

		const source = audioContext.createMediaStreamSource(this.stream);
		source.connect(worklet);
		// The recorder worklet writes nothing to its outputs, so connecting it to the
		// destination pulls the graph (the engine only renders nodes on a path to the
		// destination) while playing pure silence — no mic echo.
		worklet.connect(audioContext.destination);

		this.source = source;
		this.worklet = worklet;
		this.running = true;
		await audioContext.resume();
	}

	/**
	 * Stop capture and return the full utterance as 24kHz mono Float32 PCM.
	 * Tears down the audio graph; stops the mic only if this recorder opened it.
	 */
	async stop(): Promise<Float32Array> {
		if (!this.running) return new Float32Array(0);
		this.running = false;

		const merged = concatFloat32(this.chunks);
		this.chunks = [];
		const resampled = resampleLinear(merged, this.nativeRate, STT_SAMPLE_RATE);
		dbg(
			`[stt] recorder stop: ${merged.length} @ ${this.nativeRate}Hz -> ` +
				`${resampled.length} @ ${STT_SAMPLE_RATE}Hz`,
		);

		this.teardown();
		return resampled;
	}

	private teardown(): void {
		try {
			this.source?.disconnect();
		} catch {
			/* already disconnected */
		}
		try {
			this.worklet?.disconnect();
		} catch {
			/* already disconnected */
		}
		if (this.worklet) this.worklet.port.onmessage = null;
		if (this.ownsStream) this.stream?.getTracks().forEach((t) => t.stop());
		void this.audioContext?.close();
		this.source = undefined;
		this.worklet = undefined;
		this.audioContext = undefined;
		this.stream = undefined;
	}
}

// Load (or lazily register) a named AudioWorklet node — same helper as main.ts:
// try to construct first (module already added), fall back to addModule("/name.js").
async function getAudioWorkletNode(
	audioContext: AudioContext,
	name: string,
): Promise<AudioWorkletNode> {
	try {
		return new AudioWorkletNode(audioContext, name);
	} catch {
		await audioContext.audioWorklet.addModule(`/${name}.js`);
		return new AudioWorkletNode(audioContext, name);
	}
}

// Flatten a list of Float32 chunks into one contiguous buffer.
function concatFloat32(chunks: Float32Array[]): Float32Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Float32Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

// Resample mono f32 PCM from `fromRate` to `toRate` with linear interpolation.
// Adequate for 48k→24k speech downsampling (an exact 2:1 decimation here); good
// enough for STT, and the whole utterance is resampled at once.
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (input.length === 0) return input;
	if (fromRate === toRate) return input;

	const ratio = toRate / fromRate;
	const outLength = Math.floor(input.length * ratio);
	const out = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const srcPos = i / ratio;
		const i0 = Math.floor(srcPos);
		const i1 = Math.min(i0 + 1, input.length - 1);
		const frac = srcPos - i0;
		out[i] = input[i0] * (1 - frac) + input[i1] * frac;
	}
	return out;
}
