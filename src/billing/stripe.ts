import Stripe from "stripe";
import type { BillingConfig } from "./config.js";
import type { StripeCustomerStateUpdate } from "./types.js";

function toIsoFromEpoch(epochSeconds?: number): string | undefined {
  if (!epochSeconds) return undefined;
  return new Date(epochSeconds * 1000).toISOString();
}

export class StripeBillingService {
  private readonly stripe?: Stripe;

  constructor(private readonly config: BillingConfig) {
    if (config.providerMode === "stripe" && config.stripeSecretKey) {
      this.stripe = new Stripe(config.stripeSecretKey);
    }
  }

  isEnabled(): boolean {
    return Boolean(this.stripe && this.config.stripeWebhookSecret);
  }

  parseWebhookEvent(rawBody: Buffer, signatureHeader: string | undefined): Stripe.Event {
    if (!this.stripe || !this.config.stripeWebhookSecret) {
      throw new Error("Stripe billing is not configured.");
    }
    if (!signatureHeader) {
      throw new Error("Missing Stripe signature header.");
    }
    return this.stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      this.config.stripeWebhookSecret
    );
  }

  toStateUpdateFromEvent(event: Stripe.Event): StripeCustomerStateUpdate | null {
    if (event.type.startsWith("customer.subscription.")) {
      const obj = event.data.object as Stripe.Subscription & {
        current_period_start?: number;
        current_period_end?: number;
      };
      const userId = obj.metadata?.user_id;
      const apiKeyHash = obj.metadata?.api_key_hash || "unknown";
      if (!userId) return null;
      return {
        userId,
        apiKeyHash,
        stripeCustomerId: typeof obj.customer === "string" ? obj.customer : undefined,
        subscriptionStatus: obj.status === "active" ? "active" : obj.status === "past_due" ? "past_due" : "inactive",
        currentPeriodStart: toIsoFromEpoch(obj.current_period_start),
        currentPeriodEnd: toIsoFromEpoch(obj.current_period_end),
        replenishCredits: false
      };
    }

    if (event.type === "invoice.paid") {
      const obj = event.data.object as Stripe.Invoice;
      const userId = obj.metadata?.user_id;
      const apiKeyHash = obj.metadata?.api_key_hash || "unknown";
      if (!userId) return null;
      return {
        userId,
        apiKeyHash,
        stripeCustomerId: typeof obj.customer === "string" ? obj.customer : undefined,
        subscriptionStatus: "active",
        currentPeriodStart: undefined,
        currentPeriodEnd: undefined,
        replenishCredits: true
      };
    }

    if (event.type === "invoice.payment_failed") {
      const obj = event.data.object as Stripe.Invoice;
      const userId = obj.metadata?.user_id;
      const apiKeyHash = obj.metadata?.api_key_hash || "unknown";
      if (!userId) return null;
      return {
        userId,
        apiKeyHash,
        stripeCustomerId: typeof obj.customer === "string" ? obj.customer : undefined,
        subscriptionStatus: "past_due",
        currentPeriodStart: undefined,
        currentPeriodEnd: undefined,
        replenishCredits: false
      };
    }

    return null;
  }
}
