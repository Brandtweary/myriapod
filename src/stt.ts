// stt.ts — the batch speech-to-text half of a browser-orchestrated voice cascade.
//
// This is a self-contained module: a PCM mic recorder (PART 1) and a Whisper STT
// HTTP client (PART 2), wrapped in a minimal orchestrator-facing API. It exists to
// replace the server-side Unmute STT leg with browser-local capture + a direct POST
// to a self-hosted faster-whisper ASR endpoint, so the browser owns the
// STT → … → TTS cascade end to end.
//
// PART 1 (PcmRecorder): captures one utterance of mic audio as 24kHz mono Float32
// PCM. Capture runs through an AudioWorklet (public/pcm-recorder-processor.js); the
// native-rate mono chunks are accumulated on the main thread and resampled to 24kHz
// when the utterance ends.
//
// PART 2 (WhisperClient): a stateless HTTP client. Per utterance it resamples the
// 24kHz PCM to 16kHz, encodes a 16-bit mono WAV, and POSTs it as multipart/form-data
// to a faster-whisper-server ASR endpoint, which returns `{"text":...}` JSON. No
// socket, no marker protocol, no msgpack — connect()/close() are no-ops.
//
// Uses the project's dbg/dbgWarn instrumentation rather than bare console.

import { dbg, dbgWarn } from "./debug.js";

// === Configuration ===========================================================

// The Whisper ASR HTTP endpoint. Override via VITE_STT_BASE for deploy.
const DEFAULT_STT_URL =
	import.meta.env.VITE_STT_BASE ?? "http://localhost:8123/api/asr-http";

// The recorder emits 24kHz f32 mono PCM (PART 1 resamples to this rate).
const STT_SAMPLE_RATE = 24000;
// Whisper expects 16kHz mono 16-bit PCM; we resample down before encoding the WAV.
const WHISPER_SAMPLE_RATE = 16000;
// Per-request hard ceiling. Whisper is ~0.4s warm; this only guards a wedged server.
const TRANSCRIBE_TIMEOUT_MS = 30_000;

// === PART 2: Whisper STT HTTP client =========================================

export interface SttClientOptions {
	// The ASR HTTP endpoint. Defaults to VITE_STT_BASE.
	url?: string;
}

/**
 * A stateless Whisper STT client.
 *
 * HTTP is connectionless, so `connect()`/`close()` are no-ops kept only for API
 * parity with the orchestrator's lifecycle calls. Each `transcribe(pcm)` is one
 * independent request: resample 24kHz → 16kHz, encode a 16-bit mono WAV, POST it as
 * multipart/form-data, and return the server's `{"text"}`.
 */
export class WhisperClient {
	private readonly url: string;

	constructor(opts: SttClientOptions = {}) {
		this.url = opts.url ?? DEFAULT_STT_URL;
	}

	/** No-op — HTTP is stateless (no socket to open). */
	connect(): Promise<void> {
		return Promise.resolve();
	}

	/**
	 * Transcribe one utterance. Resamples `pcm` (24kHz mono f32) to 16kHz, encodes a
	 * 16-bit mono WAV, and POSTs it to the Whisper endpoint as multipart/form-data.
	 * Returns the trimmed transcript. Rejects on a non-2xx response or a timeout.
	 */
	async transcribe(pcm: Float32Array): Promise<string> {
		dbg(
			`[stt] transcribe: ${pcm.length} samples ` +
				`(${(pcm.length / STT_SAMPLE_RATE).toFixed(2)}s)`,
		);

		const pcm16k = resampleLinear(pcm, STT_SAMPLE_RATE, WHISPER_SAMPLE_RATE);
		const wav = encodeWav(pcm16k, WHISPER_SAMPLE_RATE);

		const form = new FormData();
		form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
		form.append("response_format", "json");

		const res = await fetch(this.url, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
		});
		if (!res.ok) {
			throw new Error(`stt: server returned ${res.status} ${res.statusText}`);
		}
		const data = (await res.json()) as { text?: string };
		const text = (data.text ?? "").trim();
		dbg(`[stt] transcript: "${text}"`);
		return text;
	}

	/** No-op — there is no socket to close. Kept for lifecycle parity. */
	close(): void {
		/* stateless — nothing to tear down */
	}
}

// Encode mono 16kHz Float32 PCM as a 16-bit little-endian WAV (44-byte header +
// PCM data). Samples are clamped to [-1, 1] then scaled to the Int16 range. No
// library — a plain DataView writes the RIFF/fmt/data chunks.
function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
	const numChannels = 1;
	const bitsPerSample = 16;
	const bytesPerSample = bitsPerSample / 8;
	const blockAlign = numChannels * bytesPerSample;
	const byteRate = sampleRate * blockAlign;
	const dataSize = pcm.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};

	// RIFF header.
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true); // chunk size = file size - 8
	writeStr(8, "WAVE");
	// fmt subchunk.
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true); // PCM fmt chunk size
	view.setUint16(20, 1, true); // audio format = 1 (PCM)
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	// data subchunk.
	writeStr(36, "data");
	view.setUint32(40, dataSize, true);

	let offset = 44;
	for (let i = 0; i < pcm.length; i++) {
		const s = Math.max(-1, Math.min(1, pcm[i]));
		view.setInt16(offset, Math.round(s * 32767), true);
		offset += 2;
	}
	return buffer;
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
 * utterance resampled to 24kHz — the format `WhisperClient.transcribe()` consumes
 * (it resamples down to 16kHz before encoding the WAV).
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

		// Build the capture graph inside a guard: addModule() can throw (CSP/offline/404)
		// AFTER the AudioContext (and, if we opened it, the mic stream) already exist, so
		// on any failure tear everything down before rethrowing — otherwise the context
		// and the owned mic leak.
		try {
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
		} catch (e) {
			this.running = false;
			this.teardown();
			throw e;
		}
	}

	/**
	 * Stop capture and return the full utterance as 24kHz mono Float32 PCM.
	 * Tears down the audio graph; stops the mic only if this recorder opened it.
	 */
	async stop(): Promise<Float32Array> {
		if (!this.running) return new Float32Array(0);

		// Worklet chunks already posted but not yet dispatched to onmessage would be
		// dropped by its `if (!this.running) return` guard if we flipped running now,
		// losing the final few ms of the utterance. Yield one macrotask first — while
		// running is still true — so those queued postMessages land in this.chunks.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
