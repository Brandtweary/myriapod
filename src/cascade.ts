// cascade.ts — browser client for the Kyutai Unmute voice cascade (STT → LLM → TTS).
//
// Speaks Unmute's OpenAI-Realtime dialect over a WebSocket at /v1/realtime
// (subprotocol "realtime"). The mic is captured and Opus-encoded by `opus-recorder`
// and streamed up as `input_audio_buffer.append`; the spoken reply arrives as
// `response.audio.delta` Opus packets which we decode and play through an AudioWorklet.
//
// Two text streams are surfaced via callbacks so the rest of the app can render the
// conversation and drive the KG hooks off the transcript (voice bypasses agent.prompt):
//   - the user's words   → conversation.item.input_audio_transcription.delta
//   - the assistant's words → response.text.delta
//
// The audio pipeline (opus-recorder options, decoder wiring, the output worklet
// message shape) is ported from Unmute's own frontend `useAudioProcessor` so the
// wire format matches byte-for-byte. The Opus codec assets live in public/
// (encoderWorker.min.js, decoderWorker.min.js + .wasm, audio-output-processor.js).

import OpusRecorder from "opus-recorder";
import { dbg } from "./debug.js";

// --- base64 <-> Opus bytes (ported verbatim from Unmute's audioUtil.ts) ---
function base64EncodeOpus(opusData: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < opusData.byteLength; i++) binary += String.fromCharCode(opusData[i]);
	return window.btoa(binary);
}
function base64DecodeOpus(base64String: string): Uint8Array {
	const binaryString = window.atob(base64String);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
	return bytes;
}

export type CascadeState = "idle" | "connecting" | "live" | "closed" | "error";

export type CascadeCallbacks = {
	// Incremental transcript of the user's speech (from the STT).
	onUserTranscript?: (delta: string) => void;
	// Incremental transcript of the assistant's reply (the text the TTS is speaking).
	onAssistantTranscript?: (delta: string) => void;
	// Lifecycle: idle → connecting → live → closed (or error).
	onState?: (state: CascadeState) => void;
	// A pause was detected (server VAD) — the user finished a turn. Optional UI hook.
	onSpeechStopped?: () => void;
	// The assistant began generating a response (the server started the LLM turn).
	onResponseStart?: () => void;
	// The assistant's response text is complete (the turn's answer is fully generated).
	onResponseDone?: () => void;
	onError?: (message: string) => void;
};

export type CascadeConfig = {
	// The realtime WebSocket endpoint. Dev default talks to a local SSH tunnel into
	// the voice stack's traefik; override via VITE_CASCADE_URL for deploy.
	wsUrl?: string;
	// Constant system-prompt text. KG context is appended here at session start.
	instructions?: string;
	// TTS voice id (a path_on_server from Unmute's voices.yaml).
	voice?: string;
};

const ENV = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
// Dev default talks to a local SSH tunnel (port 8123) into the voice stack's
// traefik → backend /api/v1/realtime. Deploy overrides this with a wss:// URL on
// the public host via VITE_CASCADE_URL.
const DEFAULT_WS_URL = ENV.VITE_CASCADE_URL ?? "ws://localhost:8123/api/v1/realtime";
// STUB system prompt — the real web-agent persona hasn't been written yet (TODO).
// Minimal honest description: a personal assistant backed by long-term KG memory.
const DEFAULT_INSTRUCTIONS =
	"You are a personal assistant with a long-term knowledge-graph memory. " +
	"You are spoken to out loud, so keep replies natural and concise.";
// "Dev" voice (Václav Volhejn) from Unmute's voices.yaml — male default; swappable.
const DEFAULT_VOICE = "unmute-prod-website/developer-1.mp3";
// Auto-reconnect backoff: a few attempts with exponential delay, then give up.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;

type AudioPipeline = {
	audioContext: AudioContext;
	opusRecorder: OpusRecorder;
	decoder: Worker;
	outputWorklet: AudioWorkletNode;
};

async function getAudioWorkletNode(audioContext: AudioContext, name: string): Promise<AudioWorkletNode> {
	try {
		return new AudioWorkletNode(audioContext, name);
	} catch {
		await audioContext.audioWorklet.addModule(`/${name}.js`);
		return new AudioWorkletNode(audioContext, name, {});
	}
}

