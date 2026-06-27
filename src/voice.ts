// Mic capture interface — the voice agent's front door.
//
// TRANSPORT-AGNOSTIC SHELL. This module owns everything independent of how audio
// actually reaches the model: the mic button (mounted into the editor, just left
// of Send), the toggle state machine, the keyboard shortcut, the browser
// mic-permission flow, and the recording indicator. The actual audio transport
// (streaming to the Kyutai Unmute cascade) plugs into the
// `onStart(stream) / onStop()` seam.
//
// Interaction model: TOGGLE, not push-to-talk. One press (button or shortcut)
// starts recording; the next ends the turn (record-off = send). Turn-based by design.

import { html, render } from "lit";
import { createElement, Mic, Square } from "lucide";

export type VoiceCaptureSeam = {
	// Fired when recording starts, handed the live mic stream. The cascade attaches
	// its capture → WebSocket pipe to the realtime endpoint here.
	onStart?: (stream: MediaStream) => void | Promise<void>;
	// Fired when recording stops (toggle off = end of the user's turn).
	onStop?: () => void;
};

// Ctrl+Space -- one-handed and effortless (pinky on Ctrl, thumb on Space, both bottom
// row, right next to each other). Deliberately NOT Alt-based (Alt opens browser menus
// and collides with Hyprland bindings); Space is also unclaimed by the browser, unlike
// most comfortable Ctrl+letter combos (Ctrl+B/E/G/etc. hit bookmarks/search/find). The
// handler requires NO shift/alt/meta, so Ctrl+Shift+Space etc. won't trigger. One named
// constant so the binding is a one-line change. `code` is layout-independent.
// (If a Linux IME ever swallows Ctrl+Space, we're not wedded to Ctrl — swap freely.)
export const VOICE_TOGGLE = { ctrlKey: true, code: "Space" } as const;

type State = "idle" | "requesting" | "recording" | "denied";

const STYLE_ID = "cw-voice-style";
// The mic button matches the editor's other icon buttons (h-8 w-8 / 2rem) so it
// sits flush beside Send. Neon-green idle, red pulse while recording.
const STYLES = `
.cw-mic { height: 2rem; width: 2rem; border-radius: .5rem; display: inline-grid;
	place-items: center; cursor: pointer; background: transparent; color: #34d399;
	border: none; transition: color .12s, background .12s; }
.cw-mic:hover { color: #6ee7b7; background: color-mix(in srgb, #34d399 12%, transparent); }
.cw-mic:focus-visible { outline: 2px solid #34d399; outline-offset: 1px; }
.cw-mic--rec { color: #f87171; }
.cw-mic--rec svg { animation: cw-mic-pulse 1.2s infinite; }
.cw-mic--req { color: #9ca3af; cursor: wait; }
@keyframes cw-mic-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
`;

function ensureStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

export class VoiceController {
	private host: HTMLSpanElement;
	private state: State = "idle";
	private stream?: MediaStream;
	private observer?: MutationObserver;

	constructor(private seam: VoiceCaptureSeam) {
		ensureStyles();
		// The button lives in its own span so we can move/re-home it without
		// disturbing the editor's own DOM. The editor re-renders every turn
		// (Send <-> Stop), so a MutationObserver re-homes it after each render.
		this.host = document.createElement("span");
		this.host.style.display = "inline-flex";
		this.renderButton();
		window.addEventListener("keydown", this.onKey);
		this.observer = new MutationObserver(() => this.mount());
		this.observer.observe(document.body, { childList: true, subtree: true });
		this.mount();
	}

	// Re-home the button just before the editor's send/stop button. Idempotent:
	// no-op if it's already the send button's previous sibling.
	private mount(): void {
		const editor = document.querySelector("message-editor");
		if (!editor) return;
		// The Send (and the Stop, while streaming) button is the LAST <button> in
		// the editor's bottom-right group — the only buttons after it would be ours.
		const buttons = [...editor.querySelectorAll("button")].filter((b) => b !== this.host.firstElementChild);
		const sendBtn = buttons[buttons.length - 1];
		if (!sendBtn || !sendBtn.parentElement) return;
		if (sendBtn.previousElementSibling === this.host) return;
		sendBtn.parentElement.insertBefore(this.host, sendBtn);
	}

	private onKey = (e: KeyboardEvent) => {
		if (
			e.code === VOICE_TOGGLE.code &&
			e.ctrlKey === VOICE_TOGGLE.ctrlKey &&
			!e.altKey &&
			!e.metaKey &&
			!e.shiftKey
		) {
			e.preventDefault();
			void this.toggle();
		}
	};

	toggle = async (): Promise<void> => {
		if (this.state === "recording") return this.stop();
		if (this.state === "requesting") return;
		await this.start();
	};

	private async start(): Promise<void> {
		this.setState("requesting");
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			this.setState("denied");
			window.setTimeout(() => {
				if (this.state === "denied") this.setState("idle");
			}, 2000);
			return;
		}
		this.setState("recording");
		try {
			await this.seam.onStart?.(this.stream);
		} catch (err) {
			console.error("[cymbiont] voice onStart seam threw", err);
		}
	}

	private stop(): void {
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = undefined;
		this.setState("idle");
		this.seam.onStop?.();
	}

	private setState(s: State): void {
		this.state = s;
		this.renderButton();
	}

	private renderButton(): void {
		const recording = this.state === "recording";
		const requesting = this.state === "requesting";
		const label = recording ? "Stop & send (Ctrl+Space)" : "Start voice (Ctrl+Space)";
		const svg = createElement(recording ? Square : Mic);
		svg.setAttribute("width", "18");
		svg.setAttribute("height", "18");
		svg.setAttribute("aria-hidden", "true");
		render(
			html`
				<button
					class="cw-mic ${recording ? "cw-mic--rec" : ""} ${requesting ? "cw-mic--req" : ""}"
					title=${label}
					aria-label=${label}
					aria-pressed=${recording}
					@click=${() => void this.toggle()}
				>
					${svg}
				</button>
			`,
			this.host,
		);
	}

	destroy(): void {
		this.observer?.disconnect();
		window.removeEventListener("keydown", this.onKey);
		this.stop();
		this.host.remove();
	}
}

export function installVoiceCapture(seam: VoiceCaptureSeam): VoiceController {
	return new VoiceController(seam);
}
