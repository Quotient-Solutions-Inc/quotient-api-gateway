export type SubscriptionStatus = "active" | "inactive" | "past_due" | "canceled";

export interface BillingAccount {
  customerId: string;
  apiKeyHash: string;
  stripeCustomerId: string | undefined;
  planId: string | undefined;
  stripePriceId: string | undefined;
  stripeSubscriptionId: string | undefined;
  cancelAtPeriodEnd: boolean;
  subscriptionStatus: SubscriptionStatus;
  creditsRemaining: number;
  creditsIncluded: number;
  currentPeriodStart: string | undefined;
  currentPeriodEnd: string | undefined;
  updatedAt: string;
}

export interface BillingPlan {
  planId: string;
  name: string;
  productId: string;
  priceId: string;
  amountUsd: number;
  currency: string;
  interval: string;
  includedCredits: number;
}

export interface CreditUsageEvent {
  timestamp: string;
  requestId: string;
  customerId: string;
  route: string;
  creditsCharged: number;
  creditsRemaining?: number;
  decision: "subscription_allowed" | "subscription_insufficient_credits" | "subscription_inactive" | "x402_fallback_paid";
  source: "subscription" | "x402_fallback";
}

export interface StripeCustomerStateUpdate {
  userId: string | undefined;
  apiKeyHash: string;
  stripeCustomerId: string | undefined;
  planId: string | undefined;
  stripePriceId: string | undefined;
  stripeSubscriptionId: string | undefined;
  cancelAtPeriodEnd: boolean | undefined;
  creditsIncluded: number | undefined;
  subscriptionStatus: SubscriptionStatus;
  currentPeriodStart: string | undefined;
  currentPeriodEnd: string | undefined;
  replenishCredits: boolean;
}

export interface BillingStoreLike {
  resolveCustomerFromApiKey(apiKey: string): Promise<{ customerId: string; apiKeyHash: string; userId: string } | null>;
  getAccount(customerId: string): Promise<BillingAccount | null>;
  getOrCreateAccount(customerId: string, apiKeyHash: string): Promise<BillingAccount>;
  hasActiveSubscription(customerId: string): Promise<boolean>;
  getCreditsRemaining(customerId: string): Promise<number>;
  consumeCreditsForRoute(
    customerId: string,
    route: string,
    routeCost: number,
    source?: "subscription" | "x402_fallback"
  ): Promise<{ ok: boolean; remaining: number }>;
  applyStripeState(update: StripeCustomerStateUpdate): Promise<BillingAccount>;
}