export class CascadeSession {
	private ws?: WebSocket;
	private pipeline?: AudioPipeline;
	private state: CascadeState = "idle";
	private micDuration = 0;
	// Frames produced before the WS is OPEN are buffered here, not dropped: the first
	// OggOpus pages carry the OpusHead/OpusTags header the server needs to initialize
	// its decoder. Dropping them yields a header-less stream the STT can't decode (it
	// transcribes nothing). Flushed in onopen, header-first. (react-use-websocket does
	// this queueing implicitly for Unmute's own frontend; a raw WebSocket does not.)
	private pendingAudio: Uint8Array[] = [];
	// Instrumentation counters (dev): audio frames up, msgs + audio down.
	private audioSent = 0;
	private audioRecv = 0;

	// --- auto-reconnect (single-WS SPOF mitigation) ---
	// One WebSocket carries the whole cascade, so any drop (network blip, backend
	// reload, server hiccup) kills the session. On an UNEXPECTED close we re-open and
	// re-arm in place, keeping the audio pipeline alive — reactive recovery, no timeout
	// guessing. (The common idle-timeout death is prevented upstream by the backend's
	// STT keepalive; this heals the rest.) Intentional closes via stop() set the flag
	// below and skip reconnect. A reconnect mints a fresh backend session, so the
	// in-session chat_history resets — the KG memory survives (it's browser-local).
	private intentionalClose = false;
	private reconnectAttempts = 0;
	private reconnectTimer?: number;
	// Whether the mic recorder is currently running. On reconnect we restart it (when
	// on) so the fresh STT leg gets a new OggOpus header — a mid-stream resume would be
	// header-less and undecodable.
	private recording = false;
	// The latest instructions pushed via updateInstructions (the live KG context),
	// replayed on reconnect so the recovered session keeps the most recent injection.
	private lastInstructions?: string;

	constructor(
		private cb: CascadeCallbacks,
		private config: CascadeConfig = {},
	) {}

	getState(): CascadeState {
		return this.state;
	}

	// Open the cascade: build the audio graph (opus-recorder owns the mic with echo
	// cancellation) and connect the WebSocket. `probeStream` is the permission-grant
	// stream from voice.ts — we release it, since opus-recorder opens its own capture
	// with the right constraints.
	async start(probeStream?: MediaStream): Promise<void> {
		probeStream?.getTracks().forEach((t) => t.stop());
		this.intentionalClose = false;
		this.setState("connecting");
		try {
			await this.setupAudio();
		} catch (err) {
			this.setState("error");
			this.cb.onError?.(`audio setup failed: ${String(err)}`);
			this.teardown();
			return;
		}
		this.openSocket();
	}

	stop(): void {
		this.intentionalClose = true; // suppress reconnect — this close is on purpose
		this.recording = false;
		this.teardown();
		this.setState("closed");
	}

	// Stop the mic recorder WITHOUT touching the conversation: the WebSocket and audio
	// playback stay live, so the bot can still finish or produce a turn (VAD-driven). This
	// is what the mic toggle binds to — "stop recording", not "end conversation".
	stopRecording(): void {
		try {
			this.recording = false;
			this.pipeline?.opusRecorder.stop();
			dbg("[cascade] recording stopped (mic released; conversation stays live)");
		} catch (err) {
			dbg(`[cascade] stopRecording: ${String(err)}`);
		}
	}

	// Resume recording on the existing live conversation (mic toggled back on). Restarts
	// the opus-recorder, which emits a fresh OggOpus header into the already-open stream —
	// UNVERIFIED that Unmute's decoder accepts a mid-stream re-header; instrumented to find out.
	startRecording(): void {
		try {
			this.recording = true;
			this.pipeline?.opusRecorder.start();
			dbg("[cascade] recording resumed (fresh Opus header into live stream)");
		} catch (err) {
			dbg(`[cascade] startRecording failed: ${String(err)}`);
		}
	}

	isLive(): boolean {
		return this.state === "live" && this.ws?.readyState === WebSocket.OPEN;
	}

	private setState(s: CascadeState): void {
		this.state = s;
		this.cb.onState?.(s);
	}

