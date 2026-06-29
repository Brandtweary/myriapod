// Stop-audio button — makes the otherwise-invisible TTS controls discoverable.
//
// The mic button implies Ctrl+Space; the audio-only stop (Ctrl+Alt+Space) had no UI at
// all. This button broadcasts it via the tooltip. Two interactions:
//   single click — cut the agent off NOW (the current reply's audio; the LLM keeps
//                  generating, you just stop hearing it). Same as Ctrl+Alt+Space.
//   double click — toggle a PERSISTENT mute, for speak-but-don't-listen (STT-only) use.
// The icon reflects the persistent state: Volume2 (sound on) ↔ VolumeX (muted).
//
// Mounts leftmost in the editor's icon cluster ([stop][memory][mic][send]), re-homing
// after each editor re-render via a MutationObserver, mirroring its siblings.

import { html, render } from "lit";
import { Volume2, VolumeX, createElement } from "lucide";

export interface StopAudioSeam {
	// Single click: cut the agent's current TTS (cascade.stopTts).
	onCut: () => void;
	// Double click: toggle the persistent mute (and persist + apply it).
	onToggleMute: () => void;
	// Current persistent-mute state, read on every (re-)render.
	isMuted: () => boolean;
}

const STYLE_ID = "cw-stopaudio-style";
const STYLES = `
.cw-stop { height: 2rem; width: 2rem; border-radius: .5rem; display: inline-grid;
	place-items: center; cursor: pointer; background: transparent; color: #9ca3af;
	border: none; transition: color .12s, background .12s; }
.cw-stop:hover { color: #f87171; background: color-mix(in srgb, #f87171 12%, transparent); }
.cw-stop:focus-visible { outline: 2px solid #f87171; outline-offset: 1px; }
.cw-stop--muted { color: #f87171; } /* persistent mute on — speaker-x lit red */
`;

function ensureStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

export class StopAudioButton {
	private host: HTMLSpanElement;
	private observer?: MutationObserver;

	constructor(private seam: StopAudioSeam) {
		ensureStyles();
		this.host = document.createElement("span");
		this.host.style.display = "inline-flex";
		this.renderButton();
		this.observer = new MutationObserver(() => this.mount());
		this.observer.observe(document.body, { childList: true, subtree: true });
		this.mount();
	}

	// Re-home just before the memory button → cluster [stop][memory][mic][send]. Falls
	// back to before the mic if the memory button hasn't mounted yet (then re-homes
	// once it has). Idempotent: no-op when already the anchor's previous sibling.
	private mount(): void {
		const anchor =
			document.querySelector(".cw-mem")?.parentElement ?? document.querySelector(".cw-mic");
		if (!anchor || !anchor.parentElement) return;
		if (anchor.previousElementSibling === this.host) return;
		anchor.parentElement.insertBefore(this.host, anchor);
	}

	// Re-render from the current mute state. Called by the host after a toggle.
	refresh(): void {
		this.renderButton();
	}

	private renderButton(): void {
		const muted = this.seam.isMuted();
		const label = muted
			? "Voice muted — double-click to unmute"
			: "Stop the agent's voice (Ctrl+Alt+Space) · double-click to mute";
		const svg = createElement(muted ? VolumeX : Volume2);
		svg.setAttribute("width", "18");
		svg.setAttribute("height", "18");
		svg.setAttribute("aria-hidden", "true");
		render(
			html`
				<button
					class="cw-stop ${muted ? "cw-stop--muted" : ""}"
					title=${label}
					aria-label=${label}
					@click=${() => this.seam.onCut()}
					@dblclick=${() => this.seam.onToggleMute()}
				>
					${svg}
				</button>
			`,
			this.host,
		);
	}

	destroy(): void {
		this.observer?.disconnect();
		this.host.remove();
	}
}

export function installStopAudioButton(seam: StopAudioSeam): StopAudioButton {
	return new StopAudioButton(seam);
}
