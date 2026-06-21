// First-send welcome / grant modal.
//
// Visitors browse and start chatting freely; on their FIRST owner-funded send we
// pop this once to explain the $10 of hosted free credits and offer the two
// alternatives (own OpenRouter key / family code). It reads as "here's free
// money, here's how to keep going," not a paywall.
//
// LAUNCH SEAM: when the Cap bot-challenge is enabled (CHALLENGE_SECRET set on the
// proxy), the human-check widget mounts here and its solved token is what unlocks
// the grant. Until then the proxy's verifyChallenge is a no-op, so this modal is
// purely informational and never blocks.

import { html, render } from "lit";

export interface GrantModalOptions {
	/** Open the settings dialog (Access tab) — for the own-key / family-code path. */
	onOpenSettings: () => void;
}

/** Show the welcome modal; resolves when the visitor dismisses it (send proceeds). */
export function showGrantModal(opts: GrantModalOptions): Promise<void> {
	return new Promise((resolve) => {
		const overlay = document.createElement("div");
		overlay.className = "cw-grant-overlay";

		const close = () => {
			overlay.remove();
			resolve();
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
