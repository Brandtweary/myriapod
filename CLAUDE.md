# Myriapod

A browser-local **voice agent** — the public, openable artifact. The thesis: a **frontier LLM with a
sovereign, browser-local knowledge-graph memory, metered honestly.** You talk to it (or type), it
answers, and a personal knowledge graph grows in your own browser from the conversation — every turn
shows the matched nodes and triples in gutters beside the chat, so the memory layer is on screen
rather than hidden behind the generation.

The **browser orchestrates** the whole loop: batch speech-to-text → a frontier LLM → streaming
text-to-speech, all driven in-page. The LLM is reached through a small **metering proxy** (a $10
free tier, family codes, or bring-your-own-key); the STT leg is a self-hosted
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) server (HTTP), and the TTS leg is a
self-hosted open-weight [Kyutai moshi](https://github.com/kyutai-labs/moshi) model (WebSocket). The
"run it yourself" story points people at those open components.

Motto: **maximal reuse** — lean on the framework and existing components; writing logic from scratch
(outside the new UI) is a red flag.

**PUBLISHED REPO — treat every committed byte as public** (GitHub private, the live site public;
posture is public regardless). No live knowledge-graph node labels, no personal/workspace terms, no
real hostnames, IPs, or paths in docs/comments/prompts. Bias hard against examples; genericize any
that are truly needed. **No API keys in the repo** — the only secrets (the OpenRouter owner +
provisioning keys) live server-side in `proxy/.env`, which is gitignored; the browser never holds a key.

## Architecture

The **browser orchestrates** everything — there is no orchestration backend (no turn/VAD/history
logic on a server). A single **Pi agent** (`@earendil-works/pi-agent-core`) drives *both* voice and
typed chat; the browser reaches three external services:

- **LLM** — a frontier chat model over OpenRouter (GLM 5.2; the model is hardcoded in
  `myriapod-model.ts`, the one swap point). Reached one of three ways, decided by
  `resolveServingPath()` in `main.ts`:
  - **anon-free** — a $10-per-browser token minted at the proxy's `/anon-init`, spent through the proxy.
  - **family** — a redeemed credit code → a proxy-minted sub-key, spent through the proxy.
  - **own-key** — the visitor's own OpenRouter key, calling OpenRouter **directly** (bypasses the proxy).
  Reasoning is **off** for snappiness (a spoken agent can't afford a multi-second think) — see the
  reasoning note in `myriapod-model.ts`.
- **STT (batch)** — a self-hosted Whisper HTTP endpoint. The whole utterance's PCM is resampled
  24 kHz → 16 kHz, encoded as a 16-bit mono WAV, and POSTed as `multipart/form-data`; the server
  returns `{"text":...}` JSON. Stateless — no socket, no marker protocol. `src/stt.ts`. Configured
  via `VITE_STT_BASE`.
- **TTS (streaming)** — a moshi-server WebSocket (`/api/tts_streaming`). Sentence chunks stream up as
  the LLM generates; raw 24 kHz PCM frames (`PcmMessagePack`) stream back and are paced to ~1x realtime
  (moshi bursts faster than realtime) before posting to the audio-output-processor worklet — no Opus
  decoder. `src/tts.ts`. Configured via `VITE_TTS_BASE`.

**Per-turn voice loop:** mic toggle-off → PCM → **batch STT** → transcript → `agent.prompt(transcript)`
(which runs browser-local KG retrieval and injects a `<kg-context>` block) → the LLM streams → the
assistant's text deltas are tapped off the agent lifecycle, cut into sentences by a chunker, and
spoken via **streaming TTS** (so audio starts while the text is still generating). Typed chat is the
*same agent* without the audio legs. The mic toggle owns the turn boundary; there is no server VAD.

**The metering proxy (`proxy/`) is the only backend** — Bun + Hono + `bun:sqlite`. It holds the
OpenRouter owner key server-side, mints/recovers anon and family principals, meters real per-call
cost against them, and enforces caps. It's a cheap always-on spine, deliberately separate from the
GPU-hosted STT/TTS (so the site survives the GPU lease lapsing — TTS/STT sit behind swappable
`SpeechSynthesizer` / `transcribe` seams). Run it with `bun run server.ts` on `127.0.0.1:8790`.

- **Frontend** — TypeScript fork of the `@earendil-works/pi-web-ui` example app (Lit 3 + mini-lit +
  Tailwind v4, Vite, static SPA). Retrieval, the personal graph, and ingestion all run in-page.
- **One hardcoded model** (`src/myriapod-model.ts`) — a frontier model over OpenRouter, reasoning off.
  No model picker, no thinking-level selector. The cost field is approximate (the stats line); the
  proxy meters the *true* per-call cost from OpenRouter's usage.
- **One knowledge graph** — the personal graph: mutable, per-browser, persisted to IndexedDB,
  **PPR-only** (no embeddings, no MMR). It starts empty and grows via ingestion. Writes are **opt-in**
  (a one-time consent gate).
- **`src/kg/` is the retrieval + ingestion implementation** — pure TypeScript, running entirely
  in-page over IndexedDB; there is no server-side retrieval.

## Repo Layout

- **src/** — the frontend.
  - **main.ts** — app entry + the heart. Agent construction, `resolveServingPath()` (own-key / family /
    anon) + the `/anon-init` grant flow + BotD/honeypot bot-gates, the Design-2 retrieval injection
    wrapper around `agent.prompt`, the lifecycle listener (persistence, repaint, ingestion scheduling,
    **the voice TTS tap**), gutter rendering, the voice capture wiring (STT → `agent.prompt` → tap →
    TTS), personal-graph load/save, memory-consent state, and session management.
  - **stt.ts** — batch speech-to-text. `PcmRecorder` (a mic AudioWorklet capturing 24 kHz Float32) +
    `WhisperClient` (stateless HTTP: resample 24 → 16 kHz, encode a 16-bit mono WAV via `DataView`,
    POST it as `multipart/form-data`, return `{"text"}`). `connect()`/`close()` are no-ops.
  - **tts.ts** — streaming text-to-speech. A token→sentence `SentenceChunker`, and `KyutaiTtsSynthesizer`
    (the `SpeechSynthesizer` seam: `speak(textStream)` / `speak(text)` / `stop()`) over a moshi
    `/api/tts_streaming` msgpack WS — sentence in (one session per sentence), raw PCM out
    (`PcmMessagePack`). moshi bursts faster than realtime, so frames are queued and released to the
    audio-output-processor worklet on a ~1x realtime clock — the pacing Unmute's backend used to do
    (see the pacing note in the file); without it the worklet buffer overflows and garbles long replies.
    EOS = `{type:"Eos"}`; output frames = `{type:"Audio", pcm}`.
  - **myriapod-model.ts** — the single hardcoded chat model (GLM 5.2 over OpenRouter) + `proxyChatModel()`
    (the same model pointed at the metering proxy) + the proxy base/provider constants. Carries the
    load-bearing **reasoning note**: `reasoning:true` + `THINKING_LEVEL:"off"` makes pi-ai emit
    `reasoning:{effort:"none"}`, which the model honors as OFF — `reasoning:false` would send nothing and
    let the model think by default.
  - **grant-modal.ts** — the first-interaction welcome / $10-credit modal (anon path). Credits are
    accept ("Start chatting") vs. bring-your-own-key ("Use my own OpenRouter key" → Settings). The
    **memory opt-in rides inline as a pre-checked toggle** here, so first launch is a single pop-up
    rather than stacking the consent modal on top. Also carries the two zero-friction bot gates sent to
    `/anon-init`: a CSS-hidden **honeypot** field and a **time-trap** (how long the modal was on screen
    before the click).
  - **voice.ts** — the mic button + toggle state machine (`Ctrl+Space` shortcut), browser mic-permission
    flow, and the recording indicator. Transport-agnostic: the audio transport plugs into the
    `onStart(stream) / onStop()` seam (wired to STT in main.ts). Toggle, not push-to-talk.
  - **memory-button.ts** — the memory-indicator button beside the mic. Reflects ingestion state
    (off / idle / armed / running); clicking force-flushes the queued ingestion (or offers opt-in when off).
  - **stop-audio-button.ts** — leftmost in the icon cluster. Single click cuts the current reply's audio
    (the discoverable face of `Ctrl+Alt+Space`); double click toggles a persistent TTS mute. Volume2 ↔ VolumeX.
  - **consent-modal.ts** — the standalone one-time memory opt-in modal. On the anon path the opt-in is
    folded into grant-modal instead; this fires for own-key/family visitors (who skip the welcome modal)
    and as the Settings → Memory re-prompt. Persists per browser.
  - **settings.ts** — `MemoryTab` (consent toggle), `OpenRouterKeyTab` (the **Access** tab: bring-your-own
    OpenRouter key + family-code redemption + hosted-balance readout), and `ExportTab` (personal-graph
    download/import — the real durability story, since IndexedDB can be evicted).
  - **custom-messages.ts** — custom message types + renderers + `customConvertToLlm`. Maps the hidden
    `kg-context` breadcrumb and the `compactionSummary` (wrapped in the canonical prefix/suffix) to user
    messages for the model; renders the `voice-pending` placeholder (a user-side bubble with an undulating
    typing-indicator) shown while the mic records. `voice-pending` has no `convertToLlm` case, so it stays
    model-invisible and is removed before the real transcript lands.
  - **kg-tools.ts** — two native Pi `AgentTool`s over the personal graph: `kg_search` (literal text
    search via `Graph.searchText`) and `kg_dump` (bounded top-N graph overview, hard-capped at 500 nodes
    to protect the context window). Plus their compact tool renderers. Tools take a `() => Graph` accessor
    (the graph is reassigned on import/delete).
  - **web-tools.ts** — the browser half of `web_search`: a `fetch` to the proxy's `/v1/web-search`
    + the `AgentTool` + its renderer. Registered on **every** serving path — web search is universal.
    The endpoint is open (per-IP rate-limited, not principal-gated): owner-funded paths send their proxy
    bearer, own-key sends none (so its OpenRouter key never reaches the proxy).
  - **debug.ts** — `[myriapod]`-prefixed instrumentation (dev-only; posts to the Vite `/__log` route).
  - **theme.css** / **app.css** — a black / white-text / neon-green palette over pi-web-ui's tokens.
  - **kg/** — the TS retrieval + ingestion implementation:
    - **graph.ts** — `Graph`: load + label/stem/term indexes + `termMatch`, plus the mutable personal-graph
      API (`getOrCreate` / `addLink` / `expireLink` / `serialize`) and `DescriptionTooLongError`.
    - **seeds.ts** · **ppr.ts** — seed extraction and networkx-faithful PageRank. (No `mmr.ts` — MMR was a
      no-op without embeddings and was removed.)
    - **retrieve.ts** — `retrieveVacuum()` runs seeds → PPR overfetch → predicate-shadow dedup → per-head
      cap → top-N → term-match → doc cap, returning the **vacuum** set. `retrieve()` wraps it with
      per-session ledger dedup and assembles the `<kg-context>` injection block.
    - **ingest.ts** · **extraction-prompts.ts** — personal-graph ingestion (LLM extraction → tolerant parse
      → upsert-by-label + orphan-drop + clause merge + expirations). `makeCompletion` is an
      endpoint-agnostic OpenAI-compatible completion seam (sends `reasoning:{enabled:false}` — extraction
      must not think).
    - **ledger.ts** — `InjectedLedger`: per-session dedup for the accumulating `<kg-context>` breadcrumb.
    - **stem.ts** — Porter stemmer (opt-in, effectively unused) + always-on `depluralize()`.
    - **config.ts** · **types.ts** · **stopwords.ts** — tunables, shapes, NLTK stopword list.
- **proxy/** — the metering backend (Bun, never bundled into the frontend). `server.ts` (Hono app:
  `/anon-init`, `/v1/chat/completions`, `/redeem`, `/balance`, `/health`, `/voice/*`), `db.ts` (`bun:sqlite`:
  principals / usage_log / family_codes / anon_ips), `openrouter.ts` (forward + meter; mint sub-keys),
  `anon.ts` (the grant gates), `voice-broker.ts` (the voice-session broker, below), `config.ts`,
  `mint-code.ts` (CLI to mint family codes), `anon.test.ts` + `voice-broker.test.ts`.
  Real keys + caps live in `proxy/.env` (gitignored); `.env.example` documents the shape.
  - **voice-broker.ts** — load-balances browser voice sessions across the configured moshi instance(s)
    with overflow queuing. In-memory, ephemeral leases (concurrency state, not money — a restart resets
    counts); capacity per instance = the moshi TTS `batch_size` (STT is now a shared Whisper endpoint, so
    the leased per-instance `sttUrl` is vestigial — `WhisperClient` ignores it). Routes (registered on the shared Hono app
    after CORS): `POST /voice/lease` → least-loaded instance with a free slot, else `202 {queued, position}`;
    `POST /voice/heartbeat` (60s keepalive; `404` on unknown lease); `POST /voice/release` (tolerates a
    `sendBeacon` text/plain body). A TTL sweeper (3× heartbeat) reclaims leases from tabs that closed
    without releasing. Config: `VOICE_INSTANCES` (JSON array of `{sttUrl,ttsUrl}`; defaults to ONE instance
    from `VOICE_STT_BASE`/`VOICE_TTS_BASE`), `VOICE_INSTANCE_CAPACITY` (default 1), `VOICE_HEARTBEAT_SEC`.
    Frontend wiring is gated on `VITE_VOICE_BROKER` (default off = the single-instance demo unchanged).
- **scripts/** — dev-time tooling (TS, never shipped): **test-graph-mutation.ts** and **test-ingest.ts**.
- **public/** — static assets fetched at runtime: the audio-output worklet (`audio-output-processor.js`,
  playback) and the mic-capture worklet (`pcm-recorder-processor.js`), ported from Unmute's frontend so
  the wire format matches. Neither audio leg uses Opus (STT POSTs a 16-bit PCM WAV, TTS receives raw
  PCM), so no Opus encode/decode runs in the browser.
- **vite.config.ts** — Tailwind, a dev `/__log` middleware, and a **build-only** CSP injector
  (`script-src 'self'`; `connect-src` = self + OpenRouter + the proxy origin + the STT/TTS WS origins,
  derived from `VITE_PROXY_BASE` / `VITE_STT_BASE` / `VITE_TTS_BASE`).
- **.env.local** — dev frontend config (NO keys): `VITE_PROXY_BASE`, the optional voice WS overrides, and
  the optional `VITE_VOICE_BROKER` flag (default off; on = route voice through the proxy's `/voice/*` broker
  with leased per-instance STT/TTS URLs instead of the single hardcoded base).
- **index.html** · **tsconfig.json** · **package.json** — SPA scaffold, TS config, pinned deps.

## How it works (the non-obvious parts)

- **One agent, one injection path.** Voice and typed chat both ride the *same* Pi agent, so both use the
  same Design-2 injection: a wrapper around `agent.prompt()` runs retrieval *before* the run's context
  snapshot, updates the gutters with the full **vacuum** set, and appends a hidden `kg-context` breadcrumb
  to `agent.state.messages`. The breadcrumb accumulates across turns (like Claude Code's
  `additionalContext`), so a per-session **ledger** dedup is correct rather than lossy. The gutters
  deliberately show the pre-dedup vacuum (the "small lie" — what *would* retrieve this turn).
- **History bounding (compaction).** The `agent.prompt` wrapper, before retrieval, estimates context
  tokens and — once over `DEFAULT_COMPACTION_SETTINGS` threshold — summarizes the older messages and
  replaces them with a single `compactionSummary` message (recent turns kept, cut on a user boundary so a
  turn is never split). Uses pi-agent-core's message-level primitives (`shouldCompact`,
  `estimateContextTokens`, `estimateTokens`, `generateSummary`, `createCompactionSummaryMessage`); the
  high-level `compact()`/`prepareCompaction()` are SessionTree-oriented and don't fit the flat message
  array. `customConvertToLlm` MUST keep a `compactionSummary` case or the summary is dropped and history
  vanishes. At ~1M context this rarely fires.
- **The voice TTS tap.** A voice-initiated turn sets `voiceTurnSpeaking`, held for the *whole* turn
  (across any tool-call round-trip) and retired only at `agent_end`. The lifecycle listener lazily opens
  a TTS speaker on the **first `text_delta` of each assistant message** — never on `message_start` — and
  streams that message's `text_delta`s into an async queue the synthesizer drains through its sentence
  chunker; `message_end` closes the queue. Lazy-open is what makes tool turns work: the tool-call
  assistant message (little/no spoken text) never opens a speaker, while the *final* answer — a separate
  assistant message emitted after the tool result — opens its own speaker and speaks. `toolResult`
  messages never emit `text_delta`, so they stay silent. The listener stays cheap (the core *awaits* each
  listener — heavy work stalls the run). Typed turns leave `voiceTurnSpeaking` false and stream silently.
  Barge-in cuts only the audio (`synth.stop()` + a `voiceMsgDone` guard so trailing deltas don't re-open
  a speaker); the LLM keeps generating.
- **Serving path + metering.** `resolveServingPath()` runs first in `createAgent`: own-key → the model
  pointed at OpenRouter direct; family/anon → `proxyChatModel()` (pointed at the proxy) with the proxy
  bearer pre-seeded into the `myriapod` provider slot. The first anonymous interaction (mic toggle or
  send) pops the welcome modal, collects the honeypot + time-trap + BotD verdict, and mints the $10
  grant at `/anon-init`. Chat *and* ingestion ride the same path, so the proxy meters both against one
  principal. **Self-heal:** `ensureAnonGrant()` probes a stored grant token against `/balance` before
  use; if the proxy has forgotten it (DB reset, expired) the token is cleared and the modal re-fires to
  mint a fresh one — no stale-401 dead-end.
- **Opt-in memory, default-on.** Nothing is ingested until the visitor consents. On the anon path the
  opt-in is a pre-checked toggle inside the welcome modal (one pop-up); own-key/family visitors get the
  standalone consent modal. Firing the welcome modal on **mic-start** (not at send) settles both the
  grant and consent before recording, so neither interrupts an utterance. The choice persists in
  IndexedDB and is toggleable in Settings → Memory.
- **Debounced, batched, serialized ingestion.** Ingestion does NOT fire per turn. Exchanges accumulate and
  flush as one extraction once the conversation has been quiet for ~15s. The memory button force-flushes.
  Two extractions never run at once — a flush that lands mid-run is honored when the current one finishes.
- **depluralization** is the one always-on normalization (so "knowledge graphs" hits the singular node).
  Porter stemming is opt-in and effectively unused.

## pi-web-ui workarounds (why the frontend looks weird)

The bundled example app is broken in all published versions; these are load-bearing, not cruft:

- **Vanishing messages** — pi-agent-core mutates `state.messages` in place, so `<message-list>`
  (identity-only reactivity) never re-renders. `forceChatRepaint()` reassigns a fresh array on
  `message_end`/`agent_end`. (The example also listens for a phantom `state-update` event that never
  fires — we bind to the raw lifecycle events instead.)
- **Mount-once ChatPanel** — the panel is self-sufficient; mount it once outside the reactive render root
  and never re-render it (re-committing it mid-turn wiped the stream). Toggle visibility only.
- **Artifacts overwritten with real tools** — `ChatPanel` hardwires an `artifacts` tool + side panel
  regardless of `toolsFactory` (it prepends `[artifactsPanel.tool, ...toolsFactory()]`). We reassign
  `agent.state.tools` after `setAgent` to our own set — `kg_search` + `kg_dump`, plus `web_search` on the
  owner-funded paths — which drops the artifacts tool and its side panel. The single reassignment covers
  newSession AND loadSession (the per-turn context snapshot and the prompt wrapper don't touch
  `state.tools`).
- **Listener async-safety** — core awaits each listener; a throw or heavy work stalls the run and wipes
  the in-flight message. The whole listener body is try/caught and only re-renders on meaningful events.

## Conventions & commands

- **Commands:** `npm run dev` (Vite + HMR), `npm run build` (prod build + strict CSP), `npm run check`
  (`tsc --noEmit`). Dev tests: `npx tsx scripts/test-graph-mutation.ts` and `npx tsx scripts/test-ingest.ts`
  after any `src/kg/` change. Proxy: `cd proxy && bun run server.ts` (serve) / `bun test` (its suite).
- **Endpoints are env-configured.** `VITE_PROXY_BASE` (the metering proxy) and `VITE_STT_BASE` /
  `VITE_TTS_BASE` (the moshi voice WebSockets) default to local/dev targets and are overridden at build
  time for deploy (a `wss://` host in prod). The own-key path always goes to OpenRouter direct. The
  build-only CSP's `connect-src` is derived from these.
- **Versions are pinned** — the whole `@earendil-works/*` suite is locked at 0.75.3 (an `overrides`
  block forces it); upgrading emits the identical broken event set. The chat model is hand-built because
  it's absent from that version's frozen registry.
- **Single model, metered.** The model and reasoning level are hardcoded; the picker and thinking
  selector are hidden. Reasoning is off (snappiness). The stats line shows real $ (the proxy meters the
  true cost; ingestion cost is folded into the session total for the readout).
</content>
