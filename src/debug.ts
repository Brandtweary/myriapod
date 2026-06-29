// Lightweight browser instrumentation. Every message logs to the devtools
// console (prefixed `[myriapod]`, neon green) AND, in dev, ships to the Vite
// dev server's /__log endpoint, which appends it to /tmp/myriapod-debug.log
// so the coding agent can read it without copy-paste. See debugLogPlugin in
// vite.config.ts. Disabled automatically in production builds.

const STYLE = "color:#39ff14;font-weight:bold";

// Saved originals captured at module load. dbg()/the console patch BOTH route
// through these so a globally-patched console never double-ships its own output.
const ORIG = {
	log: console.log.bind(console),
	info: console.info.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	debug: console.debug.bind(console),
};

function safe(arg: unknown): string {
	if (typeof arg === "string") return arg;
	if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}

// Fire-and-forget log shipment to the dev server. `keepalive` lets it survive a
// page unload (so we capture the moment of a reload). No-op in production.
function ship(level: string, args: unknown[]): void {
	if (!import.meta.env?.DEV) return;
	try {
		const line = `[${new Date().toISOString()}] ${level} ${args.map(safe).join(" ")}`;
		void fetch("/__log", { method: "POST", body: line, keepalive: true }).catch(() => {});
	} catch {
		// never let logging break the app
	}
}

export function dbg(...args: unknown[]): void {
	ORIG.log("%c[myriapod]", STYLE, ...args);
	ship("LOG", args);
}

export function dbgWarn(...args: unknown[]): void {
	ORIG.warn("%c[myriapod]", STYLE, ...args);
	ship("WARN", args);
}

export function dbgError(...args: unknown[]): void {
	ORIG.error("%c[myriapod]", STYLE, ...args);
	ship("ERROR", args);
}

// Globally patch console so EVERY console.* (our raw calls, library
// noise) mirrors to the dev log file — not just the explicit dbg* helpers. Each
// override calls the saved original (real devtools output) then ships once. Wrapped
// so a ship failure can never break a real console call. Dev-only.
let consolePatched = false;
export function installConsolePatch(): void {
	if (consolePatched || !import.meta.env?.DEV) return;
	consolePatched = true;
	const wrap =
		(orig: (...a: unknown[]) => void, level: string) =>
		(...args: unknown[]): void => {
			orig(...args);
			try {
				ship(level, args);
			} catch {
				/* never let logging break a console call */
			}
		};
	console.log = wrap(ORIG.log, "LOG");
	console.info = wrap(ORIG.info, "INFO");
	console.warn = wrap(ORIG.warn, "WARN");
	console.error = wrap(ORIG.error, "ERROR");
	console.debug = wrap(ORIG.debug, "DEBUG");
}

// Compact summary of an agent message list for logging.
export function summarizeMessages(messages: Array<{ role?: string }>): string {
	if (!messages || messages.length === 0) return "0 messages";
	return `${messages.length} messages`;
}

// High-res relative timestamp, rounded ms.
const ms = () => Math.round(performance.now());

// WIRE-LEVEL STREAM TAP — a no-assumptions diagnostic for end-of-stream stalls.
// We wrap global fetch and, for chat-completion calls only, tap the response
// body's ReadableStream so every raw SSE chunk is timestamped AS IT ARRIVES OFF
// THE WIRE, flagged for the markers that bound a stall: `finish_reason` (visible
// answer done), `"usage"` (the trailing usage-only chunk), and `[DONE]` (stream
// close). A large gap between the finish_reason chunk and the usage/DONE chunk
// means the server is holding the connection open after the answer completes; if
// the raw chunks all land fast and the lag is after "body DONE", it's
// pi-ai/agent-core. This reads timing straight off the network, below pi-ai.
//
// Must run before the first chat request. The OpenAI SDK reads global fetch at
// call time (not import time), and createAgent()/the first send happen well
// after initApp() calls installInstrumentation(), so patching here is in time.
export function installStreamTap(): void {
	const origFetch = globalThis.fetch.bind(globalThis);
	let reqSeq = 0;
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const isLlm = url?.includes("/v1/chat/completions");
		if (!isLlm) return origFetch(input, init);

		const id = ++reqSeq;
		const t0 = performance.now();
		const rel = () => Math.round(performance.now() - t0);
		dbg(`[stream #${id}] fetch START @ ${ms()}ms — ${url}`);

		const resp = await origFetch(input, init);
		dbg(`[stream #${id}] response headers @ +${rel()}ms status=${resp.status}`);
		if (!resp.body) return resp;

		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let chunkCount = 0;
		let sawFinishAt = -1;
		const tapped = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						const tailNote =
							sawFinishAt >= 0 ? ` (gap finish→close=${rel() - sawFinishAt}ms)` : "";
						dbg(`[stream #${id}] body DONE @ +${rel()}ms, ${chunkCount} chunks${tailNote}`);
						controller.close();
						return;
					}
					chunkCount++;
					const text = decoder.decode(value, { stream: true });
					const markers: string[] = [];
					if (text.includes("finish_reason") && !text.includes('"finish_reason":null')) {
						markers.push("finish_reason");
						if (sawFinishAt < 0) sawFinishAt = rel();
					}
					if (text.includes('"usage"')) markers.push("usage");
					if (text.includes("[DONE]")) markers.push("DONE");
					// Only log marker chunks + every 25th content chunk — avoid per-token
					// fetch spam while still bracketing the stall precisely.
					if (markers.length > 0 || chunkCount % 25 === 0) {
						dbg(
							`[stream #${id}] chunk ${chunkCount} @ +${rel()}ms len=${value.byteLength}${
								markers.length ? ` <${markers.join(",")}>` : ""
							}`,
						);
					}
					controller.enqueue(value);
				} catch (err) {
					dbgError(`[stream #${id}] reader threw @ +${rel()}ms:`, err);
					controller.error(err);
				}
			},
			cancel(reason) {
				dbgWarn(`[stream #${id}] cancelled @ +${rel()}ms:`, reason);
				return reader.cancel(reason);
			},
		});

		return new Response(tapped, {
			headers: resp.headers,
			status: resp.status,
			statusText: resp.statusText,
		});
	};
	dbg("[stream] fetch tap installed");
}

// Global handlers so nothing fails silently, plus a per-load INIT marker (a
// fresh INIT after an action you didn't trigger means the page reloaded).
export function installInstrumentation(): void {
	installConsolePatch();
	dbg(`==== INIT @ ${ms()}ms, url=${window.location.href}`);
	installStreamTap();

	window.addEventListener("error", (e) => {
		dbgError("window error:", e.message, `${e.filename}:${e.lineno}:${e.colno}`);
	});
	window.addEventListener("unhandledrejection", (e) => {
		dbgError("unhandled promise rejection:", e.reason);
	});
	window.addEventListener("beforeunload", () => {
		dbgWarn("beforeunload — page is about to unload/reload");
	});
}
