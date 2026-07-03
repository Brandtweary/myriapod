// Embedding client — one call per term write (mint / description change),
// through the metering proxy's /v1/embed passthrough to a self-hosted
// embedding-inference container (MiniLM-class, 384-dim). Fail-soft: any
// error returns null and the term simply carries no embedding until a later
// write retries (similar_terms degrades to string-only).

import { dbgWarn } from "../debug.js";

export interface EmbedClientOpts {
	endpoint: string; // the proxy's /v1/embed URL
	getBearer: () => string; // proxy principal bearer ("" on the own-key path)
}

export type EmbedFn = (text: string) => Promise<number[] | null>;

export function makeEmbedClient(opts: EmbedClientOpts): EmbedFn {
	return async (text: string) => {
		try {
			const bearer = opts.getBearer();
			const res = await fetch(opts.endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
				},
				body: JSON.stringify({ inputs: [text] }),
				// A hung endpoint must not stall the term-write path (the mint tool
				// awaits this); a timeout throws → the catch below returns null, so
				// dedup degrades to string-only rather than blocking.
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) {
				dbgWarn(`embed failed (${res.status}) — term carries no embedding`);
				return null;
			}
			const data = (await res.json()) as number[][];
			const vec = Array.isArray(data) ? data[0] : null;
			return Array.isArray(vec) && vec.length ? vec : null;
		} catch (err) {
			dbgWarn("embed unreachable — term carries no embedding", err);
			return null;
		}
	};
}
