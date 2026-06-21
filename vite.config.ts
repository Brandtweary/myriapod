import { appendFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

// Dev-only: receive browser logs POSTed to /__log and append them to a file the
// coding agent can read directly (no copy-paste from the console). The browser
// side lives in src/debug.ts. Disabled automatically in production builds (the
// middleware only registers on the dev server).
const DEBUG_LOG_FILE = "/tmp/cymbiont-web-debug.log";
function debugLogPlugin(): Plugin {
	return {
		name: "cymbiont-debug-log",
		configureServer(server) {
			server.middlewares.use("/__log", (req, res) => {
				if (req.method !== "POST") {
					res.statusCode = 405;
					res.end();
					return;
				}
				let body = "";
				req.on("data", (chunk) => {
					body += chunk;
				});
				req.on("end", () => {
					try {
						appendFileSync(DEBUG_LOG_FILE, body.endsWith("\n") ? body : `${body}\n`);
					} catch {
						// best-effort; never break the dev server over a log write
					}
					res.statusCode = 204;
					res.end();
				});
			});
		},
	};
}

// Strict Content-Security-Policy, injected ONLY into the production build (dev
// would break: Vite's HMR client needs inline scripts). This is the proactive
// browser-security measure for the own-key storage posture — `script-src 'self'`
// (no inline) shuts the XSS key-exfiltration vector; `connect-src` is limited to
// OpenRouter (own-key direct path) and the proxy origin (owner-funded path).
function cspPlugin(): Plugin {
	const proxyBase = process.env.VITE_PROXY_BASE ?? "http://127.0.0.1:8790/v1";
	const proxyOrigin = new URL(proxyBase).origin;
	const csp = [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'", // lit/mini-lit/Tailwind inject inline styles; low-risk vs script
		"img-src 'self' data:",
		"font-src 'self' data:",
		`connect-src 'self' https://openrouter.ai ${proxyOrigin}`,
		"base-uri 'self'",
		"form-action 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
	].join("; ");
	return {
		name: "cymbiont-csp",
		apply: "build",
		transformIndexHtml() {
			return [
				{
					tag: "meta",
					attrs: { "http-equiv": "Content-Security-Policy", content: csp },
					injectTo: "head",
				},
			];
		},
	};
}

export default defineConfig({
	plugins: [tailwindcss(), debugLogPlugin(), cspPlugin()],
	server: {
		watch: {
			// Don't let edits to docs/notes living in the repo root (e.g. the
			// feature taskpad) trigger an HMR reload of the running app.
			ignored: ["**/*.md", "**/.git/**"],
		},
	},
});
