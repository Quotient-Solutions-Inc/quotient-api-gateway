import test from "node:test";
import assert from "node:assert/strict";
import { loadBillingConfig, resolveMonetizedRoutePolicy, MONETIZED_ROUTE_POLICIES } from "./config.js";

const ENV_KEYS = [
  "X402_ENABLED_NETWORKS",
  "X402_PAY_TO_EIP155_8453",
  "X402_PAY_TO_EIP155_84532",
  "X402_PAYMENT_ID_REQUIRED",
  "X402_IDEMPOTENCY_TTL_SECONDS",
  "X402_FACILITATOR_URL",
  "STRIPE_PLAN_PRODUCT_METADATA_KEY",
  "STRIPE_PLAN_PRODUCT_METADATA_VALUE",
  "STRIPE_PLAN_CREDITS_METADATA_KEY",
  "STRIPE_PLAN_CACHE_TTL_SECONDS"
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
      X402_PAYMENT_ID_REQUIRED: "true",
      X402_IDEMPOTENCY_TTL_SECONDS: "1800",
      X402_FACILITATOR_URL: "https://x402.org/facilitator",
      STRIPE_PLAN_PRODUCT_METADATA_KEY: "catalog",
      STRIPE_PLAN_PRODUCT_METADATA_VALUE: "quotient_api",
      STRIPE_PLAN_CREDITS_METADATA_KEY: "included_credits",
      STRIPE_PLAN_CACHE_TTL_SECONDS: "120"
    },
    () => {
      const config = loadBillingConfig();
      assert.deepEqual(config.x402.enabledNetworks, ["eip155:84532", "eip155:8453"]);
      assert.equal(config.x402.payToByNetwork["eip155:84532"], "0x1111111111111111111111111111111111111111");
      assert.equal(config.x402.payToByNetwork["eip155:8453"], "0x2222222222222222222222222222222222222222");
      assert.equal(config.x402.paymentIdRequired, true);
      assert.equal(config.x402.idempotencyTtlSeconds, 1800);
      assert.equal(config.x402.facilitatorUrl, "https://x402.org/facilitator");
      assert.equal(config.stripePlanProductMetadataKey, "catalog");
      assert.equal(config.stripePlanProductMetadataValue, "quotient_api");
      assert.equal(config.stripePlanCreditsMetadataKey, "included_credits");
      assert.equal(config.stripePlanCacheTtlSeconds, 120);
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

  assert.equal(resolveMonetizedRoutePolicy("/api/v1/markets")?.id, "markets");
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/markets/lookup")?.id, "markets");
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/markets/btc/intelligence")?.id, "intelligence");
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/markets/btc/signals")?.id, "signals");
  assert.equal(resolveMonetizedRoutePolicy("/api/v1/equities"), null);
});
