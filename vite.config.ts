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

export default defineConfig({
	plugins: [tailwindcss(), debugLogPlugin()],
	server: {
		watch: {
			// Don't let edits to docs/notes living in the repo root (e.g. the
			// feature taskpad) trigger an HMR reload of the running app.
			ignored: ["**/*.md", "**/.git/**"],
		},
	},
});
