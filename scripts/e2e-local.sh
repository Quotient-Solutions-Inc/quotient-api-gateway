#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${GATEWAY_URL:-}" ]]; then
  GATEWAY_URL="http://localhost:8787"
fi

echo "1) Health check"
curl -sS "${GATEWAY_URL}/health" | jq .

echo ""
echo "1b) Public SKILL.md artifact"
curl -sS "${GATEWAY_URL}/public/skills/quotient-api-gateway/SKILL.md" | sed -n '1,12p'

echo ""
if [[ -n "${QUOTIENT_USER_API_KEY:-}" ]]; then
  echo "2) Valid user key request (expected HTTP 200 with active credits, otherwise HTTP 402)"
  VALID_HTTP=$(curl -sS -o /tmp/quotient_valid.json -w "%{http_code}" \
    -H "x-quotient-api-key: ${QUOTIENT_USER_API_KEY}" \
    "${GATEWAY_URL}/api/v1/markets?limit=1")
  echo "HTTP ${VALID_HTTP}"
  cat /tmp/quotient_valid.json | jq .
else
  echo "2) Skipping valid-key test (set QUOTIENT_USER_API_KEY to enable)"
fi

echo ""
echo "3) Missing key challenge (expected HTTP 402)"
HTTP_CODE=$(curl -sS -o /tmp/quotient_402.json -w "%{http_code}" "${GATEWAY_URL}/api/v1/markets?limit=1")
echo "HTTP ${HTTP_CODE}"
cat /tmp/quotient_402.json | jq .

echo ""
echo "4) Invalid key auth error (expected HTTP 401)"
BAD_HTTP=$(curl -sS -o /tmp/quotient_invalid_key.json -w "%{http_code}" \
  -H "x-quotient-api-key: qt_invalid_key" \
  "${GATEWAY_URL}/api/v1/markets?limit=1")
echo "HTTP ${BAD_HTTP}"
cat /tmp/quotient_invalid_key.json | jq .

echo ""
echo "5) Paid fallback replay hint"
echo "Use an x402-compatible client to generate PAYMENT-SIGNATURE, then retry:"
echo "curl -i -H \"PAYMENT-SIGNATURE: <base64_payment_payload>\" \"${GATEWAY_URL}/api/v1/markets?limit=1\""

echo ""
echo "6) Stripe webhook health check (expected 503 unless stripe mode configured)"
WEBHOOK_HTTP=$(curl -sS -o /tmp/quotient_webhook.json -w "%{http_code}" \
  -X POST \
  "${GATEWAY_URL}/api/billing/stripe/webhook")
echo "HTTP ${WEBHOOK_HTTP}"
cat /tmp/quotient_webhook.json | jq .

echo ""
echo "7) Internal checkout endpoint smoke test (requires QUOTIENT_INTERNAL_SERVICE_TOKEN)"
if [[ -n "${QUOTIENT_INTERNAL_SERVICE_TOKEN:-}" && -n "${QUOTIENT_USER_ID_FOR_CHECKOUT:-}" && -n "${QUOTIENT_PRIVY_ID_FOR_CHECKOUT:-}" ]]; then
  PLAN_ID="${QUOTIENT_PLAN_ID_FOR_CHECKOUT:-starter_20}"
  CHECKOUT_HTTP=$(curl -sS -o /tmp/quotient_checkout.json -w "%{http_code}" \
    -X POST \
    -H "authorization: Bearer ${QUOTIENT_INTERNAL_SERVICE_TOKEN}" \
    -H "content-type: application/json" \
    -d "{\"userId\":\"${QUOTIENT_USER_ID_FOR_CHECKOUT}\",\"privyId\":\"${QUOTIENT_PRIVY_ID_FOR_CHECKOUT}\",\"planId\":\"${PLAN_ID}\"}" \
    "${GATEWAY_URL}/api/internal/billing/checkout-session")
  echo "HTTP ${CHECKOUT_HTTP}"
  cat /tmp/quotient_checkout.json | jq .
else
  echo "Skipping internal checkout smoke test (set QUOTIENT_INTERNAL_SERVICE_TOKEN, QUOTIENT_USER_ID_FOR_CHECKOUT, QUOTIENT_PRIVY_ID_FOR_CHECKOUT)"
fi

echo ""
echo "E2E local flow completed."
