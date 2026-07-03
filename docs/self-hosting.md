# Self-hosting Myriapod

Every model in the stack has published weights and every backend is open, so you can stand the
whole thing up on your own hardware and answer to no hosted service. This repo is the frontend — a
static SPA. What you host behind it is up to which features you want.

## Overview

The frontend needs, at minimum, a language model to talk to. Everything else is optional and
fails soft.

| Capability | How | Needed? |
|---|---|---|
| **LLM** | Bring-your-own OpenRouter key (browser → OpenRouter direct, **zero backend**), or run the metering proxy | One or the other |
| **Voice** | Your own Whisper (HTTP) + moshi (WebSocket), or go **text-only** | Optional |
| **Embeddings** | An embedding-inference container behind the proxy | Optional (dedup degrades to string similarity) |
| **Web search** | A SearXNG instance behind the proxy | Optional |

The minimal path: build the SPA, serve it over HTTPS, and let visitors paste their own OpenRouter
key. No server-side code at all. Add the proxy when you want to fund visitors; add the voice servers
when you want speech; add embeddings and search to round out memory and tools.

The backends are provided as a sanitized [`docker-compose.yml`](./templates/docker-compose.yml)
template and a one-box [`Caddyfile.example`](./templates/Caddyfile.example) reverse proxy.

## Frontend configuration

Copy `.env.example` to `.env.local` for dev, or set the same vars in your build environment for a
production build. **No API keys ever go here** — the browser never holds a key.

The build-time CSP `connect-src` is **derived from these endpoint vars**, so setting them also scopes
the CSP. There is no separate CSP file to edit; point the vars at your endpoints and the build allows
exactly those origins.

> **Building for production:** pass the prod values explicitly on the build command (e.g.
> `VITE_PROXY_BASE=… VITE_VOICE_BROKER=0 npm run build`). Vite loads `.env.local` in *all* modes, so a
> dev override left there silently rides into a production build.

| Var | Purpose | Example / default | Required? |
|---|---|---|---|
| `VITE_PROXY_BASE` | Metering-proxy origin (chat on owner-funded paths, plus web search + embed). | `http://127.0.0.1:8790/v1` | Yes, unless pure own-key with no web search or embeddings |
| `VITE_STT_BASE` | Whisper HTTP endpoint (batch speech-to-text). | `https://your-domain.example/api/asr-http` | Only for voice input |
| `VITE_TTS_BASE` | moshi TTS WebSocket (streaming speech-out). | `wss://your-domain.example/api/tts_streaming` | Only for voice output |
| `VITE_TTS_VOICE` | moshi voice id / server-side path. | stock male voice | No |
| `VITE_TTS_AUTH` | moshi `auth_id`; must match the server's `authorized_ids`. | demo token | No |
| `VITE_TTS_CFG_ALPHA` | Classifier-free-guidance strength. | `1.5` | No |
| `VITE_STT_AUTH` | Bearer token if your Whisper endpoint is auth-gated. | none | No |
| `VITE_VOICE_BROKER` | Enable the proxy's `/voice/*` lease broker. | `0` | No — **keep `0`** unless running multiple moshi instances |

