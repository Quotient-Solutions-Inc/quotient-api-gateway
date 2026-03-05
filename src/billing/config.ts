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
  stripePlanProductMetadataKey: string;
  stripePlanProductMetadataValue: string;
  stripePlanCreditsMetadataKey: string;
  stripePlanCacheTtlSeconds: number;
  x402: X402Config;
}

export interface MonetizedRoutePolicy {
  id: "markets" | "intelligence" | "signals";
  match: (pathname: string) => boolean;
  x402RoutePatterns: readonly string[];
  creditCost: number;
  x402Amount: number;
}

export const MONETIZED_ROUTE_POLICIES: readonly MonetizedRoutePolicy[] = [
  {
    id: "intelligence",
    match: (pathname) => /^\/api\/v1\/markets\/[^/]+\/intelligence$/.test(pathname),
    x402RoutePatterns: ["GET /api/v1/markets/*/intelligence"],
    creditCost: 2,
    x402Amount: 0.02
  },
  {
    id: "signals",
    match: (pathname) => /^\/api\/v1\/markets\/[^/]+\/signals$/.test(pathname),
    x402RoutePatterns: ["GET /api/v1/markets/*/signals"],
    creditCost: 2,
    x402Amount: 0.015
  },
  {
    id: "markets",
    match: (pathname) =>
      pathname === "/api/v1/markets" || pathname === "/api/v1/markets/lookup",
    x402RoutePatterns: ["GET /api/v1/markets", "GET /api/v1/markets/lookup"],
    creditCost: 1,
    x402Amount: 0.01
  }
] as const;

export function resolveMonetizedRoutePolicy(pathname: string): MonetizedRoutePolicy | null {
  for (const policy of MONETIZED_ROUTE_POLICIES) {
    if (policy.match(pathname)) return policy;
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

function parseBoolean(input: string | undefined, fallback: boolean): boolean {
  if (!input) return fallback;
  return input.trim().toLowerCase() === "true";
}

function parsePositiveNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("X402_IDEMPOTENCY_TTL_SECONDS must be a positive number.");
  }
  return parsed;
}

function resolvePayToByNetwork(enabledNetworks: readonly string[]): Record<string, string> {
  const configured: Record<string, string | undefined> = {
    "eip155:8453": process.env.X402_PAY_TO_EIP155_8453,
    "eip155:84532": process.env.X402_PAY_TO_EIP155_84532
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
  const stripePlanProductMetadataKey = (process.env.STRIPE_PLAN_PRODUCT_METADATA_KEY || "catalog").trim();
  const stripePlanProductMetadataValue = (process.env.STRIPE_PLAN_PRODUCT_METADATA_VALUE || "quotient_api").trim();
  const stripePlanCreditsMetadataKey = (process.env.STRIPE_PLAN_CREDITS_METADATA_KEY || "included_credits").trim();
  if (!stripePlanProductMetadataKey) {
    throw new Error("STRIPE_PLAN_PRODUCT_METADATA_KEY cannot be empty.");
  }
  if (!stripePlanProductMetadataValue) {
    throw new Error("STRIPE_PLAN_PRODUCT_METADATA_VALUE cannot be empty.");
  }
  if (!stripePlanCreditsMetadataKey) {
    throw new Error("STRIPE_PLAN_CREDITS_METADATA_KEY cannot be empty.");
  }

  return {
    stripeCheckoutSuccessUrl: process.env.STRIPE_CHECKOUT_SUCCESS_URL,
    stripeCheckoutCancelUrl: process.env.STRIPE_CHECKOUT_CANCEL_URL,
    internalServiceToken: process.env.QUOTIENT_INTERNAL_SERVICE_TOKEN,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    stripePlanProductMetadataKey,
    stripePlanProductMetadataValue,
    stripePlanCreditsMetadataKey,
    stripePlanCacheTtlSeconds: parsePositiveNumber(process.env.STRIPE_PLAN_CACHE_TTL_SECONDS, 300),
    x402: {
      facilitatorUrl: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
      enabledNetworks,
      payToByNetwork,
      paymentIdRequired: parseBoolean(process.env.X402_PAYMENT_ID_REQUIRED, false),
      idempotencyTtlSeconds: parsePositiveNumber(process.env.X402_IDEMPOTENCY_TTL_SECONDS, 3600)
    }
  };
}
