#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${GATEWAY_URL:-}" ]]; then
  GATEWAY_URL="http://localhost:8787"
fi

if [[ -z "${X402_TEST_TOKEN:-}" ]]; then
  echo "X402_TEST_TOKEN is required."
  exit 1
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
echo "4) Invalid key auth error (expected HTTP 401/403)"
BAD_HTTP=$(curl -sS -o /tmp/quotient_invalid_key.json -w "%{http_code}" \
  -H "x-quotient-api-key: qt_invalid_key" \
  "${GATEWAY_URL}/api/v1/markets?limit=1")
echo "HTTP ${BAD_HTTP}"
cat /tmp/quotient_invalid_key.json | jq .

echo ""
echo "5) Paid fallback request (expected HTTP 200)"
curl -sS \
  -H "x-payment: ${X402_TEST_TOKEN}" \
  "${GATEWAY_URL}/api/v1/markets?limit=1" | jq .

echo ""
echo "6) Stripe webhook health check (expected 503 unless stripe mode configured)"
WEBHOOK_HTTP=$(curl -sS -o /tmp/quotient_webhook.json -w "%{http_code}" \
  -X POST \
  "${GATEWAY_URL}/api/billing/stripe/webhook")
echo "HTTP ${WEBHOOK_HTTP}"
cat /tmp/quotient_webhook.json | jq .

echo ""
echo "E2E local flow completed."
