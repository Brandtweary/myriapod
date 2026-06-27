// Memory-indicator button — the write-path's visible pulse.
//
// The gutters make RETRIEVAL visible; this makes INGESTION visible. It mounts in
// the editor immediately left of the mic button (sibling cluster: [memory][mic]
// [send]) and reflects the ingestion lifecycle:
//   off     — memory consent not granted (dim/gray); click offers to turn it on
//   saved   — memory on, everything ingested (dim green); click is a no-op
//   pending — un-ingested content waiting (bright green); click saves it now
//   armed   — conversation paused, debounce counting down (slow breathe)
//   running — an extraction is in flight (warm-orange pulse)
// Clicking force-flushes the pending batch (skips the debounce); a no-op when saved.
//
// Re-homes itself after each editor re-render via a MutationObserver, mirroring the
// mic button's mount pattern in voice.ts.

import { html, render } from "lit";
import { Brain, createElement } from "lucide";

export type MemoryVisual = "off" | "saved" | "pending" | "armed" | "running";

export interface MemoryButtonSeam {
	// Current visual state, read on every (re-)render.
	getVisual: () => MemoryVisual;
	// Click handler — force-flush when on, or offer consent when off.
	onClick: () => void;
}

const STYLE_ID = "cw-memory-style";
const STYLES = `
.cw-mem { height: 2rem; width: 2rem; border-radius: .5rem; display: inline-grid;
	place-items: center; cursor: pointer; background: transparent; color: #34d399;
	border: none; transition: color .12s, background .12s, opacity .12s; }
.cw-mem:hover { color: #6ee7b7; background: color-mix(in srgb, #34d399 12%, transparent); }
.cw-mem:focus-visible { outline: 2px solid #34d399; outline-offset: 1px; }
.cw-mem--off { color: #6b7280; opacity: .65; }
.cw-mem--saved { opacity: .45; }
.cw-mem--armed svg { animation: cw-mem-breathe 2.4s ease-in-out infinite; }
.cw-mem--running { color: #fb923c; } /* warm orange while extracting — distinct from the idle green */
.cw-mem--running svg { animation: cw-mem-pulse 1.1s infinite; }
@keyframes cw-mem-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
@keyframes cw-mem-breathe { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
`;

function ensureStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

const LABELS: Record<MemoryVisual, string> = {
	off: "Memory off — click to turn on",
	saved: "Memory on — up to date",
	pending: "Click to save to memory now",
	armed: "Saving soon — click to save now",
	running: "Saving to memory…",
};

export class MemoryButton {
	private host: HTMLSpanElement;
	private observer?: MutationObserver;

	constructor(private seam: MemoryButtonSeam) {
		ensureStyles();
		this.host = document.createElement("span");
		this.host.style.display = "inline-flex";
		this.renderButton();
		this.observer = new MutationObserver(() => this.mount());
		this.observer.observe(document.body, { childList: true, subtree: true });
		this.mount();
	}

	// Re-home just before the mic button. Idempotent: no-op once we're its previous
	// sibling. If the mic hasn't mounted yet, retry on the next mutation.
	private mount(): void {
		const mic = document.querySelector(".cw-mic");
		if (!mic || !mic.parentElement) return;
		if (mic.previousElementSibling === this.host) return;
		mic.parentElement.insertBefore(this.host, mic);
	}

	// Re-render from the current visual state. Called by the host when ingestion or
	// consent state changes.
	refresh(): void {
		this.renderButton();
	}

	private renderButton(): void {
		const v = this.seam.getVisual();
		const label = LABELS[v];
		const cls =
			v === "off"
				? "cw-mem--off"
				: v === "saved"
					? "cw-mem--saved"
					: v === "armed"
						? "cw-mem--armed"
						: v === "running"
							? "cw-mem--running"
							: ""; // pending = base (bright green)
		const svg = createElement(Brain);
		svg.setAttribute("width", "18");
		svg.setAttribute("height", "18");
		svg.setAttribute("aria-hidden", "true");
		render(
			html`
				<button
					class="cw-mem ${cls}"
					title=${label}
					aria-label=${label}
					@click=${() => this.seam.onClick()}
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

export function installMemoryButton(seam: MemoryButtonSeam): MemoryButton {
	return new MemoryButton(seam);
}
