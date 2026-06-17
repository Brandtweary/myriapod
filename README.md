# Cymbiont Web

A chat-based web demo of [Cymbiont](https://github.com/Brandtweary/cymbiont) — a self-maintaining
knowledge-graph harness for LLM agents.

The bare Cymbiont repo only reads as evidence to someone who can already read code, runs only on
Linux + Hyprland, and a hiring manager will never clone it. This site is the openable artifact: the
proof that the project produced a real, working thing.

## What it is

- **An FAQ bot for Cymbiont itself** — answers questions about the project, backed by a frozen
  "stock" Cymbiont knowledge graph seeded from the project's own docs.
- **A lightweight persistent-memory chat assistant** — a genuinely usable, demo-scoped knowledge
  graph that grows as you talk, stored in your browser (`localStorage`), with export/import.
- **Live retrieval feedback** — shows the term matches and triples retrieved for each turn, so the
  knowledge graph is visible, not hidden behind the generation.

Built in TypeScript on [`@earendil-works/pi-web-ui`](https://www.npmjs.com/package/@earendil-works/pi-web-ui),
served via OpenRouter.

## Status

Early development. See the feature taskpad (local, gitignored) for the active plan.