Leave the voice vars unset (and don't run the voice servers) for a **text-only** deployment — typed
chat works fully without them.

## LLM: own key vs own proxy

**Own key — the zero-backend path.** Set nothing server-side. The visitor pastes their own OpenRouter
key in **Settings → Access**, and their browser calls OpenRouter directly, bypassing the proxy
entirely. This is the whole deployment if you don't want to fund anyone's usage. (Web search and
embeddings still route through the proxy, so run it too if you want those — or drop them.)

**Own proxy — fund your visitors.** Run the metering proxy when you want an anonymous free tier or
family credit codes: the proxy holds your OpenRouter owner key server-side, mints per-visitor
principals, meters real per-call cost, and enforces caps. See [`../proxy/README.md`](../proxy/README.md)
for running it, and the table below for its configuration.

## The metering proxy (optional)

Bun + Hono + SQLite; the only server-side piece Myriapod ships. Copy `proxy/.env.example` to
`proxy/.env` and fill it in. The keys stay server-side — gitignored, never bundled.

| Var | Purpose | Default | Required? |
|---|---|---|---|
| `OWNER_OPENROUTER_KEY` | The key the proxy spends on free-tier visitors. Never shipped to the browser. | — | Yes, for any owner-funded path |
| `OPENROUTER_PROVISIONING_KEY` | Management-only key that lets `/redeem` mint family sub-keys. Blank → family tier disabled (`/redeem` → 503). | — | No |
| `FAMILY_LIMIT` | Hard lifetime spend cap (USD) per minted family sub-key; enforced by OpenRouter itself. | `100` | No |
| `FREE_GRANT_USD` | One-time lifetime credit granted per new IP. | `10` | No |
| `FREE_DAILY_CAP_USD` | Global daily ceiling across all free-tier spend. | `50` | No |
| `NEW_IP_PER_DAY` | Max new IPs granted free credit per day. | `5` | No |
| `FAMILY_MONTHLY_CAP_USD` | Monthly aggregate across all family tokens. | `200` | No |
| `MONTHLY_CAP_USD` | Overall monthly ceiling across free + family. | `300` | No |
| `MAX_TOKENS_CAP` | Hard `max_tokens` ceiling injected per request. | `32000` | No |
| `MAX_INPUT_CHARS` | Reject request bodies larger than this. | `200000` | No |
| `COST_CEIL_PER_MTOKEN` | Conservative $/1M-token bound; pre-reserves credit and is the fallback debit when usage is missing. | `8` | No |
| `ALLOWED_MODELS` | Comma-separated allowlist of model ids the owner-funded paths may request. | the frontend model id | No |
| `UPSTREAM_TIMEOUT_MS` | Hard ceiling on a single upstream request so a dead connection fails fast. | `120000` | No |
| `OPENROUTER_BASE` | OpenRouter API base. | `https://openrouter.ai/api/v1` | No |
| `SEARXNG_BASE` | Self-hosted SearXNG backing `/v1/web-search`. | `http://127.0.0.1:8888` | No |
| `EMBED_BASE` | Self-hosted embedding-inference backing `/v1/embed`. | `http://127.0.0.1:8082` | No |
| `ALLOWED_ORIGIN` | CORS allow-list; comma-separated for several. | `http://localhost:5173` | **Yes** — see gotcha |
| `TRUSTED_PROXY` | Peer IPs whose `X-Forwarded-For` is trusted. | empty | See gotcha |
| `DB_PATH` | SQLite file path. | `./myriapod-proxy.db` | No |
| `HOST` | Bind host. | `0.0.0.0` | No |
| `PORT` | Bind port. | `8790` | No |

Multi-instance voice adds `VOICE_INSTANCES` / `VOICE_STT_BASE` / `VOICE_TTS_BASE` /
`VOICE_INSTANCE_CAPACITY` / `VOICE_HEARTBEAT_SEC` / `VOICE_MAX_LEASE_SEC` — ignore these unless you set
`VITE_VOICE_BROKER=1` and run more than one moshi instance.

> **Gotcha — `TRUSTED_PROXY`.** Behind a reverse proxy, if this is unset, **every visitor's IP
> collapses to the reverse proxy's IP** — so all visitors share one rate-limit and free-grant bucket,
> and the per-IP guards are meaningless. Set it to the reverse proxy's peer IP (e.g. `127.0.0.1` for a
> co-located Caddy) so the proxy reads the real client IP from `X-Forwarded-For`. **Never set it to
> `*` if the proxy is directly internet-exposed** — that lets anyone spoof `X-Forwarded-For` and
> defeat every per-IP protection.

> **Gotcha — `ALLOWED_ORIGIN`.** This is the CORS allow-list. It **must** be your public site origin
> (e.g. `https://your-domain.example`) or the browser cannot reach the proxy at all. Comma-separate if
> you serve the SPA from several origins.

