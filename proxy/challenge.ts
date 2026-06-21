// Bot-challenge seam — Cap (@cap.js/server), a self-hosted proof-of-work.
//
// DISABLED by default: with CHALLENGE_SECRET unset (the correct state until the
// site is public) verifyChallenge() is a no-op that always passes, so free-credit
// grants work with zero friction during local dev. When the secret is set, the
// frontend's invisible Cap widget solves a PoW, redeems it for a token, and sends
// that token with the first message; the grant path checks it here.
//
// Phase 5 (tripwires) owns honeypot/time-trap + fingerprinting — NOT this module.

import Cap from "@cap.js/server";

const SECRET = process.env.CHALLENGE_SECRET ?? "";
export const challengeEnabled = SECRET.length > 0;

let cap: Cap | null = null;
function getCap(): Cap {
	if (!cap) {
		cap = new Cap({
			tokens_store_path: process.env.CAP_TOKENS_PATH ?? "./.cap-tokens.json",
		});
	}
	return cap;
}

/** True when the bot challenge is satisfied. No-op (always true) while disabled. */
export async function verifyChallenge(token: string | undefined): Promise<boolean> {
	if (!challengeEnabled) return true;
	if (!token) return false;
	const { success } = await getCap().validateToken(token);
	return success;
}

/** Issue a PoW challenge for the widget (only meaningful when enabled). */
export function createChallenge() {
	return getCap().createChallenge();
}

/** Redeem a solved challenge for a token the client then presents at grant time. */
export function redeemChallenge(body: Parameters<Cap["redeemChallenge"]>[0]) {
	return getCap().redeemChallenge(body);
}
