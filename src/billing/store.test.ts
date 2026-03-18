import test from "node:test";
import assert from "node:assert/strict";
import { Neo4jBillingStore } from "./store.js";
import type { BillingConfig } from "./config.js";

function mockConfig(): BillingConfig {
  return {
    stripeCheckoutSuccessUrl: undefined,
    stripeCheckoutCancelUrl: undefined,
    internalServiceToken: undefined,
    stripeSecretKey: undefined,
    stripeWebhookSecret: undefined,
    stripePackProductMetadataKey: "catalog",
    stripePackProductMetadataValue: "quotient_api_credits",
    stripePackCreditsMetadataKey: "credits",
    stripePackCacheTtlSeconds: 5,
    x402: {
      facilitatorUrl: "https://x402.org/facilitator",
      enabledNetworks: ["eip155:84532"],
      payToByNetwork: { "eip155:84532": "0x1111111111111111111111111111111111111111" },
      paymentIdRequired: false,
      idempotencyTtlSeconds: 3600
    }
  };
}

test("grantSignupCreditsOnce uses one-time marker query and maps granted result", async () => {
  let capturedQuery = "";
  let capturedParams: Record<string, unknown> = {};
  const store = new Neo4jBillingStore(mockConfig(), async <T>(
    query: string,
    params: Record<string, unknown> = {}
  ) => {
    capturedQuery = query;
    capturedParams = params;
    return [
      {
        customerId: "user-1",
        apiKeyHash: "hash-1",
        stripeCustomerId: null,
        stripeDefaultPaymentMethodId: null,
        autoRechargeEnabled: false,
        autoRechargeThreshold: 0,
        autoRechargeUnits: null,
        creditsRemaining: 50000,
        updatedAt: "2026-03-17T00:00:00.000Z",
        granted: true
      } as unknown as T
    ];
  });

  const result = await store.grantSignupCreditsOnce({
    customerId: "user-1",
    apiKeyHash: "hash-1",
    amount: 50000,
    requestId: "req-1"
  });

  assert.equal(result.granted, true);
  assert.equal(result.account.creditsRemaining, 50000);
  assert.equal(capturedParams.customerId, "user-1");
  assert.equal(capturedParams.apiKeyHash, "hash-1");
  assert.equal(capturedParams.amount, 50000);
  assert.match(capturedQuery, /signupBonusGranted/);
  assert.match(capturedQuery, /source: 'signup_bonus'/);
});

test("grantSignupCreditsOnce throws when query returns no rows", async () => {
  const store = new Neo4jBillingStore(mockConfig(), async () => []);

  await assert.rejects(
    () =>
      store.grantSignupCreditsOnce({
        customerId: "user-1",
        apiKeyHash: "hash-1",
        amount: 50000,
        requestId: "req-1"
      }),
    /Failed to grant signup credits/
  );
});
