// Lightweight browser instrumentation. Every message logs to the devtools
// console (prefixed `[cymbiont]`, neon green) AND, in dev, ships to the Vite
// dev server's /__log endpoint, which appends it to /tmp/cymbiont-web-debug.log
// so the coding agent can read it without copy-paste. See debugLogPlugin in
// vite.config.ts. Disabled automatically in production builds.

const STYLE = "color:#39ff14;font-weight:bold";

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
	console.log("%c[cymbiont]", STYLE, ...args);
	ship("LOG", args);
}

export function dbgWarn(...args: unknown[]): void {
	console.warn("%c[cymbiont]", STYLE, ...args);
	ship("WARN", args);
}

export function dbgError(...args: unknown[]): void {
	console.error("%c[cymbiont]", STYLE, ...args);
	ship("ERROR", args);
}

// Compact summary of an agent message list for logging.
export function summarizeMessages(messages: Array<{ role?: string }>): string {
	if (!messages || messages.length === 0) return "0 messages";
	return `${messages.length} messages`;
}

// Global handlers so nothing fails silently, plus a per-load INIT marker (a
// fresh INIT after an action you didn't trigger means the page reloaded).
export function installInstrumentation(): void {
	dbg(`==== INIT @ ${Math.round(performance.now())}ms, url=${window.location.href}`);

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
