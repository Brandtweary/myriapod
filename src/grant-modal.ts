// First-launch welcome / grant modal — with the memory opt-in folded in.
//
// A fresh visitor sees this ONCE, on their first mic toggle (or first send), before
// any owner-funded request. It does everything in a single window so we never stack
// pop-ups:
//   1. Explains the $10 of hosted free credits — accept = "Start chatting".
//   2. Offers the own-key alternative — "Use my own OpenRouter key" → Settings.
//   3. Carries the memory opt-in as an inline toggle (default ON). Memory genuinely
//      has two states, so it's a switch; credits don't (accept vs. bring-your-own),
//      so those stay as the two buttons.
//
// It also carries the two zero-friction grant gates (sent to the proxy's /anon-init):
// a CSS-hidden HONEYPOT field a human never fills, and a TIME-TRAP — how long the
// modal was on screen before the click (a script driving it submits far faster than
// a person can read). Neither is visible or adds any friction.

import { html, render } from "lit";

export interface GrantModalOptions {
	/** Open the settings dialog (Access tab) — for the own-key / family-code path. */
	onOpenSettings: () => void;
}

export interface GrantSignals {
	/** Hidden honeypot field value — empty for a human, non-empty for an autofiller. */
	honeypot: string;
	/** Milliseconds the modal was on screen before the click (time-trap). */
	elapsedMs: number;
	/** Memory toggle — true (the default) opts the visitor into local-graph memory. */
	rememberMe: boolean;
	/** True if the visitor chose the own-key path instead of the free credits. */
	useOwnKey: boolean;
}

/** Show the welcome modal; resolves with the grant gates + the memory choice when
 *  the visitor dismisses it (send proceeds). */
export function showGrantModal(opts: GrantModalOptions): Promise<GrantSignals> {
	return new Promise((resolve) => {
		const renderedAt = Date.now();
		const overlay = document.createElement("div");
		overlay.className = "cw-grant-overlay";

		const close = (useOwnKey: boolean) => {
			const hp = overlay.querySelector('input[name="email_confirm"]') as HTMLInputElement | null;
			const mem = overlay.querySelector('input[name="cw_remember"]') as HTMLInputElement | null;
			const signals: GrantSignals = {
				honeypot: hp?.value ?? "",
				elapsedMs: Date.now() - renderedAt,
				rememberMe: mem?.checked ?? true,
				useOwnKey,
			};
			overlay.remove();
			resolve(signals);
		};

		render(
			html`
				<div class="cw-grant-modal" role="dialog" aria-modal="true">
					<h2 class="cw-grant-title">Welcome — $10 in free credits</h2>
					<p class="cw-grant-body">
						Start chatting right away, on the house: <strong>$10</strong> of hosted credits, no
						signup and no key required. When that runs out you can keep going by adding your own
						OpenRouter key.
					</p>
					<label class="cw-grant-toggle">
						<input type="checkbox" name="cw_remember" checked />
						<span class="cw-grant-toggle-track"><span class="cw-grant-toggle-thumb"></span></span>
						<span class="cw-grant-toggle-text">
							<strong>Remember our conversations.</strong> Myriapod builds a small knowledge graph
							from what you tell it, kept <strong>only in this browser</strong> — never uploaded,
							exportable and deletable anytime from Settings.
						</span>
					</label>
					<input
						type="text"
						name="email_confirm"
						tabindex="-1"
						autocomplete="off"
						aria-hidden="true"
						style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;"
					/>
					<div class="cw-grant-actions">
						<button class="cw-grant-primary" @click=${() => close(false)}>Start chatting</button>
						<button
							class="cw-grant-secondary"
							@click=${() => {
								close(true);
								opts.onOpenSettings();
							}}
						>
							Use my own OpenRouter key
						</button>
					</div>
				</div>
			`,
			overlay,
		);

		document.body.appendChild(overlay);
	});
}
