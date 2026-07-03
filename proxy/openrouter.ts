// OpenRouter interaction: forward a chat completion (streaming or not) while
// capturing the usage/cost, and mint family sub-keys via the Provisioning API.
//
// Usage is ALWAYS returned by OpenRouter now (the old usage:{include} flag is a
// no-op), and in streaming mode it rides a trailing `data:` chunk carrying a
// `usage` block (with `cost` in credits ≈ USD) right before `[DONE]`. To meter
// without buffering the whole response away from the client, we tee() the body:
// one branch streams to the client untouched, the other is consumed here purely
// to find that usage chunk — so metering still lands even if the client hangs up.

export interface Usage {
	promptTokens: number;
	completionTokens: number;
	cost: number;
}

export interface ForwardResult {
	status: number;
	ok: boolean;
	stream: boolean;
	clientStream?: ReadableStream<Uint8Array>; // present when stream === true
	clientText?: string; // present for non-stream success and all errors
	contentType: string;
	usage: Promise<Usage | null>; // resolves once usage is known (null if absent)
}

function usageFromObj(obj: unknown): Usage | null {
	const u = (obj as { usage?: Record<string, number> })?.usage;
	if (!u) return null;
	return {
		promptTokens: u.prompt_tokens ?? 0,
		completionTokens: u.completion_tokens ?? 0,
		cost: u.cost ?? 0,
	};
}

export async function forwardCompletion(opts: {
	base: string;
	upstreamKey: string;
	body: Record<string, unknown>;
	timeoutMs?: number;
}): Promise<ForwardResult> {
	const stream = opts.body.stream === true;
	const started = Date.now();
	console.log(`[proxy] → openrouter forward (stream=${stream}, timeout=${opts.timeoutMs ?? 120000}ms)`);
	let res: Response;
	try {
		res = await fetch(`${opts.base}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.upstreamKey}`,
			},
			body: JSON.stringify(opts.body),
			// Fail fast on a dead/stale connection (network change mid-request) rather
			// than hanging forever. Covers the streamed body too, not just the headers.
			signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
		});
	} catch (err) {
		const ms = Date.now() - started;
		const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		console.error(`[proxy] ✗ openrouter forward failed after ${ms}ms — ${msg}`);
		return {
			status: 504,
			ok: false,
			stream: false,
			clientText: JSON.stringify({
				error: "upstream request failed or timed out — try again (network change?)",
			}),
			contentType: "application/json",
			usage: Promise.resolve(null),
		};
	}
	console.log(`[proxy] ← openrouter status=${res.status} in ${Date.now() - started}ms`);

	if (!res.ok) {
		// Log the upstream body server-side; never leak it to the client (it can carry
		// key hints, rate-limit internals, or account detail). Return a generic shape.
		const upstreamBody = await res.text().catch(() => "");
		console.error(`[proxy] ✗ openrouter error status=${res.status} body=${upstreamBody.slice(0, 2000)}`);
		return {
			status: res.status,
			ok: false,
			stream: false,
			clientText: JSON.stringify({ error: "upstream error", status: res.status }),
			contentType: "application/json",
			usage: Promise.resolve(null),
		};
	}

	if (!stream) {
		const data = await res.json();
		return {
			status: 200,
			ok: true,
			stream: false,
			clientText: JSON.stringify(data),
			contentType: "application/json",
			usage: Promise.resolve(usageFromObj(data)),
		};
	}

	const [toClient, toMeter] = res.body!.tee();
	return {
		status: 200,
		ok: true,
		stream: true,
		clientStream: toClient,
		contentType: res.headers.get("content-type") ?? "text/event-stream",
		usage: scanSseForUsage(toMeter),
	};
}

/** Drain an SSE stream looking for the usage chunk. Consumes the whole stream so
 *  metering records even if the client cancels its own branch. */
async function scanSseForUsage(stream: ReadableStream<Uint8Array>): Promise<Usage | null> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let found: Usage | null = null;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				// Skip blanks and ": OPENROUTER PROCESSING" keepalive comments.
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") continue;
				try {
					const u = usageFromObj(JSON.parse(payload));
					if (u) found = u; // keep the last one seen
				} catch {
					// partial/non-JSON SSE line — ignore
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	return found;
}

/** Mint an OpenRouter sub-key with a hard lifetime spend cap (limit_reset:null).
 *  Requires a management/provisioning key. Returns the key (shown once) + hash. */
export async function mintSubKey(opts: {
	base: string;
	provisioningKey: string;
	name: string;
	limit: number;
}): Promise<{ key: string; hash: string }> {
	const res = await fetch(`${opts.base}/keys`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${opts.provisioningKey}`,
		},
		body: JSON.stringify({ name: opts.name, limit: opts.limit, limit_reset: null }),
	});
	if (!res.ok) {
		throw new Error(`provisioning failed: ${res.status} ${await res.text()}`);
	}
	const data = (await res.json()) as { key?: string; data?: { hash?: string } };
	if (!data.key) throw new Error("provisioning response missing key");
	return { key: data.key, hash: data.data?.hash ?? "" };
}
