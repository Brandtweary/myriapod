# myriapod-proxy

The metering inference proxy for myriapod. It holds the owner OpenRouter key
server-side (the browser never sees it), meters per-principal spend in SQLite, and
gates the free tier. Self-contained Bun service — deploy by copying this `proxy/`
directory and running it; it shares nothing with the frontend build.

## What it does

- **`POST /anon-init`** — establishes (or recovers) an anonymous free-tier principal
  and returns its `{ token }`. The browser calls it once, then uses the token as the
  proxy bearer. This is the only place a fresh `$FREE_GRANT_USD` is minted and the
  only place the grant gates run (a client BotD verdict + honeypot + time-trap, all
  client-reported and thus a casual-automation filter, not a hard wall). A fresh
  grant needs BOTH a never-seen token AND a never-granted IP: a known token on a new
  IP keeps its balance (VPN continuity), and a cleared browser on an already-granted
  IP adopts that IP's principal. New grants are also subject to `NEW_IP_PER_DAY`.
- **`POST /v1/chat/completions`** — OpenAI-compatible, **spend-only**. Resolves the
  principal by its bearer token, checks credit + caps, injects the right upstream
  key, forwards to OpenRouter, and debits the measured cost (from the streamed
  `usage` chunk). No bearer / unknown token → 401 (call `/anon-init` first).
  - **Anonymous:** the `/anon-init` token → owner key, bounded by `FREE_DAILY_CAP_USD`
    (global daily) and the token's `$FREE_GRANT_USD` lifetime balance.
  - **Family:** the `/redeem` token → a dedicated OpenRouter sub-key with a hard
    `$FAMILY_LIMIT` lifetime cap.
- **`POST /redeem`** `{ code }` → provisions a family sub-key and returns `{ token }`.
- **`GET /health`**, **`GET /balance`** (bearer → remaining credit).

The **own-key path never reaches this proxy**: when a visitor supplies their own
OpenRouter key, the browser calls OpenRouter directly.

## Run

```sh
cp .env.example .env     # then fill in the keys
bun install
bun start                # http://0.0.0.0:8790
```

`.env` is git-ignored. Bun auto-loads it.

## Mint a family code

```sh
bun run mint-code.ts AUNT-MAY     # → e.g. AUNT-MAY-7F3KQ9
```

A random entropy segment is always appended (the memorable prefix is optional), so
codes can't be enumerated. The script prints the full code — hand *that* out; the
recipient redeems it in the site's settings, which calls `/redeem` and stores the
returned token in their browser. `/redeem` is per-IP rate-limited with an escalating
backoff on failed attempts.

## OpenRouter dashboard (one-time, by hand)

1. **Owner key** → `OWNER_OPENROUTER_KEY`. Set a **daily-reset spend limit** on it
   (e.g. $50) — the hard backstop behind the proxy's own `$FREE_DAILY_CAP_USD`
   counter (OpenRouter has no account-wide daily ceiling, so it lives on the key).
2. **Provisioning key** (management-only) → `OPENROUTER_PROVISIONING_KEY`. Required
   for the family tier; `/redeem` returns 503 without it.

## Deploy (later)

Runs anywhere Bun runs. Today it lives on a single host / localhost; public exposure
(domain → VPS, TLS) is a later phase. To go public, set `ALLOWED_ORIGIN` to the
site origin. The free tier is gated by the invisible BotD / honeypot / time-trap
checks at `/anon-init` and bounded by the hard caps (owner-key daily limit +
per-family sub-key cap).
