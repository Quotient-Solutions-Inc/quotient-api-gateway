import Stripe from "stripe";
import type { BillingConfig } from "./config.js";
import type { BillingPack, StripeCreditGrant } from "./types.js";

export class StripeBillingService {
  private readonly stripe?: Stripe;
  private packCache: { expiresAt: number; packs: BillingPack[] } | null = null;

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

  async listSelectablePacks(forceRefresh = false): Promise<BillingPack[]> {
    if (!this.stripe) {
      throw new Error("Stripe billing is not configured.");
    }
    if (!forceRefresh && this.packCache && this.packCache.expiresAt > Date.now()) {
      return this.packCache.packs;
    }

    const packs: BillingPack[] = [];
    let startingAfter: string | undefined;

    while (true) {
      const page = await this.stripe.prices.list({
        active: true,
        limit: 100,
        type: "one_time",
        ...(startingAfter ? { starting_after: startingAfter } : {}),
        expand: ["data.product"]
      });

      for (const price of page.data) {
        const product = typeof price.product === "string" ? null : price.product;
        if (!product || product.deleted) continue;
        if (!product.active) continue;

        const productMetadataValue = product.metadata?.[this.config.stripePackProductMetadataKey];
        if (productMetadataValue !== this.config.stripePackProductMetadataValue) continue;
        if (price.unit_amount === null) continue;

        const credits = this.extractCredits(price, product);
        if (!credits || credits <= 0) continue;

        const packId = this.resolvePackId(price, product);
        packs.push({
          packId,
          name: product.name || packId,
          productId: product.id,
          priceId: price.id,
          amountUsd: price.unit_amount / 100,
          currency: price.currency,
          credits
        });
      }

      if (!page.has_more || page.data.length === 0) break;
      const last = page.data[page.data.length - 1];
      if (!last) break;
      startingAfter = last.id;
    }

    packs.sort((a, b) => a.amountUsd - b.amountUsd);
    this.packCache = {
      expiresAt: Date.now() + this.config.stripePackCacheTtlSeconds * 1000,
      packs
    };
    return packs;
  }

  async getSelectablePackById(packId: string): Promise<BillingPack | null> {
    const packs = await this.listSelectablePacks();
    return packs.find((pack) => pack.packId === packId) ?? null;
  }

