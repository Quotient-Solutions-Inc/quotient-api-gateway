# Stripe Registration Runbook (Gateway)

This runbook covers Stripe setup for `quotient-api-gateway` billing enforcement, checkout orchestration, and paid-user API key provisioning.
When subscription credits are unavailable, gateway falls back to x402 v2 payment verification
(`PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`) for protected routes.

## Scope

- Stripe product/price registration
- Gateway environment configuration
- Webhook registration and verification
- Post-setup validation

## 1) Create Stripe Product + Price (Manual)

The gateway plan catalog is pulled directly from Stripe Prices + Products.
A plan is discoverable only when metadata matches the gateway filters.

Create a recurring monthly plan that maps to your gateway credit bundle
(example: `$20/month` with `1000` credits).

### Stripe Dashboard steps

1. Go to `Stripe Dashboard -> Product catalog -> Add product`.
2. Create a product (example name: `Starter 20`).
3. In the product metadata, add:
   - `catalog=quotient_api` (must match `STRIPE_PLAN_PRODUCT_METADATA_VALUE`)
   - optional but recommended: `plan_id=starter_20` (stable app-facing id)
4. Add a recurring monthly price for that product.
5. In price metadata, add:
   - `included_credits=1000` (must be a positive integer string)
   - optional override: `plan_id=starter_20` (takes precedence over product `plan_id`)
6. Save product and price.

### Metadata contract for plan discovery

The gateway currently uses:

- `STRIPE_PLAN_PRODUCT_METADATA_KEY=catalog`
- `STRIPE_PLAN_PRODUCT_METADATA_VALUE=quotient_api`
- `STRIPE_PLAN_CREDITS_METADATA_KEY=included_credits`

Required for a plan to appear in `GET /api/internal/billing/plans`:

- Product metadata contains `catalog=quotient_api`
- Price is `active`, `recurring`, and has a non-null amount
- `included_credits` exists on price metadata **or** product metadata and parses to `> 0`

Plan ID resolution order:

1. `price.metadata.plan_id`
2. `product.metadata.plan_id`
3. `price.lookup_key`
4. fallback `${product.id}:${price.id}`

Record after creation:

- product ID (`prod_...`)
- price ID (`price_...`)
- resolved plan ID (for checkout payload `planId`)

Billing plan metadata and route credit costs are code-defined in gateway billing config.

### Quick verification

After creating/updating products:

1. Restart gateway (or wait for `STRIPE_PLAN_CACHE_TTL_SECONDS`).
2. Call:
   - `GET /api/internal/billing/plans` with internal bearer token.
3. Confirm the new plan appears with expected:
   - `planId`
   - `amountUsd`
   - `interval`
   - `includedCredits`

## 2) Configure Gateway Environment

In `quotient-api-gateway/.env`:

```bash
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=replace_me
X402_FACILITATOR_URL=https://x402.org/facilitator
X402_ENABLED_NETWORKS=eip155:84532
X402_PAY_TO_EIP155_84532=0xYourSepoliaReceiveWallet
STRIPE_SECRET_KEY=sk_live_or_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_CHECKOUT_SUCCESS_URL=https://quotient-api.vercel.app/api-portal/dashboard
STRIPE_CHECKOUT_CANCEL_URL=https://quotient-api.vercel.app/api-portal/dashboard
STRIPE_PLAN_PRODUCT_METADATA_KEY=catalog
STRIPE_PLAN_PRODUCT_METADATA_VALUE=quotient_api
STRIPE_PLAN_CREDITS_METADATA_KEY=included_credits
QUOTIENT_INTERNAL_SERVICE_TOKEN=replace_me
```

Restart gateway after updates.

## 3) Register Webhook Endpoint

Gateway endpoint:

- `POST /api/billing/stripe/webhook`

Register URL in Stripe dashboard (or Stripe CLI tunnel) for your environment:

- local example: `http://localhost:8787/api/billing/stripe/webhook` (when tunneled)
- prod example: `https://<gateway-domain>/api/billing/stripe/webhook`

Subscribe to events:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

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
  "planId": "starter_20",
  "email": "optional@example.com"
}
```

## 5) Metadata Contract Requirement

For gateway account mapping, include canonical `user_id` in subscription metadata.

Expected metadata key:

- `user_id` = canonical Neo4j `User.id` value
- `api_key_hash` = optional legacy/debug field

Without `user_id`, subscription/account update events fail with `400 invalid_webhook`
because gateway cannot map the Stripe customer to a canonical Quotient user.

## 6) Validate Event Processing

### Stripe CLI example

```bash
stripe listen --forward-to localhost:8787/api/billing/stripe/webhook
stripe trigger customer.subscription.updated
stripe trigger invoice.paid
```

### Expected gateway behavior

- webhook returns `200` for accepted events
- `invoice.paid` triggers credit replenishment to the configured included credit amount
- for active paid events, gateway calls `quotient-api` internal provisioning endpoint to ensure API key issuance
- unsupported/unmapped events return `200` with `ignored: true`
- usage reconciliation data is emitted as structured logs (`type: billing_usage`)

## 7) Operational Checks

- Confirm signature verification failures return `400 invalid_webhook`.
- Confirm billing enforcement path:
  - valid key + credits -> `200`
  - valid key + no credits -> `402`
  - invalid key -> `401`
  - missing key -> `402`
- Monitor webhook error rate and retry backlog in Stripe dashboard.

## 8) Troubleshooting

- `stripe_not_configured`:
  - set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
- Events not updating credits:
  - verify `user_id` metadata present
  - verify webhook endpoint secret matches runtime secret
- Events update credits but key is missing:
  - verify `QUOTIENT_INTERNAL_SERVICE_TOKEN` matches between gateway and API
  - verify `quotient-api` has `/api/internal/provision/paid-user` reachable from gateway
- Signature failures:
  - ensure raw request body is used for signature verification (already implemented in gateway webhook handler)
