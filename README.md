# Cymbiont Web

A browser-local **voice agent demo** of [Cymbiont](https://github.com/Brandtweary/cymbiont) — a self-maintaining knowledge-graph memory layer
for LLM agents.

The bare Cymbiont harness only reads as evidence to someone who can already read code and runs only
on Linux. This site is the openable artifact: a thing you can actually talk to. Speak or type, and a
personal knowledge graph grows in your own browser from the conversation, giving the agent memory
that persists across turns and visits.

The whole point is **sovereign, local memory over an open, self-hostable stack**. Your memory lives
only in your browser; the inference runs on open-source components anyone can stand up themselves.

## What it is

- **A voice agent** — talk to it. Speech-to-text, an open-weight LLM, and text-to-speech run as a
  streaming cascade; server-side voice-activity detection segments your turns. You can also just type.
- **A persistent-memory assistant** — as you talk, it builds a small knowledge graph from what you
  tell it. It is stored only in your browser (IndexedDB), never uploaded, and can be exported/imported
  for durability. Building memory is **opt-in**: nothing is remembered until you say yes.

The memory layer is made **visible**: each turn, gutters beside the chat show the nodes matched and
the relationships retrieved for your message — the retrieval is on screen, not hidden behind the
generation.

## How it works

Everything runs in the browser. Retrieval, the personal graph, and per-turn ingestion are a
TypeScript port of Cymbiont's Python knowledge-graph engine, running in-page over IndexedDB — no
server round-trip for memory.

The browser talks to a self-hosted inference stack over two endpoints:

- **A voice cascade** — a WebSocket to the [Kyutai Unmute](https://github.com/kyutai-labs/unmute)
  stack (STT → open-weight LLM → TTS), spoken in the OpenAI Realtime protocol.
- **An LLM endpoint** — a self-hosted OpenAI-compatible server (vLLM-style) serving the same
  open-weight model. Typed chat and personal-graph ingestion hit it directly (typed input bypasses the
  voice cascade, which only accepts audio).

Per turn, retrieval runs against your personal graph and the matched context is injected into the
prompt — accumulated as a hidden breadcrumb on the text path, and re-asserted as a decaying recency
pool on the voice path.

## Run it yourself

This repo is the hosted demo and contains no backend. To stand up the inference yourself, the
endpoints are entirely open:

- **Voice cascade** — [Kyutai Unmute](https://github.com/kyutai-labs/unmute), the open streaming
  STT → LLM → TTS cascade.
- **LLM server** — any vLLM-style, OpenAI-compatible server hosting an open-weight model.

Point the frontend at them with `VITE_LLM_BASE` (the OpenAI-compatible LLM, `…/llm/v1`) and
`VITE_CASCADE_URL` (the Unmute realtime WebSocket); both default to a local dev target and are
overridden at build time for deployment.

The agent ships with a stock system prompt (`VOICE_SYSTEM_PROMPT` in `src/main.ts`) — a deliberately
evergreen persona that names no model, version, or hardware and reaches for no tools, which suits a
cloud agent that can't assume its substrate. **If you run your own instance, swap it for a prompt that
fits your agent** — a local home agent, for example, may well want the hardware and version awareness
this one omits.

## Stack

TypeScript on [`@earendil-works/pi-web-ui`](https://www.npmjs.com/package/@earendil-works/pi-web-ui)
(Lit 3, Tailwind v4, Vite) — a static single-page app, no backend in this repo. Architecture and
internals are documented in [`CLAUDE.md`](./CLAUDE.md).

## Development

```sh
npm install
npm run dev        # Vite dev server with HMR
npm run build      # production build (adds a strict CSP)
npm run check      # type-check
```
</content>
</invoke>
