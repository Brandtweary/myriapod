// First-send welcome / grant modal.
//
// Visitors browse and start chatting freely; on their FIRST owner-funded send,
// before a free-credit token exists, we pop this once to explain the $10 of hosted
// free credits and offer the two alternatives (own OpenRouter key / family code).
// It reads as "here's free money, here's how to keep going," not a paywall.
//
// It also carries the two zero-friction grant gates (sent to the proxy's
// /anon-init): a CSS-hidden HONEYPOT field a human never fills, and a TIME-TRAP —
// how long the modal was on screen before the click (a script driving it submits
// far faster than a person can read). Neither is visible or adds any friction.

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
}

/** Show the welcome modal; resolves with the grant gates when the visitor
 *  dismisses it (send proceeds). */
export function showGrantModal(opts: GrantModalOptions): Promise<GrantSignals> {
	return new Promise((resolve) => {
		const renderedAt = Date.now();
		const overlay = document.createElement("div");
		overlay.className = "cw-grant-overlay";

		const close = () => {
			const hp = overlay.querySelector('input[name="email_confirm"]') as HTMLInputElement | null;
			const signals: GrantSignals = {
				honeypot: hp?.value ?? "",
				elapsedMs: Date.now() - renderedAt,
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
					<input
						type="text"
						name="email_confirm"
						tabindex="-1"
						autocomplete="off"
						aria-hidden="true"
						style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;"
					/>
					<div class="cw-grant-actions">
						<button class="cw-grant-primary" @click=${close}>Start chatting</button>
						<button
							class="cw-grant-secondary"
							@click=${() => {
								close();
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
