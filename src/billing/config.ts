export interface BillingConfig {
  enabled: boolean;
  providerMode: "mock" | "stripe";
  monthlyPlanId: string;
  monthlyPlanPriceUsd: number;
  includedCredits: number;
  routeCreditCosts: {
    markets: number;
    intelligence: number;
    signals: number;
  };
  mockSubscribedApiKeyHashes: Set<string>;
  mockSubscribedUserIds: Set<string>;
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
}

function parseNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric env var ${name}: ${raw}`);
  }
  return value;
}

export function routeKeyForPath(pathname: string): "markets" | "intelligence" | "signals" {
  if (pathname.includes("/intelligence")) return "intelligence";
  if (pathname.includes("/signals")) return "signals";
  return "markets";
}

export function loadBillingConfig(): BillingConfig {
  const hashList = (process.env.BILLING_MOCK_ACTIVE_API_KEY_HASHES || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const userList = (process.env.BILLING_MOCK_ACTIVE_USER_IDS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const providerModeRaw = (process.env.BILLING_PROVIDER_MODE || "mock").toLowerCase();
  const providerMode = providerModeRaw === "stripe" ? "stripe" : "mock";

  return {
    enabled: (process.env.BILLING_ENABLED || "true").toLowerCase() !== "false",
    providerMode,
    monthlyPlanId: process.env.BILLING_PLAN_ID || "starter_10",
    monthlyPlanPriceUsd: parseNumber("BILLING_PLAN_PRICE_USD", 10),
    includedCredits: parseNumber("BILLING_INCLUDED_CREDITS", 1000),
    routeCreditCosts: {
      markets: parseNumber("BILLING_CREDIT_COST_MARKETS", 1),
      intelligence: parseNumber("BILLING_CREDIT_COST_INTELLIGENCE", 2),
      signals: parseNumber("BILLING_CREDIT_COST_SIGNALS", 2)
    },
    mockSubscribedApiKeyHashes: new Set(hashList),
    mockSubscribedUserIds: new Set(userList),
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET
  };
}
