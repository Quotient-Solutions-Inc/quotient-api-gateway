# Local E2E Testing (Gateway)

This runbook validates gateway billing + fallback behavior:

1. active subscriber with credits succeeds and decrements credits
2. active subscriber with exhausted credits gets `402`
3. missing key gets `402`
4. invalid key returns upstream auth error
5. x402 paid retry succeeds
6. Stripe webhook can replenish credits on billing-cycle events

## Prerequisites

- Node.js 20+
- `curl`
- `jq`
- A valid Quotient API key (`qt_...`)

## Required environment variables

Copy and edit:

```bash
cp .env.example .env
```

Required values:

- `PORT` (default `8787`)
- `QUOTIENT_API_BASE_URL` (default `https://quotient-markets-api.onrender.com`)
- `QUOTIENT_API_KEY` (required, from Quotient API portal)
- `X402_TEST_TOKEN` (required for local payment simulation)
- `BILLING_ENABLED` (default `true`)
- `BILLING_PROVIDER_MODE` (`mock` or `stripe`)
- `BILLING_STORE_BACKEND` (`memory` or `neo4j`)
- `BILLING_INCLUDED_CREDITS` (monthly included credits)
- `BILLING_CREDIT_COST_MARKETS`, `BILLING_CREDIT_COST_INTELLIGENCE`, `BILLING_CREDIT_COST_SIGNALS`
- `BILLING_MOCK_ACTIVE_API_KEY_HASHES` (comma-separated SHA256 hashes in mock mode)
- `BILLING_MOCK_ACTIVE_USER_IDS` (comma-separated canonical `User.id` values in mock mode)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (stripe mode only)
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` (required when `BILLING_STORE_BACKEND=neo4j`)

Pricing and metadata vars:

- `X402_ACCEPTED_CHAIN` (default `base`)
- `X402_ACCEPTED_ASSET` (default `USDC`)
- `X402_PRICE_MARKETS` (default `0.01`)
- `X402_PRICE_INTELLIGENCE` (default `0.02`)
- `X402_PRICE_SIGNALS` (default `0.015`)

## Start the gateway

```bash
set -a
source .env
set +a
npm install
npm run build
node dist/server.js
```

Expected log:

```text
quotient-api-gateway listening on http://localhost:8787
```

## E2E quick command

In a second terminal:

```bash
set -a
source .env
set +a
export GATEWAY_URL="http://localhost:${PORT:-8787}"
bash scripts/e2e-local.sh
```

## Manual E2E matrix

### 0) Optional: generate mock subscriber hash

To mark a real `qt_` key as subscribed in mock mode:

```bash
python3 - <<'PY'
import hashlib, os
key = os.environ.get("QUOTIENT_USER_API_KEY", "")
print(hashlib.sha256(key.encode()).hexdigest() if key else "Set QUOTIENT_USER_API_KEY first")
PY
```

Add the hash to `BILLING_MOCK_ACTIVE_API_KEY_HASHES` in `.env`, restart gateway.

### 1) Valid key + active credits

```bash
curl -i \
  -H "x-quotient-api-key: qt_your_real_key" \
  "http://localhost:${PORT:-8787}/api/v1/markets?limit=1"
```

Expected:

- `HTTP/1.1 200`
- response headers include:
  - `x-billing-customer-id`
  - `x-billing-credits-remaining`

### 2) Valid key + exhausted credits

Set low included credits in `.env` for easy testing:

```bash
BILLING_INCLUDED_CREDITS=1
BILLING_CREDIT_COST_MARKETS=2
```

Restart gateway, then retry request with same valid key.

Expected: `HTTP/1.1 402 Payment Required` with `billing.required_credits` in body.

### 3) Missing key (x402 challenge)

```bash
curl -i \
  "http://localhost:${PORT:-8787}/api/v1/markets?limit=1"
```

Expected: `HTTP/1.1 402 Payment Required` and payment metadata.

### 4) Invalid key (auth error)

```bash
curl -i \
  -H "x-quotient-api-key: qt_invalid_key" \
  "http://localhost:${PORT:-8787}/api/v1/markets?limit=1"
```

Expected: `HTTP/1.1 401` or `403` from upstream key validation.

### 5) Paid retry succeeds

```bash
curl -i \
  -H "x-payment: ${X402_TEST_TOKEN}" \
  "http://localhost:${PORT:-8787}/api/v1/markets?limit=1"
```

Expected: `HTTP/1.1 200` with markets payload.

### 6) Webhook cycle renew (Stripe mode)

When `BILLING_PROVIDER_MODE=stripe` and webhook is registered:

- send `invoice.paid` event with subscription metadata including canonical `user_id`
- `api_key_hash` is optional and used only for debugging/legacy visibility
- verify credits are replenished to `BILLING_INCLUDED_CREDITS`

With Stripe CLI (example):

```bash
stripe trigger invoice.paid
```

## Manual negative tests

### 1) Missing payment proof

```bash
curl -i "http://localhost:${PORT:-8787}/api/v1/markets?limit=1"
```

Expected: `HTTP/1.1 402 Payment Required`.

### 2) Missing upstream fallback API key

Unset `QUOTIENT_API_KEY` and restart.

Expected startup failure:

```text
Missing QUOTIENT_API_KEY
```

### 3) Stripe webhook endpoint not configured

```bash
curl -i -X POST "http://localhost:${PORT:-8787}/api/billing/stripe/webhook"
```

Expected in mock mode: `HTTP/1.1 503` with `stripe_not_configured`.
