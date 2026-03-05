import Stripe from "stripe";
import type { BillingConfig } from "./config.js";
import type { BillingPlan, StripeCustomerStateUpdate } from "./types.js";

function toIsoFromEpoch(epochSeconds?: number): string | undefined {
  if (!epochSeconds) return undefined;
  return new Date(epochSeconds * 1000).toISOString();
}

export class StripeBillingService {
  private readonly stripe?: Stripe;
  private planCache: { expiresAt: number; plans: BillingPlan[] } | null = null;

  constructor(private readonly config: BillingConfig) {
    if (config.stripeSecretKey) {
      this.stripe = new Stripe(config.stripeSecretKey);
    }
  }

  isEnabled(): boolean {
    return Boolean(this.stripe && this.config.stripeWebhookSecret);
  }

  canCreateCheckoutSessions(): boolean {
    return Boolean(
      this.stripe &&
      this.config.stripeCheckoutSuccessUrl &&
      this.config.stripeCheckoutCancelUrl
    );
  }

  async listSelectablePlans(forceRefresh = false): Promise<BillingPlan[]> {
    if (!this.stripe) {
      throw new Error("Stripe billing is not configured.");
    }
    if (!forceRefresh && this.planCache && this.planCache.expiresAt > Date.now()) {
      return this.planCache.plans;
    }

    const plans: BillingPlan[] = [];
    let startingAfter: string | undefined;

    while (true) {
      const page = await this.stripe.prices.list({
        active: true,
        limit: 100,
        type: "recurring",
        ...(startingAfter ? { starting_after: startingAfter } : {}),
        expand: ["data.product"]
      });

      for (const price of page.data) {
        const product = typeof price.product === "string" ? null : price.product;
        if (!product || product.deleted) continue;
        if (!product.active) continue;

        const productMetadataValue = product.metadata?.[this.config.stripePlanProductMetadataKey];
        if (productMetadataValue !== this.config.stripePlanProductMetadataValue) continue;
        if (!price.recurring || price.unit_amount === null) continue;

        const includedCredits = this.extractIncludedCredits(price, product);
        if (!includedCredits || includedCredits <= 0) continue;

        const planId = this.resolvePlanId(price, product);
        plans.push({
          planId,
          name: product.name || planId,
          productId: product.id,
          priceId: price.id,
          amountUsd: price.unit_amount / 100,
          currency: price.currency,
          interval: price.recurring.interval,
          includedCredits
        });
      }

      if (!page.has_more || page.data.length === 0) break;
      const last = page.data[page.data.length - 1];
      if (!last) break;
      startingAfter = last.id;
    }

    plans.sort((a, b) => a.amountUsd - b.amountUsd);
    this.planCache = {
      expiresAt: Date.now() + this.config.stripePlanCacheTtlSeconds * 1000,
      plans
    };
    return plans;
  }

  async getSelectablePlanById(planId: string): Promise<BillingPlan | null> {
    const plans = await this.listSelectablePlans();
    return plans.find((plan) => plan.planId === planId) ?? null;
  }

