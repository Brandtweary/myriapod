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
| **Voice** | Cloud STT/TTS through the metering proxy's audio routes, or self-host your own OpenAI-compatible ASR/TTS behind them, or go **text-only** | Optional |
| **Embeddings** | An embedding-inference container behind the proxy | Optional (dedup degrades to string similarity) |
| **Web search** | A SearXNG instance behind the proxy | Optional |

The minimal path: build the SPA, serve it over HTTPS, and let visitors paste their own OpenRouter
key. No server-side code at all. Add the proxy when you want to fund visitors (it also carries voice —
the speech legs forward to a cloud audio provider through it); add embeddings and search to round out
memory and tools.

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
| `VITE_PROXY_BASE` | Metering-proxy origin (chat on owner-funded paths, plus web search + embed + audio). | `http://127.0.0.1:8790/v1` | Yes, unless pure own-key with no web search, embeddings, or voice |
| `VITE_STT_BASE` | Batch speech-to-text — the proxy's `/v1/audio/transcriptions` route. | `https://your-domain.example/v1/audio/transcriptions` | Only for voice input |
| `VITE_TTS_BASE` | Sentence-batched speech-out — the proxy's `/v1/audio/speech` route. | `https://your-domain.example/v1/audio/speech` | Only for voice output |
| `VITE_VOICE_BROKER` | Vestigial voice-session broker. | `0` | No — **keep `0`** (nothing to lease with shared cloud audio) |

Leave the voice vars unset for a **text-only** deployment — typed chat works fully without them.

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
| `STT_MODEL` | Server-forced transcription model for `/v1/audio/transcriptions`. | a Whisper model id | No |
| `TTS_MODEL` | Server-forced speech model for `/v1/audio/speech`. | an open-weight speech model id | No |
| `TTS_VOICE` | Default voice for `TTS_MODEL` (the browser may request another voice the model exposes). | model-dependent | No |
| `ALLOWED_ORIGIN` | CORS allow-list; comma-separated for several. | `http://localhost:5173` | **Yes** — see gotcha |
| `TRUSTED_PROXY` | Peer IPs whose `X-Forwarded-For` is trusted. | empty | See gotcha |
| `DB_PATH` | SQLite file path. | `./myriapod-proxy.db` | No |
| `HOST` | Bind host. | `0.0.0.0` | No |
| `PORT` | Bind port. | `8790` | No |

The proxy also carries the two audio routes `/v1/audio/transcriptions` and `/v1/audio/speech`: per-IP
rate-limited passthroughs that inject the owner key and forward to a cloud audio provider under the
server-forced `STT_MODEL` / `TTS_MODEL` (so the key can never fund an arbitrary audio model). The old
`/voice/*` lease broker and its `VOICE_*` vars are vestigial — the cloud audio endpoints are shared and
stateless, so there is nothing to lease; leave `VITE_VOICE_BROKER=0`.

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

## Voice (STT + TTS)

Both speech legs ride the metering proxy's audio routes — there are **no dedicated voice servers** in
the default deploy. The proxy holds the owner key and forwards each call to a cloud audio provider
under a server-forced model (`STT_MODEL` / `TTS_MODEL`). Point `VITE_STT_BASE` / `VITE_TTS_BASE` at the
proxy's `/v1/audio/transcriptions` / `/v1/audio/speech` and voice works with nothing else to run. For a
text-only site, leave both vars unset.

**STT — batch transcription.** The browser encodes the whole utterance as a 16-bit mono WAV and POSTs
it as `multipart/form-data` (the `file` field) to `/v1/audio/transcriptions`. The proxy injects the key
+ `STT_MODEL` and forwards to the provider's OpenAI-compatible `/audio/transcriptions`, returning
`{text, usage}` JSON. Stateless — one request per utterance.

**TTS — sentence-batched speech.** The frontend splits the reply into sentences and POSTs each to
`/v1/audio/speech` as `{input, voice?, response_format?}`. The proxy injects the key + `TTS_MODEL` +
default `TTS_VOICE` and forwards to the provider's `/audio/speech`, streaming back raw audio. The
default `response_format` is `pcm` (raw 16-bit LE mono 24 kHz), played by the audio worklet with no
decode. Sentence N+1 is fetched while sentence N plays, so latency approximates streaming and playback
is gapless.

**Self-host instead of cloud (optional).** Both routes speak a plain OpenAI-compatible API, so you can
run your own ASR/TTS and point the proxy (or dedicated reverse-proxy routes) at them. The compose
template ships a commented faster-whisper block as a starting point; any server speaking the
`/audio/transcriptions` and `/audio/speech` shapes slots in the same way.

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
2. **TLS.** The mic (`getUserMedia`) requires a secure context, so HTTPS is mandatory, not optional.

The one-box [`Caddyfile.example`](./templates/Caddyfile.example) does all of it: serves the built SPA
with an SPA fallback, reverse-proxies the API routes (including the `/v1/audio/*` speech routes) to the
metering proxy, and auto-provisions a Let's Encrypt certificate from a real domain. Because Caddy
forwards `X-Forwarded-For` automatically, this layout wants `TRUSTED_PROXY=127.0.0.1` on the proxy.

> **Firewall — allow inbound 80 and 443.** A default-deny firewall (ufw, a cloud security group, a
> VPS provider default) that permits only SSH makes the site unreachable with a *timeout* (not a
> "connection refused"), and it will fail the Let's Encrypt challenge. `sudo ufw allow 80,443/tcp` or
> the equivalent.
