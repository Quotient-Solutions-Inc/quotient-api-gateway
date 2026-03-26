// src/billing/config.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { loadBillingConfig } from "./config.js";

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

test("billing config exposes expected x402 defaults", () => {
  withTempEnv(
    {
      X402_ENABLED_NETWORKS: "eip155:8453",
      X402_PAY_TO_EIP155_8453: "0x2222222222222222222222222222222222222222"
    },
    () => {
      const config = loadBillingConfig();
      assert.equal(config.x402.paymentIdRequired, false);
      assert.equal(config.x402.idempotencyTtlSeconds, 3600);
      assert.equal(config.stripePackCacheTtlSeconds, 5);
    }
  );
});