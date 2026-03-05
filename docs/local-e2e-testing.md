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
- `QUOTIENT_API_BASE_URL` (default `https://quotient-api.vercel.app`)
- `QUOTIENT_GATEWAY_SHARED_SECRET` (required; must match quotient-api)
- `X402_FACILITATOR_URL` (default `https://x402.org/facilitator`)
- `X402_ENABLED_NETWORKS` (comma-separated CAIP-2 values)
- `X402_PAY_TO_EIP155_84532` and/or `X402_PAY_TO_EIP155_8453`
- `X402_PAYMENT_ID_REQUIRED` (default `false`)
- `X402_IDEMPOTENCY_TTL_SECONDS` (default `3600`)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL`
- `STRIPE_PLAN_PRODUCT_METADATA_KEY`, `STRIPE_PLAN_PRODUCT_METADATA_VALUE`
- `STRIPE_PLAN_CREDITS_METADATA_KEY`, `STRIPE_PLAN_CACHE_TTL_SECONDS`
- `QUOTIENT_INTERNAL_SERVICE_TOKEN` (required for internal checkout/provisioning calls)
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` (required)

Pricing and metadata vars:

- x402 route pricing is code-defined in gateway billing policy config
- Monetized route policy is centralized in `src/billing/config.ts`
- Strict mode: unknown `/api/v1/*` routes return `422 unpriced_route`
- Header semantics follow x402 v2:
  - request proof: `PAYMENT-SIGNATURE`
  - payment challenge: `PAYMENT-REQUIRED`
  - settlement proof: `PAYMENT-RESPONSE`

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

Run repeated calls with the same subscribed key until credits are exhausted.

Expected: eventually `HTTP/1.1 402 Payment Required` with `billing.required_credits` in body.

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

Expected: `HTTP/1.1 401` from gateway key validation/billing identity resolution.

### 5) Paid retry succeeds

Create a valid x402 payment payload with an x402-compatible client/wallet, then retry with
the returned `PAYMENT-SIGNATURE` header:

```bash
curl -i \
  -H "PAYMENT-SIGNATURE: <base64_payment_payload>" \
  "http://localhost:${PORT:-8787}/api/v1/markets?limit=1"
```

Expected: `HTTP/1.1 200` with markets payload.

### 6) Webhook cycle renew

When webhook is registered:

- send `invoice.paid` event with subscription metadata including canonical `user_id`
- `api_key_hash` is optional and used only for debugging/legacy visibility
- verify credits are replenished to the plan's included credit amount (defined in gateway billing config)

With Stripe CLI (example):

```bash
stripe trigger invoice.paid
```

### 7) Internal checkout session create (Stripe mode)

```bash
curl -i -X POST \
  -H "authorization: Bearer ${QUOTIENT_INTERNAL_SERVICE_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"userId":"user_test_123","privyId":"did:privy:test_user","planId":"starter_20"}' \
  "http://localhost:${PORT:-8787}/api/internal/billing/checkout-session"
```

Expected: `HTTP/1.1 200` with `checkoutUrl` + `sessionId`.

## Manual negative tests

### 1) Missing payment proof

```bash
curl -i "http://localhost:${PORT:-8787}/api/v1/markets?limit=1"
```

Expected: `HTTP/1.1 402 Payment Required`.

### 2) Missing upstream gateway shared secret

Unset `QUOTIENT_GATEWAY_SHARED_SECRET` and restart.

Expected startup failure:

```text
Missing QUOTIENT_GATEWAY_SHARED_SECRET
```

### 3) Stripe webhook endpoint not configured

```bash
curl -i -X POST "http://localhost:${PORT:-8787}/api/billing/stripe/webhook"
```

Expected when Stripe mode is not configured: `HTTP/1.1 503` with `stripe_not_configured`.

### 4) Unknown monetized route policy

```bash
curl -i "http://localhost:${PORT:-8787}/api/v1/equities?limit=1"
```

Expected: `HTTP/1.1 422` with `unpriced_route`.