> **Backstop — set a daily spend limit on the OpenRouter owner key** in the OpenRouter dashboard. The
> proxy's caps are the first line; a hard limit on the key itself is the last one if anything slips.

Run the proxy under a supervisor in production (a bare `bun run server.ts` has no auto-restart) — a
[`myriapod-proxy.service`](./templates/myriapod-proxy.service) systemd unit template is in `templates/`.

## Voice servers

Two speech backends stand behind the voice loop. Both are in the compose template; stand up whichever
legs you want (input, output, or both). For a text-only site, run neither.

**STT — Whisper over HTTP.** A faster-whisper server exposing the OpenAI-compatible
`POST /v1/audio/transcriptions` endpoint (multipart file upload, `response_format=json` →
`{"text": ...}`). The browser resamples the whole utterance to 16 kHz mono WAV and POSTs it; the
server returns the transcript. Any Whisper server speaking that OpenAI API shape works.

`VITE_STT_BASE` points at `/api/asr-http` on your site origin; the `Caddyfile.example` rewrites that
path to the server's real `/v1/audio/transcriptions` before proxying (keeping STT off the `/v1/*`
namespace the metering proxy owns). If you expose Whisper on its own origin instead, point
`VITE_STT_BASE` straight at `…/v1/audio/transcriptions`.

**TTS — Kyutai moshi over WebSocket.** The browser speaks moshi's `PcmMessagePack` protocol over the
`/api/tts_streaming` WebSocket: raw 24 kHz mono PCM frames over msgpack, a `{type:"Ready"}` handshake,
`{type:"Text"}` / `{type:"Eos"}` sent up, `{type:"Audio", pcm:[...]}` received. Auth is the `auth_id`
query param, which must match moshi's `tts.toml` `authorized_ids`. Set the voice and auth from the
frontend via `VITE_TTS_VOICE` / `VITE_TTS_AUTH`.

**moshi-server is built from source** — it is *not* a docker-pull-able published image. Clone and
build it from Kyutai's open repos:

- [github.com/kyutai-labs/unmute](https://github.com/kyutai-labs/unmute) (vendors moshi-server)
- [github.com/kyutai-labs/moshi](https://github.com/kyutai-labs/moshi)

Follow the unmute build, then run `worker --config configs/tts.toml`. The compose template documents
this as a commented block rather than a fake image — see the `moshi` service in
[`docker-compose.yml`](./templates/docker-compose.yml).

## Embeddings (optional)

An HF `text-embeddings-inference` container (MiniLM-class, 384-dim, CPU-only) backs the memory
pipeline's mint-time dedup via the proxy's `EMBED_BASE`. It's **fail-soft**: if it's absent or
unreachable, dedup degrades to string similarity and everything else keeps working. See the `embed`
service in the compose template.

## Web search (optional)

A SearXNG instance backs the proxy's `SEARXNG_BASE` and the frontend's `web_search` tool. The JSON
output format is **required** — the proxy fetches `?format=json`. See the `searxng` service in the
compose template for the minimal `settings.yml`.

## Reverse proxy + TLS

The metering proxy is **API-only** — it serves no static files. You need:

1. **A static host for the SPA.** `npm run build` emits `dist/`; serve those files.
2. **TLS.** The mic (`getUserMedia`) and the TTS `wss://` both require a secure context, so HTTPS is
   mandatory, not optional.

The one-box [`Caddyfile.example`](./templates/Caddyfile.example) does all of it: serves the built SPA
with an SPA fallback, reverse-proxies the API routes to the metering proxy, proxies the voice routes
to your whisper/moshi ingress, and auto-provisions a Let's Encrypt certificate from a real domain.
Because Caddy forwards `X-Forwarded-For` automatically, this layout wants `TRUSTED_PROXY=127.0.0.1` on
the proxy.

> **Firewall — allow inbound 80 and 443.** A default-deny firewall (ufw, a cloud security group, a
> VPS provider default) that permits only SSH makes the site unreachable with a *timeout* (not a
> "connection refused"), and it will fail the Let's Encrypt challenge. `sudo ufw allow 80,443/tcp` or
> the equivalent.
