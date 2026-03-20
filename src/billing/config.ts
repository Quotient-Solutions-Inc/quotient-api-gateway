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

export interface MonetizedRoutePolicy {
  id: "markets" | "mispriced" | "intelligence" | "signals" | "forecast";
  match: (pathname: string, method?: string) => boolean;
  x402RoutePatterns: readonly string[];
  creditCost: number;
  x402Amount: number;
}

const CREDITS_PER_USD = 1000;

function creditsFromX402Amount(x402AmountUsd: number): number {
  return Math.round(x402AmountUsd * CREDITS_PER_USD);
}

export const MONETIZED_ROUTE_POLICIES: readonly MonetizedRoutePolicy[] = [
  // Sync contract: when adding/changing/removing a monetized route here, update all of:
  // 1) gateway Bazaar metadata in src/billing/x402.ts (buildRoutes/toBazaar* helpers),
  // 2) gateway pricing output in src/server.ts (handlePublicPricing),
  // 3) API discovery/docs in quotient-api:
  //    - src/app/api/v1/openapi.json/route.ts
  //    - src/app/llms.txt/route.ts
  //    - public/skill/skill.md
  //    - src/app/api/public/pricing/route.ts (gateway mirror behavior/copy)
  // Order matters: more specific patterns first

  // ── forecast: disabled until Anthropic credit budget is secured ──
  // {
  //   id: "forecast",
  //   match: (pathname, method) =>
  //     pathname === "/api/v1/forecast" && (method === "POST" || method === undefined),
  //   x402RoutePatterns: ["POST /api/v1/forecast"],
  //   creditCost: creditsFromX402Amount(1.0),
  //   x402Amount: 1.00,
  // },
  {
    id: "intelligence",
    match: (pathname) => /^\/api\/v1\/markets\/[^/]+\/intelligence$/.test(pathname),
    x402RoutePatterns: ["GET /api/v1/markets/*/intelligence"],
    creditCost: creditsFromX402Amount(0.25),
    x402Amount: 0.25,
  },
  {
    id: "signals",
    match: (pathname) => /^\/api\/v1\/markets\/[^/]+\/signals$/.test(pathname),
    x402RoutePatterns: ["GET /api/v1/markets/*/signals"],
    creditCost: creditsFromX402Amount(0.025),
    x402Amount: 0.025,
  },
  {
    id: "mispriced",
    match: (pathname) => pathname === "/api/v1/markets/mispriced",
    x402RoutePatterns: ["GET /api/v1/markets/mispriced"],
    creditCost: creditsFromX402Amount(0.1),
    x402Amount: 0.10,
  },
  {
    id: "markets",
    match: (pathname) =>
      pathname === "/api/v1/markets" || pathname === "/api/v1/markets/lookup",
    x402RoutePatterns: ["GET /api/v1/markets", "GET /api/v1/markets/lookup"],
    creditCost: creditsFromX402Amount(0.005),
    x402Amount: 0.005,
  },
] as const;

export function resolveMonetizedRoutePolicy(
  pathname: string,
  method?: string
): MonetizedRoutePolicy | null {
  for (const policy of MONETIZED_ROUTE_POLICIES) {
    if (policy.match(pathname, method)) return policy;
  }
  return null;
}

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