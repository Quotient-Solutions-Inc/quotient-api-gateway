---
name: quotient-api-gateway
description: Accesses Quotient market intelligence through the API gateway with key-based auth, subscription credit metering, and x402 fallback behavior. Use when an agent needs current Quotient market endpoints, billing-aware request semantics, or public gateway integration instructions.
---

# Quotient API Gateway Skill

## Required Request Semantics

- Use `x-quotient-api-key: qt_...` when available.
- If API key is valid and subscription credits are available, request is served and credits are decremented by route cost.
- If API key is missing, gateway returns `402` challenge; retry can use `PAYMENT-SIGNATURE`.
- If API key is invalid, gateway returns `401` and does not fallback to `402`.

## Core Endpoints

- `GET /health`
- `GET /api/v1/markets`
- `GET /api/v1/markets/{slug}/intelligence`
- `GET /api/v1/markets/{slug}/signals`
- `POST /api/billing/stripe/webhook`
- `GET /public/skills/quotient-api-gateway/SKILL.md`

## Billing + Credits

- Subscription plan includes monthly credits.
- Credit cost is route-weighted:
  - `/api/v1/markets` -> low cost
  - `/intelligence` and `/signals` -> higher cost
- When credits are depleted, key-authenticated requests fall back to x402 challenge behavior.

## Minimal Usage Pattern

1. Send request with `x-quotient-api-key`.
2. If `200`, consume payload.
3. If `402`, pay and retry with `PAYMENT-SIGNATURE`.
4. If `401`, treat as key/auth issue and rotate/fix key.
