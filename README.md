# Cymbiont

A browser-local **voice agent** with a self-maintaining knowledge-graph memory that lives in your own
browser.

A thing you can actually talk to. Speak or type, and a personal knowledge graph grows in-page from the
conversation, giving the agent memory that persists across turns and across visits.

It's a curated stack of **open-weight models** — open speech-to-text, a frontier open-weight LLM, and
open text-to-speech — wired into one voice loop, with a memory layer you own and can see. Every model in
the path has published weights, so the whole thing is self-hostable; the hosted demo just spares you
standing up a GPU.

## What it is

- **A voice agent** — talk to it. Speech-to-text, a frontier LLM, and text-to-speech form the loop; you
  tap to talk and tap again to end your turn (turn-based, not always-listening). You can also just type.
- **A persistent-memory assistant** — as you talk, it builds a small knowledge graph from what you tell
  it, stored only in your browser (IndexedDB), never uploaded, exportable/importable for durability.
  Memory is **opt-in** — a single toggle on first launch, on by default, flippable anytime in Settings.

The memory layer is made **visible**: each turn, gutters beside the chat show the nodes matched and the
relationships retrieved for your message — the retrieval is on screen, not hidden behind the generation.

## How it works

The **browser orchestrates** the whole loop — there is no conversation backend. Retrieval, the personal
graph, and per-turn ingestion all run in-page over IndexedDB, no server round-trip for memory. Per turn,
retrieval runs against your personal graph and the matched context is injected into the prompt.

The browser drives three endpoints directly:

- **Speech-to-text** — a WebSocket to an open [Kyutai](https://github.com/kyutai-labs) moshi STT model.
  Your whole utterance is sent as one batch and comes back as a transcript.
- **The LLM** — an OpenAI-compatible chat endpoint streaming the reply. The demo serves
  [`z-ai/glm-5.2`](https://openrouter.ai/z-ai/glm-5.2) (open weights, 1M context) over OpenRouter; the
  model is swappable.
- **Text-to-speech** — a WebSocket to an open Kyutai moshi TTS model. The reply is chunked into
  sentences as it streams and spoken back, so audio starts before the model has finished writing.

## Run it yourself

This repo is the frontend. The model endpoints are all open and self-hostable:

- **STT + TTS** — open [Kyutai](https://github.com/kyutai-labs) moshi models, served over WebSockets.
  Point the frontend at them with `VITE_STT_BASE` and `VITE_TTS_BASE`.
- **The LLM** — any OpenAI-compatible chat endpoint hosting an open-weight model. The hosted demo routes
  it through a small **metering proxy** (the one server-side piece, not in this repo) that holds the
  upstream key and hands out $10 of free credits per browser so you can try it without signing up; point
  the frontend at the proxy with `VITE_PROXY_BASE`. If you bring your own OpenRouter key in Settings, the
  browser calls OpenRouter directly and the proxy is bypassed entirely.

The agent ships with a stock system prompt (`VOICE_SYSTEM_PROMPT` in `src/main.ts`) — a deliberately
evergreen persona that names no model, version, or hardware and reaches for no tools, which suits a
hosted agent that can't assume its substrate. **If you run your own instance, swap it for a prompt that
fits your agent** — a local home agent, for example, may well want the hardware and version awareness
this one omits.

## Stack

TypeScript on [`@earendil-works/pi-web-ui`](https://www.npmjs.com/package/@earendil-works/pi-web-ui)
(Lit 3, Tailwind v4, Vite) — a static single-page app; the conversation rides the
`@earendil-works/pi-agent-core` agent. Architecture and internals are documented in
[`CLAUDE.md`](./CLAUDE.md).

## Development

```sh
npm install
npm run dev        # Vite dev server with HMR
npm run build      # production build (adds a strict CSP)
npm run check      # type-check
```
