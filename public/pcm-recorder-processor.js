// pcm-recorder-processor.js — mic-capture AudioWorklet for the browser STT half
// of the voice cascade. Counterpart to audio-output-processor.js (the TTS playback
// worklet); both are static assets fetched at runtime and loaded via the same
// getAudioWorkletNode() addModule pattern used in cascade.ts.
//
// It runs on the audio render thread, receives the mic input (one render quantum,
// 128 frames, at the AudioContext's native rate — typically 48kHz), downmixes any
// multi-channel input to mono, copies the samples (the input buffer is reused by
// the engine across quanta, so it MUST be copied before posting), and ships them to
// the main thread. Resampling 48k→24k and accumulation happen on the main thread
// (src/stt.ts), where the whole utterance can be resampled at once for better quality.
//
// No type-checking here — AudioWorkletGlobalScope isn't covered by the DOM lib.

class PcmRecorderProcessor extends AudioWorkletProcessor {
	process(inputs) {
		// inputs[0] is the first connected input; its element per channel is a
		// Float32Array of `currentFrame`-quantum samples. An empty array means no
		// upstream audio this quantum — keep the processor alive and wait.
		const input = inputs[0];
		if (!input || input.length === 0) return true;

		const channelCount = input.length;
		const frameCount = input[0].length;
		if (frameCount === 0) return true;

		// Downmix to mono: average the channels. (The recorder requests a mono
		// capture, so this is usually a straight copy of channel 0, but average
		// defensively in case the graph delivers stereo.)
		const mono = new Float32Array(frameCount);
		if (channelCount === 1) {
			mono.set(input[0]);
		} else {
			for (let c = 0; c < channelCount; c++) {
				const ch = input[c];
				for (let i = 0; i < frameCount; i++) mono[i] += ch[i];
			}
			for (let i = 0; i < frameCount; i++) mono[i] /= channelCount;
		}

		// Transfer the backing buffer to the main thread (zero-copy handoff).
		this.port.postMessage({ samples: mono }, [mono.buffer]);
		return true;
	}
}

registerProcessor("pcm-recorder-processor", PcmRecorderProcessor);
