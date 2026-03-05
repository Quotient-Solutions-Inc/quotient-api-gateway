# Stripe Registration Runbook (Gateway)

This runbook covers Stripe setup for `quotient-api-gateway` credit purchases, checkout orchestration, and paid-user API key provisioning.
When API credits are unavailable, gateway falls back to x402 v2 payment verification
(`PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`) for protected routes.

## Scope

- Stripe credit pack product/price registration
- Gateway environment configuration
- Webhook registration and verification
- Post-setup validation

## 1) Create Stripe Credit Pack (Manual)

The gateway credit-pack catalog is pulled directly from Stripe Prices + Products.
A pack is discoverable only when metadata matches the gateway filters.

Create one-time packs that map to your gateway credit bundles
(example: `$20` for `1000` credits).

### Stripe Dashboard steps

1. Go to `Stripe Dashboard -> Product catalog -> Add product`.
2. Create a product (example name: `Starter 20`).
3. In the product metadata, add:
   - `catalog=quotient_api_credits` (hardcoded gateway catalog filter)
   - `credits=1000` (must be a positive integer string)
   - optional but recommended: `pack_id=starter_1000` (stable app-facing id)
4. Add a one-time price for that product.
5. Save product and price.

### Metadata contract for pack discovery

The gateway currently uses:

- product metadata `catalog=quotient_api_credits`
- credits metadata key `credits`

Required for a pack to appear in `GET /api/internal/billing/plans`:

- Product metadata contains `catalog=quotient_api_credits`
- Price is `active`, `one_time`, and has a non-null amount
- `credits` exists on product metadata and parses to `> 0`

Pack ID resolution order:

1. `product.metadata.pack_id`
2. `price.lookup_key`
3. fallback `${product.id}:${price.id}`

Record after creation:

- product ID (`prod_...`)
- price ID (`price_...`)
- resolved pack ID (for checkout payload `packId`)

Billing plan metadata and route credit costs are code-defined in gateway billing config.

### Quick verification

After creating/updating products:

1. Restart gateway (or wait for the 300-second plan cache TTL).
2. Call:
   - `GET /api/internal/billing/plans` with internal bearer token.
3. Confirm the new pack appears with expected:
   - `packId`
   - `amountUsd`
   - `credits`

## 2) Configure Gateway Environment

In `quotient-api-gateway/.env`:

```bash
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASS=replace_me
X402_FACILITATOR_URL=https://x402.org/facilitator
X402_ENABLED_NETWORKS=eip155:84532
X402_PAY_TO_EIP155_84532=0xYourSepoliaReceiveWallet
STRIPE_SECRET_KEY=sk_live_or_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_CHECKOUT_SUCCESS_URL=https://quotient-api.vercel.app/api-portal/dashboard
STRIPE_CHECKOUT_CANCEL_URL=https://quotient-api.vercel.app/api-portal/dashboard
QUOTIENT_INTERNAL_SERVICE_TOKEN=replace_me
```

Restart gateway after updates.

## 3) Register Webhook Endpoint

Gateway endpoint:

- `POST /api/billing/stripe/webhook`

Register URL in Stripe dashboard (or Stripe CLI tunnel) for your environment:

- local example: `http://localhost:3001/api/billing/stripe/webhook` (when tunneled)
- prod example: `https://<gateway-domain>/api/billing/stripe/webhook`

Subscribe to events:

- `checkout.session.completed`
- `payment_intent.succeeded`

Recommended: subscribe only to the events above.

## 4) Internal Checkout Endpoints

Gateway internal endpoints (service-token protected):

- `GET /api/internal/billing/plans`
- `POST /api/internal/billing/checkout-session`
- `GET /api/internal/billing/checkout-session/status?sessionId=...`

Required auth header:

- `Authorization: Bearer <QUOTIENT_INTERNAL_SERVICE_TOKEN>`

Expected checkout payload:

```json
{
  "userId": "canonical_user_id",
  "privyId": "did:privy:...",
  "packId": "starter_1000",
  "email": "optional@example.com"
}
```

## 5) Metadata Contract Requirement

For gateway account mapping, include canonical `user_id` in checkout/payment metadata.

Expected metadata key:

- `user_id` = canonical Neo4j `User.id` value
- `credits` = positive integer to grant
- `purchase_type` = `manual_purchase` or `auto_recharge`

## 6) Validate Event Processing

### Stripe CLI example

```bash
stripe listen --forward-to localhost:3001/api/billing/stripe/webhook
stripe trigger checkout.session.completed
```

### Expected gateway behavior

- webhook returns `200` for accepted events
- `checkout.session.completed` grants the configured credits
- duplicate events are ignored via processed event idempotency
- for active paid events, gateway calls `quotient-api` internal provisioning endpoint to ensure API key issuance
- unsupported/unmapped events return `200` with `ignored: true`
- usage reconciliation data is emitted as structured logs (`type: billing_usage`)

## 7) Operational Checks

- Confirm signature verification failures return `400 invalid_webhook`.
- Confirm billing enforcement path:
  - valid key + credits -> `200`
  - valid key + no credits -> `403` (`insufficient_credits`)
  - invalid key -> `401`
  - missing key -> `402`
- Monitor webhook error rate and retry backlog in Stripe dashboard.

## 8) Troubleshooting

- `stripe_not_configured`:
  - set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
- Events not updating credits:
  - verify `user_id` + `credits` metadata present
  - verify webhook endpoint secret matches runtime secret
- Events update credits but key is missing:
  - verify `QUOTIENT_INTERNAL_SERVICE_TOKEN` matches between gateway and API
  - verify `quotient-api` has `/api/internal/provision/paid-user` reachable from gateway
- Signature failures:
  - ensure raw request body is used for signature verification (already implemented in gateway webhook handler)
