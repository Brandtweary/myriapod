// Fresh-grant gates for the anonymous free tier.
//
// These run in ONE place — the fresh-$10 mint inside POST /anon-init — never on
// the chat path. Each returns true when the signal is consistent with a human;
// a false blocks only the grant (an existing principal keeps chatting). All three
// are client-reported and therefore spoofable by a determined attacker (strip the
// BotD field, leave the honeypot empty, wait 1.5s). That's accepted by design:
// they filter casual/unattended automation, and the hard caps ($10 per browser,
// $50/day) bound anything that slips through. We're buying "not trivial," not
// "impenetrable."

/** Minimum time a human takes to read the welcome modal and click through. A
 *  script driving /anon-init directly arrives faster (or omits the field). */
export const MIN_GRANT_ELAPSED_MS = 1500;

/** BotD verdict from the in-browser detector. Blocks only on an EXPLICIT positive
 *  — an absent or malformed verdict fails OPEN, because BotD is third-party and a
 *  privacy extension can suppress it on a perfectly real browser; the honeypot and
 *  time-trap still gate that request. */
export function botCheck(verdict: unknown): boolean {
	if (verdict && typeof verdict === "object" && "bot" in verdict) {
		return (verdict as { bot?: unknown }).bot !== true;
	}
	return true;
}

/** The honeypot is a CSS-hidden field no human can see; a real submission leaves
 *  it empty. Any value means an automated form-filler touched it. */
export function honeypotOk(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

/** Time-trap. Fails CLOSED on an absent/garbled value (unlike botCheck): this is
 *  OUR field, emitted by OUR modal on every real click, so its absence means the
 *  modal was bypassed — i.e. a script hitting the endpoint directly. */
export function timeTrapOk(elapsedMs: unknown): boolean {
	return typeof elapsedMs === "number" && elapsedMs >= MIN_GRANT_ELAPSED_MS;
}

/** All three gates. True ⇒ mint the grant. */
export function grantGatesPass(signals: {
	honeypot?: unknown;
	elapsedMs?: unknown;
	botd?: unknown;
}): boolean {
	return (
		honeypotOk(signals.honeypot) &&
		timeTrapOk(signals.elapsedMs) &&
		botCheck(signals.botd)
	);
}
