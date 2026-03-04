# Stripe Registration Runbook (Gateway)

This runbook covers Stripe setup for `quotient-api-gateway` billing enforcement and credit replenishment.

## Scope

- Stripe product/price registration
- Gateway environment configuration
- Webhook registration and verification
- Post-setup validation

## 1) Create Stripe Product + Price

Create a recurring monthly plan that maps to your gateway credit bundle (example: `$10/month` with `1000` credits).

Record:

- product ID
- price ID

Set matching gateway env values:

- `BILLING_PLAN_ID` (internal plan label)
- `BILLING_PLAN_PRICE_USD`
- `BILLING_INCLUDED_CREDITS`

## 2) Configure Gateway Environment

In `quotient-api-gateway/.env`:

```bash
BILLING_ENABLED=true
BILLING_PROVIDER_MODE=stripe
BILLING_STORE_BACKEND=neo4j
BILLING_PLAN_ID=starter_10
BILLING_PLAN_PRICE_USD=10
BILLING_INCLUDED_CREDITS=1000
BILLING_CREDIT_COST_MARKETS=1
BILLING_CREDIT_COST_INTELLIGENCE=2
BILLING_CREDIT_COST_SIGNALS=2
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=replace_me
STRIPE_SECRET_KEY=sk_live_or_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
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

## 4) Metadata Contract Requirement

For gateway account mapping, include canonical `user_id` in subscription metadata.

Expected metadata key:

- `user_id` = canonical Neo4j `User.id` value
- `api_key_hash` = optional legacy/debug field

Without `user_id`, subscription/account update events fail with `400 invalid_webhook`
because gateway cannot map the Stripe customer to a canonical Quotient user.

## 5) Validate Event Processing

### Stripe CLI example

```bash
stripe listen --forward-to localhost:8787/api/billing/stripe/webhook
stripe trigger customer.subscription.updated
stripe trigger invoice.paid
```

### Expected gateway behavior

- webhook returns `200` for accepted events
- `invoice.paid` triggers credit replenishment to `BILLING_INCLUDED_CREDITS`
- unsupported/unmapped events return `200` with `ignored: true`
- usage reconciliation data is emitted as structured logs (`type: billing_usage`)

## 6) Operational Checks

- Confirm signature verification failures return `400 invalid_webhook`.
- Confirm billing enforcement path:
  - valid key + credits -> `200`
  - valid key + no credits -> `402`
  - invalid key -> `401/403`
  - missing key -> `402`
- Monitor webhook error rate and retry backlog in Stripe dashboard.

## 7) Troubleshooting

- `stripe_not_configured`:
  - set `BILLING_PROVIDER_MODE=stripe`
  - set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
- Events not updating credits:
  - verify `user_id` metadata present
  - verify webhook endpoint secret matches runtime secret
- Signature failures:
  - ensure raw request body is used for signature verification (already implemented in gateway webhook handler)
