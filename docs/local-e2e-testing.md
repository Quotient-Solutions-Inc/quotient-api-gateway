# Local E2E Testing (Gateway)

This runbook validates gateway credits billing + fallback behavior:

1. API key with credits succeeds and decrements credits
2. API key with exhausted credits gets `403`
3. missing key gets `402`
4. invalid key returns upstream auth error
5. x402 paid retry succeeds
6. Stripe webhook can grant credits on purchase events

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

- `PORT` (default `3001`)
- `QUOTIENT_API_BASE_URL` (default `http://localhost:3000`)
- `QUOTIENT_GATEWAY_SHARED_SECRET` (required; must match quotient-api)
- `X402_FACILITATOR_URL` (default `https://x402.org/facilitator`)
- `X402_ENABLED_NETWORKS` (comma-separated CAIP-2 values)
- `X402_PAY_TO_EIP155_84532` and/or `X402_PAY_TO_EIP155_8453`
- `TEST_API_KEY` (for local API-key e2e script)
- `TEST_X402_PRIVATE_KEY` (for local buyer script)
- `TEST_X402_NETWORK` (CAIP-2 network for local buyer script, e.g. `eip155:84532`)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL`
- `QUOTIENT_INTERNAL_SERVICE_TOKEN` (required for internal checkout/provisioning calls)
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASS` (required)

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
quotient-api-gateway listening on http://localhost:3001
```

## E2E quick command

In a second terminal:

```bash
set -a
source .env
set +a
export TEST_GATEWAY_URL="http://localhost:${PORT:-3001}"
npm run e2e:test-api-key
```

## Manual E2E matrix

### 1) Valid key + available credits

```bash
curl -i \
  -H "x-quotient-api-key: qt_your_real_key" \
  "http://localhost:${PORT:-3001}/api/v1/markets?limit=1"
```

Expected:

- `HTTP/1.1 200`
- response headers include:
  - `x-billing-customer-id`
  - `x-billing-credits-remaining`

### 2) Valid key + exhausted credits

Run repeated calls with the same key until credits are exhausted.

Expected: eventually `HTTP/1.1 403` with `insufficient_credits` and `billing.required_credits` in body.

### 3) Missing key (x402 challenge)

```bash
curl -i \
  "http://localhost:${PORT:-3001}/api/v1/markets?limit=1"
```

Expected: `HTTP/1.1 402 Payment Required` and payment metadata.

### 4) Invalid key (auth error)

```bash
curl -i \
  -H "x-quotient-api-key: qt_invalid_key" \
  "http://localhost:${PORT:-3001}/api/v1/markets?limit=1"
```

Expected: `HTTP/1.1 401` from gateway key validation/billing identity resolution.

### 5) Paid retry succeeds

Create a valid x402 payment payload with an x402-compatible client/wallet, then retry with
the returned `PAYMENT-SIGNATURE` header:

```bash
curl -i \
  -H "PAYMENT-SIGNATURE: <base64_payment_payload>" \
  "http://localhost:${PORT:-3001}/api/v1/markets?limit=1"
```

Expected: `HTTP/1.1 200` with markets payload.

Automated local buyer flow:

```bash
set -a
source .env
set +a
export TEST_GATEWAY_URL="http://localhost:${PORT:-3001}"
npm run e2e:test-x402-payment
```

The script performs:

1. unauthenticated request and confirms `402` + `PAYMENT-REQUIRED`
2. paid retry using `TEST_X402_PRIVATE_KEY` and `TEST_X402_NETWORK`
3. validates success and prints `PAYMENT-RESPONSE` settlement data

Automated API-key flow:

```bash
set -a
source .env
set +a
export TEST_GATEWAY_URL="http://localhost:${PORT:-3001}"
export TEST_API_KEY=qt_your_real_key
npm run e2e:test-api-key
```

### 6) Webhook credit grant

When webhook is registered:

- send `checkout.session.completed` with metadata including canonical `user_id` and `credits`
- verify credits are added to balance and reflected in `x-billing-credits-remaining`

With Stripe CLI (example):

```bash
stripe trigger checkout.session.completed
```

### 7) Internal checkout session create (Stripe mode)

```bash
curl -i -X POST \
  -H "authorization: Bearer ${QUOTIENT_INTERNAL_SERVICE_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"userId":"user_test_123","privyId":"did:privy:test_user","packId":"starter_1000"}' \
  "http://localhost:${PORT:-3001}/api/internal/billing/checkout-session"
```

Expected: `HTTP/1.1 200` with `checkoutUrl` + `sessionId`.

## Manual negative tests

### 1) Missing payment proof

```bash
curl -i "http://localhost:${PORT:-3001}/api/v1/markets?limit=1"
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
curl -i -X POST "http://localhost:${PORT:-3001}/api/billing/stripe/webhook"
```

Expected when Stripe mode is not configured: `HTTP/1.1 503` with `stripe_not_configured`.

### 4) Unknown monetized route policy

```bash
curl -i "http://localhost:${PORT:-3001}/api/v1/unknown-route"
```

Expected: `HTTP/1.1 422` with `unpriced_route`.