	private async setupAudio(): Promise<void> {
		const audioContext = new AudioContext();
		const outputWorklet = await getAudioWorkletNode(audioContext, "audio-output-processor");
		outputWorklet.connect(audioContext.destination);

		// Opus decoder for the assistant's audio: decoded PCM frames are pushed into
		// the output worklet for playback.
		const decoder = new Worker("/decoderWorker.min.js");
		decoder.onmessage = (event: MessageEvent) => {
			if (!event.data) return;
			const frame = event.data[0];
			outputWorklet.port.postMessage({ frame, type: "audio", micDuration: this.micDuration });
		};
		decoder.postMessage({
			command: "init",
			bufferLength: Math.round((960 * audioContext.sampleRate) / 24000),
			decoderSampleRate: 24000,
			outputBufferSampleRate: audioContext.sampleRate,
			resampleQuality: 0,
		});

		// Mic → Opus encoder. opus-recorder opens its own getUserMedia with these
		// constraints (echo cancellation matters for a speaker-based conversation).
		const opusRecorder = new OpusRecorder({
			mediaTrackConstraints: {
				audio: {
					echoCancellation: true,
					noiseSuppression: false,
					autoGainControl: true,
					channelCount: 1,
				},
				video: false,
			},
			encoderPath: "/encoderWorker.min.js",
			bufferLength: Math.round((960 * audioContext.sampleRate) / 24000),
			encoderFrameSize: 20,
			encoderSampleRate: 24000,
			maxFramesPerPage: 2,
			numberOfChannels: 1,
			recordingGain: 1,
			resampleQuality: 3,
			encoderComplexity: 0,
			encoderApplication: 2049,
			streamPages: true,
		});
		opusRecorder.ondataavailable = (data: Uint8Array) => {
			// opus-recorder reports position at 48kHz regardless of capture rate.
			this.micDuration = opusRecorder.encodedSamplePosition / 48000;
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.sendAudioFrame(data);
			} else {
				// Pre-open: buffer (don't drop) so the OggOpus header survives. Copy the
				// bytes — opus-recorder may reuse the underlying buffer for the next frame.
				this.pendingAudio.push(new Uint8Array(data));
			}
		};