  async createCheckoutSession(input: {
    userId: string;
    privyId: string;
    pack: BillingPack;
    email?: string | null;
  }): Promise<{ id: string; url: string }> {
    if (!this.stripe) {
      throw new Error("Stripe billing is not configured.");
    }
    if (!this.config.stripeCheckoutSuccessUrl || !this.config.stripeCheckoutCancelUrl) {
      throw new Error("Missing checkout success/cancel URLs.");
    }

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      customer_creation: "always",
      line_items: [{ price: input.pack.priceId, quantity: 1 }],
      success_url: `${this.config.stripeCheckoutSuccessUrl}?sessionId={CHECKOUT_SESSION_ID}`,
      cancel_url: this.config.stripeCheckoutCancelUrl,
      metadata: {
        user_id: input.userId,
        privy_id: input.privyId,
        pack_id: input.pack.packId,
        stripe_price_id: input.pack.priceId,
        credits: String(input.pack.credits),
        purchase_type: "manual_purchase"
      },
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: {
          user_id: input.userId,
          privy_id: input.privyId,
          pack_id: input.pack.packId,
          stripe_price_id: input.pack.priceId,
          credits: String(input.pack.credits),
          purchase_type: "manual_purchase"
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

  async createAutoRechargeCharge(input: {
    customerId: string;
    stripeCustomerId: string;
    pack: BillingPack;
  }): Promise<{ paymentIntentId: string; status: string; credits: number; packId: string }> {
    if (!this.stripe) {
      throw new Error("Stripe billing is not configured.");
    }
    const paymentMethodId = await this.resolveReusablePaymentMethodId(input.stripeCustomerId);
    if (!paymentMethodId) {
      throw new Error(
        "No reusable Stripe payment method found for this customer. Complete a Stripe checkout with a savable card to enable auto-recharge."
      );
    }
    const intent = await this.stripe.paymentIntents.create({
      amount: Math.round(input.pack.amountUsd * 100),
      currency: input.pack.currency,
      customer: input.stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        user_id: input.customerId,
        pack_id: input.pack.packId,
        stripe_price_id: input.pack.priceId,
        credits: String(input.pack.credits),
        purchase_type: "auto_recharge"
      }
    });
    return {
      paymentIntentId: intent.id,
      status: intent.status,
      credits: input.pack.credits,
      packId: input.pack.packId
    };
  }

  private async resolveReusablePaymentMethodId(stripeCustomerId: string): Promise<string | null> {
    if (!this.stripe) {
      throw new Error("Stripe billing is not configured.");
    }

    const customer = await this.stripe.customers.retrieve(stripeCustomerId, {
      expand: ["invoice_settings.default_payment_method"]
    });
    if (!("deleted" in customer && customer.deleted)) {
      const defaultPaymentMethod = customer.invoice_settings?.default_payment_method;
      if (typeof defaultPaymentMethod === "string" && defaultPaymentMethod) {
        return defaultPaymentMethod;
      }
      if (defaultPaymentMethod && typeof defaultPaymentMethod !== "string") {
        return defaultPaymentMethod.id;
      }
    }

    const cardPaymentMethods = await this.stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: "card",
      limit: 1
    });
    return cardPaymentMethods.data[0]?.id ?? null;
  }

  async getCheckoutSession(sessionId: string): Promise<{
    id: string;
    status: string | null;
    paymentStatus: string | null;
    customerId: string | null;
    paymentIntentId: string | null;
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
      paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null
    };
  }

  async findCustomerIdForUser(userId: string): Promise<string | null> {
    if (!this.stripe) {
      throw new Error("Stripe billing is not configured.");
    }

    let startingAfterSession: string | undefined;
    for (let pageCount = 0; pageCount < 5; pageCount += 1) {
      const page = await this.stripe.checkout.sessions.list({
        limit: 100,
        ...(startingAfterSession ? { starting_after: startingAfterSession } : {})
      });
      for (const session of page.data) {
        if (session.metadata?.user_id !== userId) continue;
        if (typeof session.customer === "string") return session.customer;
      }
      if (!page.has_more || page.data.length === 0) break;
      const last = page.data[page.data.length - 1];
      if (!last) break;
      startingAfterSession = last.id;
    }

    let startingAfterIntent: string | undefined;
    for (let pageCount = 0; pageCount < 5; pageCount += 1) {
      const page = await this.stripe.paymentIntents.list({
        limit: 100,
        ...(startingAfterIntent ? { starting_after: startingAfterIntent } : {})
      });
      for (const intent of page.data) {
        if (intent.metadata?.user_id !== userId) continue;
        if (typeof intent.customer === "string") return intent.customer;
      }
      if (!page.has_more || page.data.length === 0) break;
      const last = page.data[page.data.length - 1];
      if (!last) break;
      startingAfterIntent = last.id;
    }

    return null;
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

  toCreditGrantFromEvent(event: Stripe.Event): StripeCreditGrant | null {
    if (event.type === "checkout.session.completed") {
      const obj = event.data.object as Stripe.Checkout.Session;
      const metadata = obj.metadata ?? {};
      const userId = metadata.user_id;
      const credits = this.parseCredits(metadata.credits);
      if (!userId || !credits || obj.payment_status !== "paid") return null;
      const grant: StripeCreditGrant = {
        userId,
        apiKeyHash: "unknown",
        stripeEventId: event.id,
        stripeCheckoutSessionId: obj.id,
        credits,
        source: metadata.purchase_type === "auto_recharge" ? "auto_recharge" : "manual_purchase"
      };
      if (typeof obj.customer === "string") grant.stripeCustomerId = obj.customer;
      if (typeof obj.payment_intent === "string") grant.stripePaymentIntentId = obj.payment_intent;
      if (metadata.pack_id) grant.packId = metadata.pack_id;
      return grant;
    }
    if (event.type === "payment_intent.succeeded") {
      const obj = event.data.object as Stripe.PaymentIntent;
      const metadata = obj.metadata ?? {};
      if (metadata.purchase_type !== "auto_recharge") return null;
      const userId = metadata.user_id;
      const credits = this.parseCredits(metadata.credits);
      if (!userId || !credits) return null;
      const grant: StripeCreditGrant = {
        userId,
        apiKeyHash: "unknown",
        stripeEventId: event.id,
        stripePaymentIntentId: obj.id,
        credits,
        source: "auto_recharge"
      };
      if (typeof obj.customer === "string") grant.stripeCustomerId = obj.customer;
      if (metadata.pack_id) grant.packId = metadata.pack_id;
      return grant;
    }
    return null;
  }

  private resolvePackId(price: Stripe.Price, product: Stripe.Product): string {
    return (
      product.metadata?.pack_id ||
      price.lookup_key ||
      `${product.id}:${price.id}`
    );
  }

  private extractCredits(price: Stripe.Price, product: Stripe.Product): number | null {
    const metadataKey = this.config.stripePackCreditsMetadataKey;
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
