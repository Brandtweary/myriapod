# Myriapod

A browser-local **voice agent** — the public, openable artifact. The thesis: a **frontier LLM with a
sovereign, browser-local memory, tended by an every-turn multi-agent pipeline, metered honestly.**
You talk to it (or type), it answers, and after every turn a small crew of background agents reads the
exchange and grows a personal memory in your own browser — the matched terms show in the left gutter
and the pipeline's own actions scroll in the right, so the memory layer is on screen rather than
hidden behind the generation.

The **browser orchestrates** the whole loop: batch speech-to-text → a frontier LLM → streaming
text-to-speech, all driven in-page. The LLM is reached through a small **metering proxy** (a $10
free tier, family codes, or bring-your-own-key); the STT leg is a self-hosted
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) server (HTTP), and the TTS leg is a
self-hosted open-weight [Kokoro](https://github.com/hexgrad/kokoro) model served over a
msgpack WebSocket. The "run it yourself" story points people at those open components.

Motto: **maximal reuse** — lean on the framework and existing components; writing logic from scratch
(outside the new UI) is a red flag.

**PUBLISHED REPO — treat every committed byte as public** (GitHub private, the live site public;
posture is public regardless). No live memory term labels, no personal/workspace terms, no
real hostnames, IPs, or paths in docs/comments/prompts. Bias hard against examples; genericize any
that are truly needed. **No API keys in the repo** — the only secrets (the OpenRouter owner +
provisioning keys) live server-side in `proxy/.env`, which is gitignored; the browser never holds a key.

## Memory: term-based, not a graph

Memory is a **keyword router over evergreen term descriptions** — a glossary of the people, things,
and ideas in the user's world, each a label + description + aliases. Retrieval is one-hop term
matching against the conversation; there are **no edges, triples, PPR, or graph traversal** — a term
description holds the contextual nuance a bare triple loses, and recall is one-hop anyway, so a graph
buys nothing. User-facing brand: just **memory**. The exportable artifact (term glossary + speech
data + running context) is the **lexicon**.

## The per-turn pipeline (the realized thesis)

After every conversation turn (`agent_end`), one **pipeline tick** fires — fire-and-forget, so it
never blocks the chat. Three background agents, each seeing the full transcript, each riding the same
serving path (so the proxy meters them against the same principal as chat):

- **Audit agent** (tooled) — read-path QA on the turn's live wire: judges what the router retrieved
  (fixing false positives via no-stem / alias-removal / a dedicated node), fixes descriptions that
  retrieval exposed as thin/stale, merges obvious side-by-side duplicates, handles speech-to-text
  errors (logs mistranscriptions, adds auto-replace rules, escalates persistent near-misses to
  aliases), and flags what needs a human (lexicon colonization, LLM misspelling habits).
- **Memory agent** (tooled) — write-path author: mints salience-gated terms from the conversation
  (durable concepts, never occasions), evolves existing descriptions, populates aliases, and dedups
  at mint time via a similarity tool (string + embedding).
- **Summary agent** (no tools) — rewrites *this* conversation's running-context entry from the
  transcript each turn (rewrite, not append — no compounding). Runs per-turn because a browser close
  is silent, so there is no reliable end-of-session moment. The rolling running-context buffer greets
  the main agent at the start of every new conversation (cross-conversation continuity the term
  memory alone can't carry).

**Cross-turn memory = per-agent action buffers.** Each tooled agent keeps a bounded rolling log of
its own past tool calls (recorded automatically from the loop) plus a one-line self-summary, injected
into its next tick. The buffer is the signal integrator that gates destructive ops: merge / remove /
rename require the same signal to have recurred across turns, while cheap ops (description touch-ups,
minting) act immediately. There is **no global workspace and no inter-agent messaging** — agents are
organs, not correspondents.

Prompt shape (`pipeline-prompts.ts`): one shared system stub, the full transcript **first**,
role-specific instructions **last** (the transcript is an append-only shared prefix across agents and
turns — the shape provider prompt-caching rewards). No numeric anchors on expected output counts (an
anchor becomes the target; qualitative tests + a hard ceiling only). This generalizes past numbers: never pre-load an answer the agent should compute in the moment — ranges, soft biases ("prefer none", "lean toward X"), and "when in doubt" escape hatches all do the same thing. The model has no set point, so your guess doesn't *nudge* its judgment, it *replaces* it — swapping the agent's live read of the actual case for a guess you made blind to it. Write the decision procedure, not the answer; anchor only on a value verified exactly right (a real hard ceiling).

**Everything reasons — Kimi K3 is always-on.** Kimi K3 has one reasoning mode and OpenRouter accepts
only the wire effort `"max"`, so the chat agent AND all three pipeline agents think on every turn;
there is no "off" tier to spare the spoken path. pi-ai 0.80 has `"max"` natively in its `ThinkingLevel`
vocabulary, so both the chat agent (`MYRIAPOD_THINKING_LEVEL`) and the tooled pipeline agents
(`PIPELINE_THINKING`) request level `"max"` directly — pi-ai emits `reasoning: { effort: "max" }`, no
`thinkingLevelMap` needed.
The summary agent's hand-built `makeCompletion` path sets the raw wire effort `MYRIAPOD_REASONING_EFFORT`
(`"max"`) directly. The async design still matters for latency (the pipeline runs off the chat's
critical path), just no longer for a reasoning-tier difference.

## Architecture

The **browser orchestrates** everything — there is no orchestration backend (no turn/VAD/history
logic on a server). A single **Pi agent** (`@earendil-works/pi-agent-core`) drives *both* voice and
typed chat; the pipeline agents run on the same library's headless `runAgentLoop`. The browser reaches
external services:

- **LLM** — a frontier chat model over OpenRouter (Kimi K3; the model is hardcoded in
  `myriapod-model.ts`, the one swap point). Reached one of three ways, decided by
  `resolveServingPath()` in `main.ts`:
  - **anon-free** — a $10-per-browser token minted at the proxy's `/anon-init`, spent through the proxy.
  - **family** — a redeemed credit code → a proxy-minted sub-key, spent through the proxy.
  - **own-key** — the visitor's own OpenRouter key, calling OpenRouter **directly** (bypasses the proxy).
  Reasoning is **always on** (Kimi K3 has no off mode) — see the reasoning note in `myriapod-model.ts`.
- **STT (batch)** — a self-hosted Whisper HTTP endpoint. The whole utterance's PCM is resampled
  24 kHz → 16 kHz, encoded as a 16-bit mono WAV, and POSTed as `multipart/form-data`; the server
  returns `{"text":...}` JSON. Stateless. `src/stt.ts`. Configured via `VITE_STT_BASE`.
- **TTS (streaming)** — a moshi-server WebSocket (`/api/tts_streaming`). Sentence chunks stream up as
  the LLM generates; raw 24 kHz PCM frames (`PcmMessagePack`) stream back and are paced to ~1x realtime
  before posting to the audio-output-processor worklet — no Opus decoder. `src/tts.ts`. Configured
  via `VITE_TTS_BASE`.
- **Embeddings** — the pipeline's mint-time dedup embeds each term (description) via the proxy's
  `/v1/embed`, a passthrough to a self-hosted embedding-inference container (HF text-embeddings-
  inference, MiniLM-class). The 384-dim vector is stored on the term and rides the lexicon export;
  cosine similarity runs client-side. Fail-soft: if the endpoint is unreachable, dedup degrades to
  string similarity. Configured via `EMBED_BASE` on the proxy.

**Per-turn voice loop:** mic toggle-off → PCM → **batch STT** → (lexicon auto-replace rules rewrite
the transcript) → `agent.prompt(transcript)` (browser-local retrieval injects a `<memory>` block) →
the LLM streams → the assistant's text deltas are tapped off the agent lifecycle, cut into sentences,
and spoken via **streaming TTS**. Typed chat is the *same agent* without the audio legs (and skips the
STT functions). The mic toggle owns the turn boundary; there is no server VAD. On `agent_end`, the
pipeline tick fires.

**The metering proxy (`proxy/`) is the only backend** — Bun + Hono + `bun:sqlite`. It holds the
OpenRouter owner key server-side, mints/recovers anon and family principals, meters real per-call
cost against them, enforces caps, and hosts the open (rate-limited) `/v1/web-search` and `/v1/embed`
passthroughs. It's a cheap always-on spine, deliberately separate from the GPU-hosted STT/TTS/embed
(so the site survives the GPU lease lapsing — TTS/STT sit behind swappable seams; dedup degrades to
string-only). Run it with `bun run server.ts` on `127.0.0.1:8790`.

- **Frontend** — a TypeScript app over the `pi-web-ui` UI layer, whose source is **vendored** in
  `src/pi-web-ui/` (Lit 3 + mini-lit + Tailwind v4, Vite, static SPA). Retrieval, the term memory, and
  the pipeline all run in-page.
- **One hardcoded model** (`src/myriapod-model.ts`) — reasoning always on (Kimi K3). No model picker.
  The cost field is approximate (the stats line); the proxy meters the *true* per-call cost.
- **One term memory** — mutable, per-browser, persisted to IndexedDB. Starts empty; grows via the
  pipeline. Writes are **opt-in** (a one-time consent gate).
- **`src/kg/` is the memory implementation** — pure TypeScript, running entirely in-page over
  IndexedDB; there is no server-side retrieval. (The `kg/` directory name is a misnomer — the contents
  are a term store, not a graph.)

## Repo Layout

- **src/** — the frontend.
  - **main.ts** — app entry + the heart. Agent construction, `resolveServingPath()` + the `/anon-init`
    grant flow + BotD/honeypot gates, the retrieval-injection wrapper around `agent.prompt`, the
    lifecycle listener (persistence, XSS anchor-scrub, **the voice TTS tap**, the `agent_end` pipeline trigger),
    gutter rendering (term matches + activity feed), voice capture wiring (STT → auto-replace →
    `agent.prompt` → tap → TTS), lexicon load/save + export/import, memory-consent state, and session
    management. Constructs the `PipelineRuntime` and appends its running-context band to the agent's
    system prompt.
  - **pipeline.ts** — `PipelineRuntime`: the per-turn tick orchestrator. Fires audit → memory agent
    serially (both write the store; audit first) with the summary agent in parallel; coalesces a turn
    that ends mid-tick into one follow-up. Owns the per-agent action buffers, the running-context
    buffer, the STT lexicon, and the review-flags store (all in the `pipeline` IndexedDB store), and
    the in-memory activity feed. Tooled agents run on `runAgentLoop`; the summary agent is a bare
    completion. Instruments per-agent token cost.
  - **pipeline-prompts.ts** — the three agents' prompts (shared system stub + transcript-first
    assembly). Encodes the salience gate, the buffer-gated destructive-op policy, the STT auto-vs-manual
    rules, and the flag-only items.
  - **pipeline-tools.ts** — the shared tool set the tooled agents wield over the memory: add/update/
    rename/merge/remove terms, aliases, no-stem, `similar_terms` (dedup candidates), STT logging +
    auto-replace, and `flag_for_review`. Every tool records a one-line action (that stream *is* the
    action buffer and the activity feed).
  - **stt.ts** — batch speech-to-text (`PcmRecorder` + stateless `WhisperClient`).
  - **tts.ts** — streaming text-to-speech (`SentenceChunker` + `KyutaiTtsSynthesizer` over a moshi
    msgpack WS; ~1x-realtime pacing so the worklet buffer doesn't overflow).
  - **stt-lexicon.ts** — the speech-adaptation half of the lexicon: the mistranscription log + the
    auto-replace rules (`applyAutoReplace`, applied client-side to voice transcripts before display),
    and `mistranscriptionCount` (the recurrence signal for the persistent-miss → alias escalation).
  - **myriapod-model.ts** — the single hardcoded chat model + `proxyChatModel()` + the proxy
    base/provider constants. Carries the load-bearing **reasoning note** (Kimi K3 is always-on;
    thinking level `"max"` — pi-ai 0.80's native value — is the only wire effort Kimi accepts).
  - **grant-modal.ts** — the first-interaction welcome / $10-credit modal (anon path); the memory
    opt-in rides inline as a pre-checked toggle. Carries the honeypot + time-trap bot gates.
  - **voice.ts** — the mic button + toggle state machine (`Ctrl+Space`), mic-permission flow, recording
    indicator. Transport-agnostic `onStart(stream)/onStop()` seam. Toggle, not push-to-talk.
  - **memory-button.ts** — the brain-icon indicator beside the mic. Three states: off (consent not
    granted) / saved (idle) / running (any pipeline agent in flight). Click offers opt-in when off.
  - **stop-audio-button.ts** — single click cuts the current reply's audio (`Ctrl+Alt+Space`); double
    click toggles a persistent TTS mute.
  - **consent-modal.ts** — the standalone one-time memory opt-in (own-key/family path + Settings
    re-prompt; the anon path folds it into grant-modal).
  - **settings.ts** — `MemoryTab` (consent toggle + a read-only readout of the audit agent's
    human-review flags), `OpenRouterKeyTab` (the **Access** tab: own key +
    family-code redemption + hosted-balance readout), and `ExportTab` (lexicon download/import — the
    real durability story since IndexedDB can be evicted).
  - **custom-messages.ts** — custom message types + renderers + `customConvertToLlm`. Maps the hidden
    `memory-context` breadcrumb and the `compactionSummary` to user messages; renders the
    `voice-pending` placeholder (model-invisible; removed before the real transcript lands).
  - **kg-tools.ts** — two native Pi `AgentTool`s the *main chat agent* wields over the memory:
    `memory_search` (literal text search) and `memory_dump` (bounded top-N overview). Take a
    `() => Graph` accessor (the store is reassigned on import/delete).
  - **web-tools.ts** — the browser half of `web_search` (a `fetch` to the proxy's `/v1/web-search` +
    the `AgentTool` + renderer). Registered on **every** serving path — web search is universal.
  - **debug.ts** — `[myriapod]`-prefixed instrumentation (dev-only).
  - **theme.css** / **app.css** — a black / white-text / neon-green palette over pi-web-ui's tokens.
  - **pi-web-ui/** — the vendored `@earendil-works/pi-web-ui` UI layer (the abandoned upstream, copied
    from its shipped TS source: `ChatPanel`, `components/`, `dialogs/`, `storage/`, `tools/`, `utils/`,
    `prompts/`, the barrel `index.ts`, and the prebuilt Tailwind `app.css`). The app imports it by
    relative path; its own internal deps (pi-agent-core, pi-ai, mini-lit, lit) are direct npm deps. The
    artifacts side-panel and local-model auto-discovery are cut from the vendored tree (Myriapod drops
    the artifacts tool and hides the model picker), so the libraries those alone pulled — `highlight.js`
    (kept only transitively via mini-lit's `MarkdownBlock`), `@lmstudio/sdk`, and `ollama` — are out of
    the bundle. File-attachment upload IS kept (the user can attach a document and send it to the model),
    so its parsers — docx-preview / xlsx / pdfjs-dist / jszip, loaded via `utils/attachment-utils.ts` —
    remain direct deps. pi-ai's runtime functions (`streamSimple` / `complete` / `getModel` / `getModels` /
    `getProviders`) come from `src/pi-ai-slim-compat.ts` — a lean stand-in for pi-ai's side-effectful
    `/compat` barrel (which eagerly registers every provider and pulls the whole `providers/all` catalog
    into the main chunk). The shim sources them from the direct, side-effect-free entrypoints (the lazy
    `openai-completions` api — the only api Myriapod drives — plus `providers/all`'s static getters and
    the main entry's types). A Vite alias redirects `@earendil-works/pi-ai/compat` to the shim so
    pi-agent-core, which imports the barrel from its own agent loop, resolves to the lean surface too;
    the provider SDK fan-out then drops out of the bundle. The tree is MIT (Mario Zechner / Earendil);
    its `LICENSE` sits alongside the vendored source. The workarounds section below patches its
    behavior from `main.ts` rather than editing it — though since it's vendored (editable), a break the
    upstream would have caused is fixed in place.
  - **kg/** — the TS memory implementation (directory name is a misnomer; it's a term store):
    - **graph.ts** — `Graph`: load + label/stem/term indexes + `termMatch`, plus the mutable term-store
      API (`getOrCreate` / `addAlias` / `removeAlias` / `rename` / `merge` / `remove` / `setNoStem` /
      `serialize`) and `DescriptionTooLongError`. Aliases are a node field (spoken variants,
      abbreviations, persistent mistranscriptions), matched exactly; hyphenated aliases/labels also get
      a space variant.
    - **retrieve.ts** — `retrieveVacuum()` runs term-match + a term cap, returning the **vacuum** set;
      `retrieve()` wraps it with per-session ledger dedup and assembles the `<memory>` injection block.
    - **similarity.ts** — Jaro-Winkler string similarity + cosine over description embeddings;
      `findSimilarTerms` unions both candidate sets (backs the `similar_terms` dedup tool).
    - **embed.ts** — the embedding client: one call per term write to the proxy's `/v1/embed`,
      fail-soft (null → string-only dedup for that term).
    - **ingest.ts** — shared pipeline machinery: the OpenAI-compatible `makeCompletion` seam (summary
      agent's LLM leg), `stripInjectedContext`, the existing-memory dump `dumpExistingContext`, and the
      `hasContentWords` thin-turn guard. (No extraction parser — minting is a tooled agent loop now.)
    - **ledger.ts** — `InjectedLedger`: per-session dedup for the accumulating `<memory>` breadcrumb.
    - **stem.ts** — Porter stemmer (opt-in) + always-on `depluralize()`.
    - **config.ts** · **types.ts** · **stopwords.ts** — tunables, shapes, NLTK stopword list.
- **proxy/** — the metering backend (Bun, never bundled). `server.ts` (Hono app: `/anon-init`,
  `/v1/chat/completions`, `/v1/web-search`, `/v1/embed`, `/redeem`, `/balance`, `/health`, `/voice/*`,
  `/subscribe`), `db.ts` (`bun:sqlite`: principals / usage_log / family_codes / anon_ips / subscribers),
  `openrouter.ts` (forward +
  meter; mint sub-keys), `anon.ts` (the grant gates), `voice-broker.ts` (the voice-session broker),
  `config.ts`, `mint-code.ts`, `anon.test.ts` + `voice-broker.test.ts`. Real keys + caps live in
  `proxy/.env` (gitignored); `.env.example` documents the shape.
  - **voice-broker.ts** — load-balances browser voice sessions across the moshi instance(s) with
    overflow queuing. In-memory ephemeral leases; capacity per instance = the moshi TTS `batch_size`
    (STT is a shared Whisper endpoint, so the leased per-instance `sttUrl` is vestigial). Routes:
    `POST /voice/lease` (else `202 {queued}`), `/voice/heartbeat`, `/voice/release`. TTL sweeper
    reclaims dead leases. Gated on `VITE_VOICE_BROKER` (default off = single-instance demo).
- **scripts/** — dev-time tooling (TS, never shipped): **test-graph-mutation.ts** (term-store API) and
  **test-ingest.ts** (pipeline machinery + similarity + STT lexicon).
- **public/** — static assets: the audio-output worklet + the mic-capture worklet (ported from
  Unmute's frontend so the wire format matches). Neither audio leg uses Opus.
- **vite.config.ts** — Tailwind, a dev `/__log` middleware, and a **build-only** CSP injector
  (`connect-src` = self + OpenRouter + the proxy origin + the STT/TTS WS origins). `/v1/embed` and
  `/v1/web-search` ride the proxy origin, already covered.
- **.env.local** — dev frontend config (NO keys): `VITE_PROXY_BASE`, the optional voice WS overrides,
  and the optional `VITE_VOICE_BROKER` flag.
- **index.html** · **tsconfig.json** · **package.json** — SPA scaffold, TS config, pinned deps.

## How it works (the non-obvious parts)

- **One agent, one injection path.** Voice and typed chat both ride the *same* Pi agent, so both use
  the same injection: a wrapper around `agent.prompt()` runs retrieval *before* the run's context
  snapshot, updates the left gutter with the full **vacuum** set, and appends a hidden `memory-context`
  breadcrumb to `agent.state.messages`. The breadcrumb accumulates across turns, so a per-session
  **ledger** dedup is correct rather than lossy. The gutter deliberately shows the pre-dedup vacuum.
- **The pipeline tick.** On `agent_end` (consent-gated), `PipelineRuntime.onTurnEnd` fires one tick,
  fire-and-forget. A tick that's still running when the next turn ends coalesces into exactly one
  follow-up (reads the latest transcript when it runs). The pipeline agents' transcript KEEPS the
  `<memory>` breadcrumbs — retrieval visibility is the audit agent's subject matter. Per-agent token
  cost is folded into the visible session total via `addIngestionCostToSession`.
- **Action buffers come nearly free.** Each tool records its own one-line action; the runtime collects
  that stream as the agent's buffer entry (plus the agent's final self-summary line) and injects the
  rolling buffer into the next tick. No "report what you did" ceremony in the prompt.
- **The running-context band.** The summary agent's per-conversation entries are stored in the
  `pipeline` store; `runningContextBlock()` renders the *prior* conversations' entries and `createAgent`
  appends them to the main agent's system prompt — cross-conversation continuity. A fresh conversation
  gets a fresh `sessionKey`, so the summary agent rewrites the current entry without clobbering past ones.
- **History bounding (compaction).** The `agent.prompt` wrapper, before retrieval, estimates context
  tokens and — once over threshold — summarizes older messages into a single `compactionSummary`
  (recent turns kept, cut on a user boundary). `customConvertToLlm` MUST keep a `compactionSummary`
  case or history vanishes. At ~1M context this rarely fires.
- **The voice TTS tap.** A voice turn sets `voiceTurnSpeaking`, held for the whole turn and retired at
  `agent_end` (its value is read there first, to tell the pipeline whether STT functions apply). **One
  speaker per turn, not per message:** the listener opens a single TTS queue on the first `text_delta`
  of the turn and feeds every assistant message's text into it, pushing a newline at each `message_end`
  so the chunker flushes a mid-clause tail. A tool call mid-turn is just a pause in the text stream —
  the queue blocks, the current audio keeps draining via the synth's pace timer, and the post-tool
  answer resumes the SAME speaker. (A speaker *per message* would call `synth.speak()` again, and the
  synth's `run()` bumps its epoch + resets pacing on entry, cutting the still-playing pre-tool audio —
  that was the tool-call cut bug.) The queue closes at `agent_end`. Barge-in (`voiceTurnCut`) cuts the
  audio and blocks reopening for the rest of the turn; the LLM keeps generating.
- **Serving path + metering.** `resolveServingPath()` runs first in `createAgent`. Chat, the pipeline
  agents, web-search, and embed all ride the same path, so the proxy meters spend against one principal
  (web-search and embed are not metered — self-hosted). **Self-heal:** `ensureAnonGrant()` probes a
  stored token against `/balance`; a forgotten token is cleared and re-minted.
- **Opt-in memory.** Nothing is ingested until the visitor consents (pre-checked in the anon welcome
  modal; standalone for own-key/family). The pipeline never fires while consent is ungranted.
- **STT auto-replace.** The lexicon's auto-replace rules rewrite known mistranscriptions in the voice
  transcript before it reaches the display or the model — client-side, voice turns only. The audit
  agent adds those rules conservatively (a real dictionary word is never bare-word auto-replaced).

## pi-web-ui workarounds (why the frontend looks weird)

The vendored UI layer (`src/pi-web-ui/`) is broken as shipped; these patches live in `main.ts` and the
vendored components, and are load-bearing, not cruft:

- **Vanishing messages** — pi-agent-core mutates `state.messages` in place, so the committed
  `<message-list>` (identity-only reactivity) skips re-render. Fixed at the source: `AgentInterface`
  keeps its own `_stableMessages` clone and re-takes it on every lifecycle event but per-token
  `message_update` (message completion / turn boundaries), giving Lit a fresh identity to react to;
  the send button reverts via a deferred update after `agent_end` (finishRun flips `isStreaming`
  with no event). `main.ts` only pokes the view — `repaintChatAfterExternalEdit()` →
  `agentInterface.refreshMessages()` — for edits the agent emits no event for (voice placeholder
  bubbles, compaction rewrite). (The shipped example also listens for a phantom `state-update` event;
  we bind the raw lifecycle events instead.)
- **Mount-once ChatPanel** — mount it once outside the reactive render root and never re-render it.
- **Artifacts overwritten with real tools** — `ChatPanel` hardwires an `artifacts` tool regardless of
  `toolsFactory`. We reassign `agent.state.tools` after `setAgent` to our own set (`memory_search` +
  `memory_dump` + `web_search`), dropping artifacts. One reassignment covers newSession AND loadSession.
- **Listener async-safety** — core awaits each listener; a throw or heavy work stalls the run. The
  whole listener body is try/caught and only re-renders on meaningful events.
- **Link-href scrubbing** — mini-lit's `MarkdownBlock` renders assistant markdown via `unsafeHTML`
  with no href-scheme check, and it bundles its own `marked` instance we can't hook. Since it renders
  into light DOM, `sanitizeChatAnchors()` scrubs chat anchors after each commit (driven off terminal
  lifecycle events + `repaintChatAfterExternalEdit`), stripping the href from any link whose scheme
  isn't `http(s)`/`mailto` (the model is fed third-party web-search text, so a `javascript:` link is
  an XSS vector).

## Conventions & commands

- **Commands:** `npm run dev` (Vite + HMR), `npm run build` (prod build + strict CSP), `npm run check`
  (`tsc --noEmit`). Dev tests: `npx tsx scripts/test-graph-mutation.ts` and `npx tsx scripts/test-ingest.ts`
  after any `src/kg/` change. Proxy: `cd proxy && bun run server.ts` (serve) / `bun test` (its suite).
- **Endpoints are env-configured.** `VITE_PROXY_BASE` and `VITE_STT_BASE` / `VITE_TTS_BASE` default to
  local/dev targets and are overridden at build time for deploy. Optional voice overrides (for
  self-hosters pointing at their own moshi/Whisper): `VITE_TTS_VOICE` / `VITE_TTS_AUTH` /
  `VITE_TTS_CFG_ALPHA` / `VITE_STT_AUTH`, all with sane fallbacks. On the proxy, `SEARXNG_BASE` and
  `EMBED_BASE` point at the self-hosted backends. The own-key path always goes to OpenRouter direct.
- **Versions are pinned** — the runtime `@earendil-works/*` suite (pi-agent-core, pi-ai, pi-tui) is
  locked at 0.80.10 (an `overrides` block forces it), the release line with native Kimi K3 support
  (empty-signature thinking-block replay for multi-turn/tool loops, the `"max"` thinking level,
  correct output-limit/pricing metadata). The raw lifecycle event model (`message_*`, `agent_end`,
  `tool_execution_*`) and in-place `state.messages` mutation are unchanged from earlier lines, so the
  `main.ts` workarounds below still stand. The UI layer (`pi-web-ui`) is no longer an npm dep — its
  source is vendored in `src/pi-web-ui/`.
- **Single model, metered.** The model and reasoning level are hardcoded; the picker is hidden.
  Reasoning is always on (Kimi K3 has no off mode). The stats line shows real $ (the proxy meters true
  cost; pipeline cost is folded into the session total for the readout).
