# Cymbiont Web

A chat-based web demo of [Cymbiont](https://github.com/Brandtweary/cymbiont) — the openable
resume artifact for a Linux-only harness no hiring manager will ever clone. Two faces, one app:
an **FAQ bot** answering questions about Cymbiont from a frozen "stock" knowledge graph, and a
**lightweight KG-memory assistant** whose personal graph grows as you talk. The whole point is to
make retrieval *visible* — every turn shows the matched nodes and triples in gutters beside the chat.

It is a *publishing* project, not a port: the harness already works, this re-renders a known-good
system for a reachable audience. Motto: **maximal reuse** — writing logic from scratch (outside the
new UI) is a red flag. The live plan, all design decisions, and phase status live in the gitignored
`feature_taskpad_cymbiont_web.md`.

**PUBLISHED REPO — treat every committed byte as public** (GitHub private, the live site public;
posture is public regardless). No live knowledge-graph node labels, no personal/workspace terms, no
real paths in docs/comments/prompts. Bias hard against examples; genericize any that are truly needed.
Canonical rule in Cymbiont's `CLAUDE.local.md` (this repo has the defensive `.gitignore` entry, no file).

## Architecture

Everything runs **browser-local** except a single backend. There is no Python at runtime and no
KG server — a visitor's browser can't reach localhost.

- **Frontend** — TypeScript fork of the `@earendil-works/pi-web-ui` example app (Lit 3 + mini-lit +
  Tailwind v4, Vite, static SPA). Retrieval, the personal graph, and ingestion all run in-page.
- **One backend** — the metering inference proxy in `proxy/` (Bun + Hono + `bun:sqlite`), with its
  own `package.json`, deployed standalone. Holds the owner OpenRouter key server-side and meters spend.
- **Three serving paths**, chosen per-session by `resolveServingPath()` in `main.ts`:
  - **own-key** → browser calls OpenRouter **directly**, proxy bypassed (the user's key, their money).
  - **anonymous** → proxy injects the owner key, meters a lifetime free balance keyed by IP.
  - **family** → a redeemed credit code maps to a provisioned OpenRouter sub-key, hard-capped upstream.
- **Two knowledge graphs**, retrieved together each turn against one shared dedup ledger:
  - **stock** — frozen asset (`public/stock-kg.json`), PPR + MMR over precomputed MiniLM embeddings.
  - **personal** — mutable, per-browser, persisted to IndexedDB, **PPR-only** (no embeddings/MMR).
- **The Python `cymbiont/kg/` package is REFERENCE-ONLY** — `src/kg/` is a faithful port of it,
  golden-tested against the original, but nothing calls Python at runtime.

## Repo Layout

- **src/** — the frontend.
  - **main.ts** — app entry + the heart. Serving-path resolver, agent construction, the retrieval
    injection wiring (Design 2, below), the lifecycle listener (persistence, repaint, ingestion
    trigger), gutter rendering, personal-graph load/save, session management.
  - **cymbiont-model.ts** — hardcoded chat-model literals (a cheap dev variant + a prod variant — swap
    the export; no picker UI), reasoning level pinned `high`, and `proxyChatModel()` which pins
    `compat.thinkingFormat:"openrouter"` so the proxied request body is byte-identical to the direct path.
  - **settings.ts** — `OpenRouterKeyTab` ("Access": own-key field + an unbranded credit-code redemption
    + hosted-balance readout) and `ExportTab` (personal-graph download/import — the real durability story).
  - **grant-modal.ts** — first-send welcome modal ("$10 free credits" + own-key alternative). The launch
    seam where the Cap bot-challenge widget mounts when enabled.
  - **custom-messages.ts** — custom message types + renderers + `customConvertToLlm` (maps the hidden
    `kg-context` breadcrumb to a user message for the model).
  - **debug.ts** — `[cymbiont]`-prefixed instrumentation + a wire-level SSE stream tap (dev-only).
  - **theme.css** / **app.css** — Golgari palette (black / white text / neon-green) over pi-web-ui's tokens.
  - **kg/** — the TS retrieval + ingestion port (each module headers its Python source):
    - **graph.ts** — `Graph`: load + label/stem/term indexes + `termMatch`, plus the mutable user-graph
      API (`getOrCreate` / `addLink` / `expireLink` / `serialize`).
    - **seeds.ts** · **ppr.ts** · **mmr.ts** — seed extraction, networkx-faithful PageRank, MMR diversity rerank.
    - **retrieve.ts** — orchestration: seeds → PPR overfetch → MMR → predicate-shadow dedup → per-head
      cap → term-match → doc cap → ledger dedup → `<kg-context>` assembly. Returns the vacuum set + injection block.
    - **ingest.ts** · **extraction-prompts.ts** — per-turn personal-graph ingestion (LLM extraction →
      tolerant parse → upsert-by-label + orphan-drop + clause merge + expirations).
    - **ledger.ts** — `InjectedLedger`: per-session dedup (the vacuum/injection split, below).
    - **stem.ts** — Porter stemmer (opt-in, effectively unused) + always-on `depluralize()`.
    - **config.ts** · **types.ts** · **stopwords.ts** — tunables, shapes, NLTK stopword list.
- **proxy/** — the metering backend. Self-contained; see **proxy/README.md** for run/deploy.
  - **server.ts** (Hono routes) · **db.ts** (SQLite: principals / usage_log / family_codes, derived
    caps) · **openrouter.ts** (forward + `tee()` usage capture + sub-key minting) · **challenge.ts**
    (Cap PoW, env-gated off) · **config.ts** (env surface) · **mint-code.ts** (`bun run mint-code.ts <CODE>`).
- **scripts/** — dev-time tooling (Python + TS, never shipped).
  - **build-stock-kg.py** — builds `public/stock-kg.json` from `stock-kg/kg/{store.json, *.npz}`.
  - **goldens/** — `gen_python_goldens.py` + `check.ts`: golden-tests the TS port against real Python output.
  - **test-graph-mutation.ts** · **test-ingest.ts** — unit tests for the graph API and ingestion.
- **stock-kg/kg/** — the frozen graph source (`store.json` + MiniLM `node_embeddings_minilm.npz`),
  built from Cymbiont's own docs; mirrors the harness's `DATA_ROOT/kg/` layout.
- **public/stock-kg.json** — the built browser asset (thoughts + label embeddings), fetched at boot.
- **vite.config.ts** — Tailwind, a dev `/__log` middleware (writes `debug.ts` output to a tmp log), and
  a **build-only** CSP injector (`script-src 'self'`; `connect-src` scoped to OpenRouter + the proxy).
- **index.html** · **tsconfig.json** · **package.json** — SPA scaffold, TS config, pinned deps.

## How it works (the non-obvious parts)

- **Design-2 retrieval injection.** Per turn, a wrapper around `agent.prompt()` runs retrieval over
  both graphs *before* the context snapshot, updates the gutters with the full **vacuum** set, and
  appends a hidden `kg-context` breadcrumb to `agent.state.messages` that accumulates across turns
  (like Claude Code's `additionalContext`). The ledger deduplicates injection; the gutters
  deliberately show the pre-dedup vacuum (the "small lie" — what *would* retrieve this turn).
- **Per-turn ingestion** fires fire-and-forget on `agent_end` into the personal graph, via a cheap
  fixed model on the active serving path, with a thin-turn guard (skips "ok"/"thanks"-class turns).
  Cost is folded into the latest assistant message's usage so the stats line totals chat + ingestion.
- **depluralization** is the one always-on normalization (strips spoken S-plurals so "knowledge
  graphs" hits the singular node) — added here and back-ported to the Python harness. Porter stemming
  is opt-in and used by ~zero live nodes.
- **Caps** (proxy-enforced unless noted): $10/IP lifetime free · 5 new-IP grants/day · $50/day global
  free ceiling · **$100 per family sub-key (OpenRouter-enforced)** · $200/mo family aggregate · $300/mo
  overall · 32k `max_tokens`/request. The hard money walls are the owner-key daily limit + the per-family
  sub-key cap, both OpenRouter-enforced; the rest is fairness/backstop. Full detail in `proxy/README.md`.

## pi-web-ui workarounds (why the frontend looks weird)

The bundled example app is broken in all published versions; these are load-bearing, not cruft:

- **Vanishing messages** — pi-agent-core mutates `state.messages` in place, so `<message-list>`
  (identity-only reactivity) never re-renders. `forceChatRepaint()` reassigns a fresh array on
  `message_end`/`agent_end`. (The example also listens for a phantom `state-update` event that never
  fires — we bind to the raw lifecycle events instead.)
- **Mount-once ChatPanel** — the panel is self-sufficient; mount it once outside the reactive render
  root and never re-render it (re-committing it mid-turn wiped the stream). Toggle visibility only.
- **Artifacts stripped** — `ChatPanel` hardwires an `artifacts` tool + side panel regardless of
  `toolsFactory`. We strip it from `agent.state.tools` after `setAgent` *and* override the REPL tool
  description so the model never offers it. (A demo's audience isn't doing HTML prototyping.)
- **Listener async-safety** — core awaits each listener; a throw or heavy work stalls the run and
  wipes the in-flight message. The whole listener body is try/caught and only re-renders on meaningful events.

## Conventions & commands

- **Frontend:** `npm run dev` (Vite + HMR), `npm run build` (prod + CSP), `npm run check` (`tsc --noEmit`).
- **Proxy:** `bun install && bun start` in `proxy/` (port 8790). `.env` is gitignored; Bun auto-loads it.
- **Golden tests:** `python3 scripts/goldens/gen_python_goldens.py` then `npx tsx scripts/goldens/check.ts`
  — hard-gates term-match + PPR fidelity against the Python harness. Run after any `src/kg/` change.
- **Versions are pinned** — the whole `@earendil-works/*` suite is locked at 0.75.3 (an `overrides`
  block forces it); upgrading emits the identical broken event set, so it fixes nothing. The chat model
  is hand-built because it's absent from that version's frozen registry.
- **Rebuilding the stock graph** is a Cymbiont-side operation (serial `workspace_ingest` over the
  package docs → `store.json` + npz → `build-stock-kg.py`), not a frontend concern.
