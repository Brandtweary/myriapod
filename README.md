# Cymbiont Web

A chat-based web demo of [Cymbiont](https://github.com/Brandtweary/cymbiont) — a self-maintaining
knowledge-graph memory harness for LLM agents.

The bare Cymbiont repo only reads as evidence to someone who can already read code, runs only on
Linux + Hyprland, and a hiring manager will never clone it. This site is the openable artifact: the
proof that the project produced a real, working thing — something family and friends can actually use.

## What it is

Two faces, one app:

- **An FAQ bot for Cymbiont itself** — answers questions about the project, backed by a frozen
  "stock" knowledge graph seeded from Cymbiont's own documentation.
- **A lightweight persistent-memory chat assistant** — a genuinely usable, demo-scoped knowledge
  graph that grows as you talk, stored in your browser, with export/import for durability.

The point is to make the knowledge graph **visible**: each turn, gutters beside the chat show the
nodes matched and the relationships retrieved for your message — the memory layer is on screen, not
hidden behind the generation.

## How it works

Everything runs in the browser. Retrieval, the personal graph, and per-turn ingestion are a
TypeScript port of Cymbiont's Python knowledge-graph engine, running in-page over a static graph
asset and IndexedDB — no server round-trip for memory. The only backend is a small **metering proxy**
that holds the hosting key and meters usage, so visitors can chat without bringing anything of their own.

Three ways to reach the model:

- **Free tier** — just start chatting; a small hosted credit is granted automatically, no signup.
- **Your own key** — paste an [OpenRouter](https://openrouter.ai/) key in settings and the browser
  talks to OpenRouter directly, on your own credits.
- **Credit code** — redeem a code for hosted credits, no key required.

Two knowledge graphs are retrieved together each turn: the frozen **stock** graph (about Cymbiont)
and your **personal** graph (everything you've told it), distinguished by color in the gutters.

## Stack

TypeScript on [`@earendil-works/pi-web-ui`](https://www.npmjs.com/package/@earendil-works/pi-web-ui)
(Lit 3, Tailwind v4, Vite), served via OpenRouter. The metering proxy is a self-contained Bun + Hono
+ SQLite service in [`proxy/`](./proxy). Architecture and internals are documented in
[`CLAUDE.md`](./CLAUDE.md).

## Running locally

```sh
npm install
npm run dev        # Vite dev server with HMR
```

The free and credit-code tiers additionally need the metering proxy running — see
[`proxy/README.md`](./proxy/README.md). The own-key path works against the frontend alone.

```sh
npm run build      # production build (adds a strict CSP)
npm run check      # type-check
```

## Status

The FAQ/KG demo is built and working end-to-end — themed chat, live dual-graph retrieval, a
growing personal graph with export/import, and the metering proxy with all three serving paths.
Public deployment, a bot-challenge at the free-tier gate, and a voice front-end are later phases.
