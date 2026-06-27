# Cymbiont Web

A browser-local **voice agent demo** of [Cymbiont](https://github.com/Brandtweary/cymbiont) — the public, openable artifact for a Linux-only
harness no hiring manager will ever clone. The thesis:
sovereign, browser-local AI memory running over an **open, self-hostable inference stack**. You talk
to it (or type), it answers, and a personal knowledge graph grows in your own browser from the
conversation — every turn shows the matched nodes and triples in gutters beside the chat, so the
memory layer is on screen rather than hidden behind the generation.

The inference is a streaming voice cascade (STT → open-weight LLM → TTS, the
[Kyutai Unmute](https://github.com/kyutai-labs/unmute) project) plus an OpenAI-compatible LLM server.
This repo is the **hosted demo** of that; the "run it yourself" story points people at the open
upstream components rather than shipping a backend here.

It is a *publishing* project, not a port: the harness already works, this re-renders a known-good
system for a reachable audience. Motto: **maximal reuse** — writing logic from scratch (outside the
new UI) is a red flag. The live plan, design decisions, and phase status live in the gitignored
`feature_taskpad_cymbiont_web.md`.

**PUBLISHED REPO — treat every committed byte as public** (GitHub private, the live site public;
posture is public regardless). No live knowledge-graph node labels, no personal/workspace terms, no
real hostnames, IPs, or paths in docs/comments/prompts. Bias hard against examples; genericize any
that are truly needed. Describe the self-hosted inference stack generically (a self-hosted vLLM-style
OpenAI-compatible endpoint, the Unmute cascade, an open-weight model) — never tie it to private infra.

## Architecture

**Everything runs browser-local. There is no backend in this repo** — no Python at runtime, no KG
server, no metering proxy. The browser speaks directly to a self-hosted inference stack over two
endpoints (both configurable, both on one origin in production behind TLS):

- **The voice cascade** — a WebSocket to the Kyutai Unmute stack, spoken in the OpenAI Realtime
  dialect (WS path `/api/v1/realtime`, subprotocol `realtime`). STT → open-weight LLM → TTS all run
  server-side; server-side VAD segments turns. Configured via `VITE_CASCADE_URL`.
- **The LLM endpoint** — a self-hosted OpenAI-compatible server (vLLM-style) at the `/llm/v1` path,
  serving a single open-weight model. Used by **typed chat** (text in, streamed text out, no TTS) and
  by **personal-graph ingestion**. Configured via `VITE_LLM_BASE`.

Typed chat bypasses the cascade because Unmute's WebSocket rejects typed input — so the typed path
hits the LLM endpoint directly while the voice path goes through the full cascade.

- **Frontend** — TypeScript fork of the `@earendil-works/pi-web-ui` example app (Lit 3 + mini-lit +
  Tailwind v4, Vite, static SPA). Retrieval, the personal graph, and ingestion all run in-page.
- **One hardcoded model** — a single local provider (`src/cymbiont-model.ts`), reasoning off, zero
  cost (local inference has no per-token price). No model picker, no thinking-level selector.
- **One knowledge graph** — the personal graph: mutable, per-browser, persisted to IndexedDB,
  **PPR-only** (no embeddings, no MMR — both removed). It starts empty and grows via per-turn
  ingestion. Personal-graph writes are **opt-in** (a one-time consent gate).
- **The Python `cymbiont/kg/` package is REFERENCE-ONLY** — `src/kg/` is a faithful TypeScript port
  of it, but nothing calls Python at runtime.

## Repo Layout

- **src/** — the frontend.
  - **main.ts** — app entry + the heart. Agent construction, the Design-2 retrieval injection wiring,
    the lifecycle listener (persistence, repaint, ingestion scheduling), gutter rendering, the voice
    cascade wiring (transcript → message list, KG hooks, the recency pool), personal-graph load/save,
    memory-consent state, and session management.
  - **cascade.ts** — `CascadeSession`: the WebSocket client for the Unmute voice cascade. opus-recorder
    mic capture → `input_audio_buffer.append`; `response.audio.delta` Opus packets → decode →
    AudioWorklet playback. Surfaces user + assistant transcript deltas and the VAD `speech_stopped`
    signal via callbacks. `updateInstructions()` is the seam the KG layer uses to (re)inject context.
  - **cymbiont-model.ts** — the single hardcoded chat model: provider id `cymbiont`, `baseUrl` from
    `VITE_LLM_BASE`, reasoning off, zero cost. A throwaway bearer is seeded into the provider key slot
    so pi-web-ui's pre-send key check passes (the local server ignores it).
  - **voice.ts** — the mic button + toggle state machine (`Ctrl+/` shortcut), browser mic-permission
    flow, and the recording indicator. Transport-agnostic: the actual audio transport plugs into the
    `onStart(stream) / onStop()` seam (wired to the cascade in main.ts). Toggle interaction, not
    push-to-talk: one press records, the next ends the turn.
  - **memory-button.ts** — the memory-indicator button beside the mic. Reflects ingestion state
    (off / idle / armed / running); clicking force-flushes the queued ingestion (or offers the
    consent opt-in when off).
  - **consent-modal.ts** — the one-time memory opt-in modal, shown on the first interaction (first
    send OR first mic toggle). The choice persists per browser and is changeable in Settings → Memory.
  - **settings.ts** — `MemoryTab` (consent on/off toggle) and `ExportTab` (personal-graph
    download/import — the real durability story, since IndexedDB can be evicted). No key/credit tab.
  - **custom-messages.ts** — custom message types + renderers + `customConvertToLlm` (maps the hidden
    `kg-context` breadcrumb to a user message for the model).
  - **debug.ts** — `[cymbiont]`-prefixed instrumentation (dev-only; posts to the Vite `/__log` route).
  - **theme.css** / **app.css** — a black / white-text / neon-green palette over pi-web-ui's tokens.
  - **kg/** — the TS retrieval + ingestion port (each module headers its Python source):
    - **graph.ts** — `Graph`: load + label/stem/term indexes + `termMatch`, plus the mutable
      personal-graph API (`getOrCreate` / `addLink` / `expireLink` / `serialize`) and
      `DescriptionTooLongError`.
    - **seeds.ts** · **ppr.ts** — seed extraction and networkx-faithful PageRank. (No `mmr.ts` — MMR
      was a no-op without embeddings and was removed.)
    - **retrieve.ts** — `retrieveVacuum()` runs seeds → PPR overfetch → predicate-shadow dedup →
      per-head cap → top-N → term-match → doc cap, returning the **vacuum** set. `retrieve()` wraps it
      with per-session ledger dedup and assembles the `<kg-context>` injection block. `assembleKgContext`
      is shared so the voice pool renders the identical format.
    - **retrieval-pool.ts** — `RetrievalPool`: the voice working-memory layer. Decaying recency set,
      hit-count TTL, capped, re-rendered whole each VAD turn.
    - **ingest.ts** · **extraction-prompts.ts** — per-turn personal-graph ingestion (LLM extraction →
      tolerant parse → upsert-by-label + orphan-drop + clause merge + expirations). `makeCompletion`
      is an endpoint-agnostic OpenAI-compatible completion seam.
    - **ledger.ts** — `InjectedLedger`: per-session dedup for the text path (the vacuum/injection split).
    - **stem.ts** — Porter stemmer (opt-in, effectively unused) + always-on `depluralize()`.
    - **config.ts** · **types.ts** · **stopwords.ts** — tunables, shapes, NLTK stopword list.
- **scripts/** — dev-time tooling (TS, never shipped): **test-graph-mutation.ts** and
  **test-ingest.ts** — unit tests for the graph API and ingestion.
- **public/** — static assets fetched at runtime: the Opus codec workers + WASM and the audio output
  worklet (`encoderWorker.min.js`, `decoderWorker.min.js` + `.wasm`, `audio-output-processor.js`),
  ported from Unmute's own frontend so the wire format matches.
- **vite.config.ts** — Tailwind, a dev `/__log` middleware (writes `debug.ts` output to a tmp log),
  and a **build-only** CSP injector (`script-src 'self'`; `connect-src` scoped to self + the LLM
  endpoint origin + its WebSocket, derived from `VITE_LLM_BASE`).
- **index.html** · **tsconfig.json** · **package.json** — SPA scaffold, TS config, pinned deps.

## How it works (the non-obvious parts)

- **Two retrieval paths, one engine.** Both consume `retrieveVacuum()` over the personal graph, but
  inject differently because the two transports persist context differently:
  - **Text (Design 2).** A wrapper around `agent.prompt()` runs retrieval *before* the run's context
    snapshot, updates the gutters with the full **vacuum** set, and appends a hidden `kg-context`
    breadcrumb to `agent.state.messages`. The breadcrumb accumulates across turns (like Claude Code's
    `additionalContext`), so a per-session **ledger** dedup is correct rather than lossy. The gutters
    deliberately show the pre-dedup vacuum (the "small lie" — what *would* retrieve this turn).
  - **Voice (recency pool).** Unmute's `updateInstructions` REPLACES the system prompt every VAD turn,
    so anything not re-asserted vanishes. The voice path therefore keeps a decaying **recency pool**
    (`retrieval-pool.ts`) and re-injects the whole pool each turn. Entries decay by a hit-count TTL
    (recurring concepts persist, one-offs fade); caps are 12 terms / 15 triples. The gutters mirror
    the pool, not just this turn's hits.
- **Injection verification.** `cascade.ts` logs the `response.created` event's `chat_history[0]` (the
  system prompt the server is about to send the LLM) and reports whether the injected `<kg-context>`
  block is present — the injection is otherwise invisible.
- **Opt-in memory.** Nothing is ingested until the visitor grants consent. The modal fires once on the
  first interaction; the choice persists in IndexedDB and is toggleable in Settings → Memory.
- **Debounced, batched, serialized ingestion.** Ingestion does NOT fire per turn. Exchanges accumulate
  and flush as one extraction once the conversation has been quiet for ~15s (a VAD pause between turns
  is not the end; sustained silence is). The memory button force-flushes immediately. Two extractions
  never run at once — a flush that lands mid-run is honored when the current one finishes.
- **depluralization** is the one always-on normalization (strips spoken S-plurals so "knowledge
  graphs" hits the singular node). Porter stemming is opt-in and effectively unused.

## pi-web-ui workarounds (why the frontend looks weird)

The bundled example app is broken in all published versions; these are load-bearing, not cruft:

- **Vanishing messages** — pi-agent-core mutates `state.messages` in place, so `<message-list>`
  (identity-only reactivity) never re-renders. `forceChatRepaint()` reassigns a fresh array on
  `message_end`/`agent_end`. (The example also listens for a phantom `state-update` event that never
  fires — we bind to the raw lifecycle events instead.) The voice path applies the same fix: each
  transcript delta replaces the last message with a fresh object identity, not an in-place mutation.
- **Mount-once ChatPanel** — the panel is self-sufficient; mount it once outside the reactive render
  root and never re-render it (re-committing it mid-turn wiped the stream). Toggle visibility only.
- **Artifacts stripped** — `ChatPanel` hardwires an `artifacts` tool + side panel regardless of
  `toolsFactory`. We strip it from `agent.state.tools` after `setAgent` *and* override the REPL tool
  description so the model never offers it. (A demo's audience isn't doing HTML prototyping.)
- **Listener async-safety** — core awaits each listener; a throw or heavy work stalls the run and
  wipes the in-flight message. The whole listener body is try/caught and only re-renders on meaningful events.

## Conventions & commands

- **Commands:** `npm run dev` (Vite + HMR), `npm run build` (prod build + strict CSP), `npm run check`
  (`tsc --noEmit`). Dev tests: `npx tsx scripts/test-graph-mutation.ts` and
  `npx tsx scripts/test-ingest.ts` — run after any `src/kg/` change.
- **Endpoints are env-configured.** `VITE_LLM_BASE` (the OpenAI-compatible LLM, `/llm/v1`) and
  `VITE_CASCADE_URL` (the Unmute realtime WebSocket) default to a local/dev target and are overridden
  at build time for deploy. The build-only CSP's `connect-src` is derived from `VITE_LLM_BASE`.
- **Versions are pinned** — the whole `@earendil-works/*` suite is locked at 0.75.3 (an `overrides`
  block forces it); upgrading emits the identical broken event set, so it fixes nothing. The chat
  model is hand-built because it's absent from that version's frozen registry.
- **Single model, no cost.** The model and reasoning level are hardcoded; the model picker and
  thinking-level selector are hidden. Cost is zeroed so the stats line reads $0 (local inference).
</content>
</invoke>
