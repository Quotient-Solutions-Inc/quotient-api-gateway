export interface BillingAccount {
  customerId: string;
  apiKeyHash: string;
  stripeCustomerId: string | undefined;
  stripeDefaultPaymentMethodId: string | undefined;
  autoRechargeEnabled: boolean;
  autoRechargeThreshold: number;
  autoRechargePackId: string | undefined;
  creditsRemaining: number;
  updatedAt: string;
}

export interface BillingPack {
  packId: string;
  name: string;
  productId: string;
  priceId: string;
  amountUsd: number;
  currency: string;
  credits: number;
}

export interface CreditUsageEvent {
  timestamp: string;
  requestId: string;
  customerId: string;
  route: string;
  creditsCharged: number;
  creditsRemaining?: number;
  decision: "credits_allowed" | "credits_insufficient" | "x402_fallback_paid";
  source: "credits" | "x402_fallback";
}

export type CreditLedgerSource = "manual_purchase" | "auto_recharge" | "api_usage";

export interface CreditLedgerEntry {
  customerId: string;
  source: CreditLedgerSource;
  amount: number;
  balanceAfter: number;
  requestId?: string;
  route?: string;
  stripeEventId?: string;
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
  createdAt: string;
}

export interface AutoRechargeSettings {
  enabled: boolean;
  thresholdCredits: number;
  packId?: string;
}

export interface StripeCreditGrant {
  userId: string;
  apiKeyHash: string;
  stripeCustomerId?: string;
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
  stripeEventId: string;
  credits: number;
  source: "manual_purchase" | "auto_recharge";
  packId?: string;
}

export interface AutoRechargeExecutionResult {
  triggered: boolean;
  credited: boolean;
  creditsAdded: number;
  reason?: string;
}

export interface BillingStoreLike {
  resolveCustomerFromApiKey(apiKey: string): Promise<{ customerId: string; apiKeyHash: string; userId: string } | null>;
  getAccount(customerId: string): Promise<BillingAccount | null>;
  getOrCreateAccount(customerId: string, apiKeyHash: string): Promise<BillingAccount>;
  getCreditsRemaining(customerId: string): Promise<number>;
  recordUsageDebit(input: {
    customerId: string;
    route: string;
    cost: number;
    requestId: string;
  }): Promise<{ ok: boolean; remaining: number }>;
  consumeCreditsForRoute(
    customerId: string,
    route: string,
    routeCost: number,
    source?: "credits" | "x402_fallback"
  ): Promise<{ ok: boolean; remaining: number }>;
  grantCredits(input: {
    customerId: string;
    amount: number;
    source: "manual_purchase" | "auto_recharge";
    stripeCustomerId?: string;
    stripeEventId?: string;
    stripePaymentIntentId?: string;
    stripeCheckoutSessionId?: string;
  }): Promise<BillingAccount>;
  hasProcessedStripeEvent(eventId: string): Promise<boolean>;
  markStripeEventProcessed(eventId: string, customerId: string): Promise<void>;
  getAutoRechargeSettings(customerId: string): Promise<AutoRechargeSettings>;
  setAutoRechargeSettings(customerId: string, settings: AutoRechargeSettings): Promise<BillingAccount>;
}