  async cancelSubscriptionAtPeriodEnd(input: {
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
  }): Promise<{
    subscriptionId: string;
    status: Stripe.Subscription.Status;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | undefined;
  }> {
    if (!this.stripe) {
      throw new Error("Stripe billing is not configured.");
    }
    let subscription: Stripe.Subscription;
    if (input.stripeSubscriptionId) {
      subscription = await this.stripe.subscriptions.retrieve(input.stripeSubscriptionId);
    } else if (input.stripeCustomerId) {
      const subscriptions = await this.stripe.subscriptions.list({
        customer: input.stripeCustomerId,
        status: "all",
        limit: 20
      });
      const target = subscriptions.data.find((entry) =>
        ["active", "trialing", "past_due", "unpaid"].includes(entry.status)
      );
      if (!target) {
        throw new Error("No cancelable subscription found for customer.");
      }
      subscription = target;
    } else {
      throw new Error("Missing Stripe subscription context.");
    }

    const updated = await this.stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true
    });
    const updatedPeriodEnd = (updated as unknown as { current_period_end?: number }).current_period_end;
    return {
      subscriptionId: updated.id,
      status: updated.status,
      cancelAtPeriodEnd: updated.cancel_at_period_end,
      currentPeriodEnd: toIsoFromEpoch(updatedPeriodEnd)
    };
  }

  async createCheckoutSession(input: {
    userId: string;
    privyId: string;
    plan: BillingPlan;
    email?: string | null;
  }): Promise<{ id: string; url: string }> {
    if (!this.stripe) {
      throw new Error("Stripe billing is not configured.");
    }
    if (!this.config.stripeCheckoutSuccessUrl || !this.config.stripeCheckoutCancelUrl) {
      throw new Error("Missing checkout success/cancel URLs.");
    }

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [{ price: input.plan.priceId, quantity: 1 }],
      success_url: `${this.config.stripeCheckoutSuccessUrl}?sessionId={CHECKOUT_SESSION_ID}`,
      cancel_url: this.config.stripeCheckoutCancelUrl,
      metadata: {
        user_id: input.userId,
        privy_id: input.privyId,
        plan_id: input.plan.planId,
        stripe_price_id: input.plan.priceId,
        included_credits: String(input.plan.includedCredits)
      },
      subscription_data: {
        metadata: {
          user_id: input.userId,
          privy_id: input.privyId,
          plan_id: input.plan.planId,
          stripe_price_id: input.plan.priceId,
          included_credits: String(input.plan.includedCredits)
        }
      }
    };
    if (input.email) {
      params.customer_email = input.email;
    }
    const session = await this.stripe.checkout.sessions.create(params);

    if (!session.url) {
      throw new Error("Stripe checkout session missing URL.");
    }
    return { id: session.id, url: session.url };
  }

  async getCheckoutSession(sessionId: string): Promise<{
    id: string;
    status: string | null;
    paymentStatus: string | null;
    customerId: string | null;
    subscriptionId: string | null;
  }> {
    if (!this.stripe) {
      throw new Error("Stripe billing is not configured.");
    }
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    return {
      id: session.id,
      status: session.status,
      paymentStatus: session.payment_status,
      customerId: typeof session.customer === "string" ? session.customer : null,
      subscriptionId: typeof session.subscription === "string" ? session.subscription : null
    };
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
      const priceId = obj.metadata?.stripe_price_id || obj.items.data[0]?.price.id;
      const includedCredits = this.parseCredits(obj.metadata?.included_credits);
      return {
        userId,
        apiKeyHash,
        stripeCustomerId: typeof obj.customer === "string" ? obj.customer : undefined,
        planId: obj.metadata?.plan_id,
        stripePriceId: priceId,
        stripeSubscriptionId: obj.id,
        cancelAtPeriodEnd: obj.cancel_at_period_end,
        creditsIncluded: includedCredits,
        subscriptionStatus:
          obj.status === "active"
            ? "active"
            : obj.status === "past_due"
              ? "past_due"
              : obj.status === "canceled"
                ? "canceled"
                : "inactive",
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
      const firstLine = obj.lines?.data?.[0];
      const priceId = obj.metadata?.stripe_price_id || firstLine?.pricing?.price_details?.price;
      const includedCredits = this.parseCredits(obj.metadata?.included_credits);
      const subscriptionId = (obj as unknown as { subscription?: string }).subscription;
      return {
        userId,
        apiKeyHash,
        stripeCustomerId: typeof obj.customer === "string" ? obj.customer : undefined,
        planId: obj.metadata?.plan_id,
        stripePriceId: priceId,
        stripeSubscriptionId: subscriptionId,
        cancelAtPeriodEnd: undefined,
        creditsIncluded: includedCredits,
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
      const firstLine = obj.lines?.data?.[0];
      const priceId = obj.metadata?.stripe_price_id || firstLine?.pricing?.price_details?.price;
      const includedCredits = this.parseCredits(obj.metadata?.included_credits);
      const subscriptionId = (obj as unknown as { subscription?: string }).subscription;
      return {
        userId,
        apiKeyHash,
        stripeCustomerId: typeof obj.customer === "string" ? obj.customer : undefined,
        planId: obj.metadata?.plan_id,
        stripePriceId: priceId,
        stripeSubscriptionId: subscriptionId,
        cancelAtPeriodEnd: undefined,
        creditsIncluded: includedCredits,
        subscriptionStatus: "past_due",
        currentPeriodStart: undefined,
        currentPeriodEnd: undefined,
        replenishCredits: false
      };
    }

    return null;
  }

  private resolvePlanId(price: Stripe.Price, product: Stripe.Product): string {
    return (
      price.metadata?.plan_id ||
      product.metadata?.plan_id ||
      price.lookup_key ||
      `${product.id}:${price.id}`
    );
  }

  private extractIncludedCredits(price: Stripe.Price, product: Stripe.Product): number | null {
    const metadataKey = this.config.stripePlanCreditsMetadataKey;
    const fromPrice = this.parseCredits(price.metadata?.[metadataKey]);
    if (fromPrice !== undefined) return fromPrice;
    const fromProduct = this.parseCredits(product.metadata?.[metadataKey]);
    if (fromProduct !== undefined) return fromProduct;
    return null;
  }

  private parseCredits(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.floor(parsed);
  }
}
