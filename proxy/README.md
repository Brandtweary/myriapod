# cymbiont-proxy

The metering inference proxy for cymbiont-web. It holds the owner OpenRouter key
server-side (the browser never sees it), meters per-principal spend in SQLite, and
gates the free tier. Self-contained Bun service — deploy by copying this `proxy/`
directory and running it; it shares nothing with the frontend build.

## What it does

- **`POST /v1/chat/completions`** — OpenAI-compatible. Resolves a principal, checks
  credit + caps, injects the right upstream key, forwards to OpenRouter, and debits
  the measured cost (captured from the streamed `usage` chunk).
  - **Anonymous (free tier):** no `Authorization` → keyed by client IP. First touch
    grants `$FREE_GRANT_USD` (lifetime), subject to `NEW_IP_PER_DAY` new-grant and
    `FREE_DAILY_CAP_USD` global-daily caps. Spends the owner key.
  - **Family:** `Authorization: Bearer <token>` (from `/redeem`). Spends a dedicated
    OpenRouter sub-key with a hard `$FAMILY_LIMIT` lifetime cap.
- **`POST /redeem`** `{ code }` → provisions a family sub-key and returns `{ token }`.
- **`GET /health`**.
- **`/challenge`, `/redeem-challenge`** — only when the Cap bot-challenge is enabled.

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
bun run mint-code.ts AUNT-MAY-2026
```

Hand the code out; the recipient redeems it in the site's settings, which calls
`/redeem` and stores the returned token in their browser.

## OpenRouter dashboard (one-time, by hand)

1. **Owner key** → `OWNER_OPENROUTER_KEY`. Set a **daily-reset spend limit** on it
   (e.g. $50) — the hard backstop behind the proxy's own `$FREE_DAILY_CAP_USD`
   counter (OpenRouter has no account-wide daily ceiling, so it lives on the key).
2. **Provisioning key** (management-only) → `OPENROUTER_PROVISIONING_KEY`. Required
   for the family tier; `/redeem` returns 503 without it.

## Deploy (later)

Runs anywhere Bun runs. Today it lives on Adishesha / localhost; public exposure
(domain → tunnel, Cloudflare, Cap challenge on) is a later phase. To go public:
set `ALLOWED_ORIGIN` to the site origin and `CHALLENGE_SECRET` to enable Cap.
