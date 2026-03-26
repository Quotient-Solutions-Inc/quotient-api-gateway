// src/billing/config.ts
export interface X402Config {
  facilitatorUrl: string;
  enabledNetworks: readonly string[];
  payToByNetwork: Readonly<Record<string, string>>;
  paymentIdRequired: boolean;
  idempotencyTtlSeconds: number;
}

export interface BillingConfig {
  stripeCheckoutSuccessUrl: string | undefined;
  stripeCheckoutCancelUrl: string | undefined;
  internalServiceToken: string | undefined;
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  stripePackProductMetadataKey: string;
  stripePackProductMetadataValue: string;
  stripePackCreditsMetadataKey: string;
  stripePackCacheTtlSeconds: number;
  x402: X402Config;
}

const STRIPE_PACK_PRODUCT_METADATA_KEY = "catalog";
const STRIPE_PACK_PRODUCT_METADATA_VALUE = "quotient_api_credits";
const STRIPE_PACK_CREDITS_METADATA_KEY = "credits";

function parseEnabledNetworks(input: string | undefined): string[] {
  const raw = (input || "eip155:84532").trim();
  const networks = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (networks.length === 0) {
    throw new Error("X402_ENABLED_NETWORKS must include at least one network.");
  }
  return Array.from(new Set(networks));
}

function resolvePayToByNetwork(enabledNetworks: readonly string[]): Record<string, string> {
  const configured: Record<string, string | undefined> = {
    "eip155:8453": process.env.X402_PAY_TO_EIP155_8453,
    "eip155:84532": process.env.X402_PAY_TO_EIP155_84532,
  };
  const result: Record<string, string> = {};
  for (const network of enabledNetworks) {
    const payTo = configured[network]?.trim();
    if (!payTo) {
      throw new Error(`Missing payTo wallet for enabled network '${network}'.`);
    }
    result[network] = payTo;
  }
  return result;
}

export function loadBillingConfig(): BillingConfig {
  const enabledNetworks = parseEnabledNetworks(process.env.X402_ENABLED_NETWORKS);
  const payToByNetwork = resolvePayToByNetwork(enabledNetworks);

  return {
    stripeCheckoutSuccessUrl: process.env.STRIPE_CHECKOUT_SUCCESS_URL,
    stripeCheckoutCancelUrl: process.env.STRIPE_CHECKOUT_CANCEL_URL,
    internalServiceToken: process.env.QUOTIENT_INTERNAL_SERVICE_TOKEN,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    stripePackProductMetadataKey: STRIPE_PACK_PRODUCT_METADATA_KEY,
    stripePackProductMetadataValue: STRIPE_PACK_PRODUCT_METADATA_VALUE,
    stripePackCreditsMetadataKey: STRIPE_PACK_CREDITS_METADATA_KEY,
    stripePackCacheTtlSeconds: 5,
    x402: {
      facilitatorUrl: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
      enabledNetworks,
      payToByNetwork,
      paymentIdRequired: false,
      idempotencyTtlSeconds: 3600,
    },
  };
}