		this.pipeline = { audioContext, opusRecorder, decoder, outputWorklet };
		await audioContext.resume();
		opusRecorder.start();
		this.recording = true;
	}

	private openSocket(): void {
		const url = this.config.wsUrl ?? DEFAULT_WS_URL;
		const ws = new WebSocket(url, "realtime");
		this.ws = ws;

		ws.onopen = () => {
			const wasReconnect = this.reconnectAttempts > 0;
			this.reconnectAttempts = 0;
			this.setState("live");
			const voice = this.config.voice ?? DEFAULT_VOICE;
			ws.send(
				JSON.stringify({
					type: "session.update",
					session: {
						instructions: {
							type: "constant",
							// Replay the latest injected KG context across a reconnect, not
							// just the static base prompt.
							text: this.lastInstructions ?? this.config.instructions ?? DEFAULT_INSTRUCTIONS,
						},
						voice,
						allow_recording: false,
					},
				}),
			);
			dbg(`[cascade] -> session.update sent (voice=${voice}${wasReconnect ? ", reconnect" : ""})`);
			if (wasReconnect) {
				// Recovered a dropped connection. Frames buffered during the gap are
				// mid-stream (no OggOpus header) and useless to the fresh STT leg — drop
				// them, and if the mic is live restart the recorder so it emits a new
				// header into the new connection.
				this.pendingAudio = [];
				if (this.recording) {
					try {
						this.pipeline?.opusRecorder.stop();
						this.pipeline?.opusRecorder.start();
					} catch (err) {
						dbg(`[cascade] recorder restart on reconnect failed: ${String(err)}`);
					}
				}
			} else if (this.pendingAudio.length) {
				dbg(
					`[cascade] flushing ${this.pendingAudio.length} buffered pre-open frame(s) (OggOpus header first)`,
				);
				for (const frame of this.pendingAudio) this.sendAudioFrame(frame);
				this.pendingAudio = [];
			}
		};

		ws.onmessage = (event: MessageEvent) => this.handleMessage(event);
		ws.onerror = () => {
			// A WS error is always followed by onclose; let onclose drive recovery so we
			// don't surface an error for a blip we're about to reconnect through.
			dbg("[cascade] websocket error (close + reconnect to follow)");
		};
		ws.onclose = () => {
			if (this.intentionalClose) return; // stop()/teardown owns the deliberate path
			this.scheduleReconnect();
		};
	}

	// Re-open the WebSocket after an unexpected drop, keeping the audio pipeline alive.
	// Exponential backoff, then give up. (A server that flap-closes within each attempt
	// will still climb to the cap and stop, since attempts only reset on a real onopen.)
	private scheduleReconnect(): void {
		if (!this.pipeline) {
			// No audio pipeline to recover onto — treat as a normal close.
			this.setState("closed");
			return;
		}
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			dbg(`[cascade] giving up after ${this.reconnectAttempts} reconnect attempts`);
			this.setState("error");
			this.cb.onError?.("lost connection to the voice server");
			this.teardown();
			return;
		}
		this.reconnectAttempts++;
		const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1), 8000);
		this.setState("connecting");
		dbg(`[cascade] connection lost — reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = undefined;
			if (this.intentionalClose) return;
			this.openSocket();
		}, delay);
	}

	// Send one Opus frame as input_audio_buffer.append, with throttled up-trace.
	private sendAudioFrame(data: Uint8Array): void {
		this.ws?.send(
			JSON.stringify({ type: "input_audio_buffer.append", audio: base64EncodeOpus(data) }),
		);
		this.audioSent++;
		if (this.audioSent === 1 || this.audioSent % 50 === 0) {
			dbg(`[cascade] -> audio frame #${this.audioSent} (bytes=${data.byteLength})`);
		}
	}

	// Update the live session's system prompt mid-conversation — this is the seam the
	// KG layer uses to inject retrieved context before the next turn (Phase 5, design A).
	updateInstructions(text: string): void {
		this.lastInstructions = text; // remembered so a reconnect replays the latest KG context
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		this.ws.send(
			JSON.stringify({
				type: "session.update",
				session: {
					instructions: { type: "constant", text },
					voice: this.config.voice ?? DEFAULT_VOICE,
					allow_recording: false,
				},
			}),
		);
	}

	private handleMessage(event: MessageEvent): void {
		let data: { type?: string; delta?: string; error?: { type?: string; message?: string } };
		try {
			data = JSON.parse(event.data);
		} catch {
			dbg(`[cascade] <- non-JSON message (${(event.data as string)?.length ?? "?"} bytes)`);
			return;
		}
		// Trace every inbound type. response.audio.delta floods, so count it instead.
		if (data.type === "response.audio.delta") {
			this.audioRecv++;
			if (this.audioRecv === 1 || this.audioRecv % 50 === 0) {
				dbg(`[cascade] <- response.audio.delta #${this.audioRecv}`);
			}
		} else {
			// Log the raw payload (truncated) so message CONTENT is visible, not just the
			// type — needed to see exactly which event carries the assistant text.
			const raw = typeof event.data === "string" ? event.data : "";
			dbg(`[cascade] <- ${data.type ?? "(no type)"} :: ${raw.slice(0, 200)}`);
		}
		switch (data.type) {
			case "response.audio.delta": {
				if (!data.delta || !this.pipeline) return;
				const opus = base64DecodeOpus(data.delta);
				this.pipeline.decoder.postMessage({ command: "decode", pages: opus }, [opus.buffer]);
				return;
			}
			case "conversation.item.input_audio_transcription.delta":
				// STT deltas arrive as word-groups with no separator between them; add a
				// leading space so they don't run together (same as the assistant path).
				if (data.delta) this.cb.onUserTranscript?.(" " + data.delta);
				return;
			case "response.text.delta":
				// TTS text omits leading spaces; add one so words don't run together.
				if (data.delta) this.cb.onAssistantTranscript?.(" " + data.delta);
				return;
			case "input_audio_buffer.speech_stopped":
				this.cb.onSpeechStopped?.();
				return;
			case "response.created": {
				// Injection verification: response.created carries the full chat_history
				// the server is about to send to the LLM; chat_history[0] is the system
				// prompt. Confirm our injected <kg-context> block actually reached the
				// prompt the model generates from (the injection is otherwise invisible).
				const history =
					(data as { response?: { chat_history?: Array<{ role?: string; content?: unknown }> } })
						.response?.chat_history ?? [];
				const sys = typeof history[0]?.content === "string" ? history[0].content : "";
				const hasKg = sys.includes("<kg-context>");
				dbg(
					`[cascade] response.created: ${history.length} msgs, system ${sys.length} chars, ` +
						`<kg-context> ${hasKg ? "PRESENT ✓" : "absent"}`,
				);
				this.cb.onResponseStart?.();
				return;
			}
			case "response.text.done":
				// The assistant's answer text is complete — the turn is generated.
				this.cb.onResponseDone?.();
				return;
			case "error": {
				const isWarning = data.error?.type === "warning";
				const msg = data.error?.message ?? "unknown server error";
				if (isWarning) console.warn(`[cascade] server warning: ${msg}`);
				else {
					console.error(`[cascade] server error: ${msg}`);
					this.cb.onError?.(msg);
				}
				return;
			}
			default:
				// session.updated, response.done, audio.done, speech_started,
				// unmute.* readiness pings — nothing to do.
				return;
		}
	}

	private teardown(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.pendingAudio = [];
		if (this.pipeline) {
			const { audioContext, opusRecorder, outputWorklet, decoder } = this.pipeline;
			try {
				opusRecorder.stop();
			} catch {
				/* already stopped */
			}
			outputWorklet.disconnect();
			decoder.terminate();
			void audioContext.close();
			this.pipeline = undefined;
		}
		if (this.ws) {
			this.ws.onclose = null;
			if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
				this.ws.close();
			}
			this.ws = undefined;
		}
	}
}
