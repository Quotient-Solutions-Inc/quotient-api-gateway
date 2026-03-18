// src/billing/config.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { loadBillingConfig, resolveMonetizedRoutePolicy, MONETIZED_ROUTE_POLICIES } from "./config.js";

const ENV_KEYS = [
  "X402_ENABLED_NETWORKS",
  "X402_PAY_TO_EIP155_8453",
  "X402_PAY_TO_EIP155_84532",
  "X402_FACILITATOR_URL"
] as const;

function withTempEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => void): void {
  const previous: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }
  try {
    run();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

test("loadBillingConfig parses enabled x402 networks and payTo map", () => {
  withTempEnv(
    {
      X402_ENABLED_NETWORKS: "eip155:84532,eip155:8453",
      X402_PAY_TO_EIP155_84532: "0x1111111111111111111111111111111111111111",
      X402_PAY_TO_EIP155_8453: "0x2222222222222222222222222222222222222222",
      X402_FACILITATOR_URL: "https://x402.org/facilitator"
    },
    () => {
      const config = loadBillingConfig();
      assert.deepEqual(config.x402.enabledNetworks, ["eip155:84532", "eip155:8453"]);
      assert.equal(config.x402.payToByNetwork["eip155:84532"], "0x1111111111111111111111111111111111111111");
      assert.equal(config.x402.payToByNetwork["eip155:8453"], "0x2222222222222222222222222222222222222222");
      assert.equal(config.x402.paymentIdRequired, false);
      assert.equal(config.x402.idempotencyTtlSeconds, 3600);
      assert.equal(config.x402.facilitatorUrl, "https://x402.org/facilitator");
      assert.equal(config.stripePackProductMetadataKey, "catalog");
      assert.equal(config.stripePackProductMetadataValue, "quotient_api_credits");
      assert.equal(config.stripePackCreditsMetadataKey, "credits");
      assert.equal(config.stripePackCacheTtlSeconds, 5);
    }
  );
});

test("loadBillingConfig throws when enabled network has no payTo", () => {
  withTempEnv(
    {
      X402_ENABLED_NETWORKS: "eip155:84532",
      X402_PAY_TO_EIP155_84532: ""
    },
    () => {
      assert.throws(() => loadBillingConfig(), /Missing payTo wallet/);
    }
  );
});

test("monetized route policies are all resolvable", () => {
  assert.ok(MONETIZED_ROUTE_POLICIES.length > 0);
  for (const policy of MONETIZED_ROUTE_POLICIES) {
    assert.ok(policy.x402RoutePatterns.length > 0, `${policy.id} has no x402 route patterns`);
  }

  // Markets catalog
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/markets")?.id, "markets");
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/markets/lookup")?.id, "markets");

  // Mispriced — must resolve before the slug-based intelligence/signals patterns
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/markets/mispriced")?.id, "mispriced");

  // Intelligence and signals (slug-based)
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/markets/btc/intelligence")?.id, "intelligence");
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/markets/btc/signals")?.id, "signals");

  // Forecast (POST) — currently disabled, should not resolve
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/forecast", "POST"), null);

  // Unknown routes return null
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/equities"), null);
});

test("credit costs map to x402 pricing at 1 credit = $0.001", () => {
  for (const policy of MONETIZED_ROUTE_POLICIES) {
    const expectedCredits = Math.round(policy.x402Amount * 1000);
    assert.equal(
      policy.creditCost,
      expectedCredits,
      `${policy.id} creditCost (${policy.creditCost}) must equal x402Amount (${policy.x402Amount}) * 1000`
    );
  }
});