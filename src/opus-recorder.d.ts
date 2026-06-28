// Type declaration for `opus-recorder` (the npm package ships no types).
// Ported from Unmute's frontend; only the surface we use is declared.
declare module "opus-recorder" {
	interface RecorderOptions {
		// Despite the name this is a MediaStreamConstraints object.
		mediaTrackConstraints?: MediaStreamConstraints;
		encoderPath: string;
		bufferLength: number;
		encoderFrameSize: number;
		encoderSampleRate: number;
		maxFramesPerPage: number;
		numberOfChannels: number;
		recordingGain: number;
		resampleQuality: number;
		encoderComplexity: number;
		encoderApplication: number;
		streamPages: boolean;
	}

	export default class Recorder {
		constructor(options: RecorderOptions);
		start(): void;
		// Resolves after the encoder flushes its final page (a last ondataavailable);
		// await it so the trailing audio is sent before we commit the turn.
		stop(): Promise<void>;
		ondataavailable: (data: Uint8Array) => void;
		encodedSamplePosition: number;
	}
}
