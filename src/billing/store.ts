import crypto from "node:crypto";
import type { BillingAccount, BillingStoreLike, StripeCustomerStateUpdate } from "./types.js";
import type { BillingConfig } from "./config.js";
import { executeBillingQuery } from "./neo4j.js";

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryBillingStore implements BillingStoreLike {
  private readonly accounts = new Map<string, BillingAccount>();
  constructor(private readonly config: BillingConfig) {}

  async resolveCustomerFromApiKey(
    apiKey: string
  ): Promise<{ customerId: string; apiKeyHash: string; userId: string } | null> {
    const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const userId = `user_${apiKeyHash.slice(0, 16)}`;
    return {
      customerId: userId,
      apiKeyHash,
      userId
    };
  }

  private createDefaultAccount(customerId: string, apiKeyHash: string): BillingAccount {
    return {
      customerId,
      apiKeyHash,
      stripeCustomerId: undefined,
      planId: undefined,
      stripePriceId: undefined,
      stripeSubscriptionId: undefined,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "inactive",
      creditsRemaining: 0,
      creditsIncluded: 0,
      currentPeriodStart: undefined,
      currentPeriodEnd: undefined,
      updatedAt: nowIso()
    };
  }

  async getOrCreateAccount(customerId: string, apiKeyHash: string): Promise<BillingAccount> {
    const existing = this.accounts.get(customerId);
    if (existing) return existing;
    const created = this.createDefaultAccount(customerId, apiKeyHash);
    this.accounts.set(customerId, created);
    return created;
  }

  async getAccount(customerId: string): Promise<BillingAccount | null> {
    return this.accounts.get(customerId) ?? null;
  }

  async hasActiveSubscription(customerId: string): Promise<boolean> {
    const account = this.accounts.get(customerId);
    return Boolean(account && account.subscriptionStatus === "active");
  }

  async getCreditsRemaining(customerId: string): Promise<number> {
    const account = this.accounts.get(customerId);
    return account?.creditsRemaining ?? 0;
  }

  async consumeCreditsForRoute(
    customerId: string,
    _route: string,
    routeCost: number,
    _source: "subscription" | "x402_fallback" = "subscription"
  ): Promise<{ ok: boolean; remaining: number }> {
    const account = this.accounts.get(customerId);
    if (!account || account.subscriptionStatus !== "active") {
      return { ok: false, remaining: 0 };
    }
    if (account.creditsRemaining < routeCost) {
      return { ok: false, remaining: account.creditsRemaining };
    }
    account.creditsRemaining -= routeCost;
    account.updatedAt = nowIso();
    return { ok: true, remaining: account.creditsRemaining };
  }

  async applyStripeState(update: StripeCustomerStateUpdate): Promise<BillingAccount> {
    const customerId = update.userId ?? `user_${update.apiKeyHash.slice(0, 16)}`;
    const existing = this.accounts.get(customerId) ?? this.createDefaultAccount(customerId, update.apiKeyHash);
    existing.subscriptionStatus = update.subscriptionStatus;
    existing.currentPeriodStart = update.currentPeriodStart;
    existing.currentPeriodEnd = update.currentPeriodEnd;
    if (update.planId) {
      existing.planId = update.planId;
    }
    if (update.stripePriceId) {
      existing.stripePriceId = update.stripePriceId;
    }
    if (update.stripeSubscriptionId) {
      existing.stripeSubscriptionId = update.stripeSubscriptionId;
    }
    if (update.cancelAtPeriodEnd !== undefined) {
      existing.cancelAtPeriodEnd = update.cancelAtPeriodEnd;
    }
    if (update.creditsIncluded !== undefined) {
      existing.creditsIncluded = update.creditsIncluded;
    }
    if (update.stripeCustomerId !== undefined) {
      existing.stripeCustomerId = update.stripeCustomerId;
    }
    if (update.replenishCredits && update.subscriptionStatus === "active") {
      existing.creditsRemaining = update.creditsIncluded ?? existing.creditsIncluded;
    }
    existing.updatedAt = nowIso();
    this.accounts.set(customerId, existing);
    return existing;
  }
}

export class Neo4jBillingStore implements BillingStoreLike {
  constructor(private readonly config: BillingConfig) {}

  async resolveCustomerFromApiKey(
    apiKey: string
  ): Promise<{ customerId: string; apiKeyHash: string; userId: string } | null> {
    const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const rows = await executeBillingQuery<{ userId: string; userExists: boolean }>(
      `MATCH (k:ApiKey {key: $apiKey})
       WHERE k.isActive = true
       OPTIONAL MATCH (u:User {id: k.userId})
       RETURN k.userId AS userId, u IS NOT NULL AS userExists`,
      { apiKey }
    );
    const row = rows[0];
    if (!row || !row.userId) {
      return null;
    }
    if (!row.userExists) {
      throw new Error(`Billing identity mapping failed: no User node for userId ${row.userId}`);
    }
    return {
      customerId: row.userId,
      apiKeyHash,
      userId: row.userId
    };
  }

  async getOrCreateAccount(customerId: string, apiKeyHash: string): Promise<BillingAccount> {
    const status: "active" | "inactive" = "inactive";
    const credits = 0;
    const rows = await executeBillingQuery<{
      customerId: string;
      apiKeyHash: string;
      stripeCustomerId: string | null;
      planId: string | null;
      stripePriceId: string | null;
      stripeSubscriptionId: string | null;
      cancelAtPeriodEnd: boolean | null;
      subscriptionStatus: "active" | "inactive" | "past_due" | "canceled";
      creditsRemaining: number;
      creditsIncluded: number;
      currentPeriodStart: string | null;
      currentPeriodEnd: string | null;
      updatedAt: string;
    }>(
      `MATCH (u:User {id: $customerId})
       MERGE (b:BillingAccount {customerId: $customerId})
       ON CREATE SET
         b.apiKeyHash = $apiKeyHash,
         b.subscriptionStatus = $status,
         b.creditsRemaining = $credits,
         b.creditsIncluded = 0,
         b.updatedAt = datetime()
       MERGE (u)-[:HAS_BILLING_ACCOUNT]->(b)
       RETURN b.customerId AS customerId,
              b.apiKeyHash AS apiKeyHash,
              b.stripeCustomerId AS stripeCustomerId,
              b.planId AS planId,
              b.stripePriceId AS stripePriceId,
              b.stripeSubscriptionId AS stripeSubscriptionId,
              b.cancelAtPeriodEnd AS cancelAtPeriodEnd,
              b.subscriptionStatus AS subscriptionStatus,
              COALESCE(b.creditsRemaining, 0) AS creditsRemaining,
              COALESCE(b.creditsIncluded, 0) AS creditsIncluded,
              b.currentPeriodStart AS currentPeriodStart,
              b.currentPeriodEnd AS currentPeriodEnd,
              toString(b.updatedAt) AS updatedAt`,
      {
        customerId,
        apiKeyHash,
        status,
        credits
      }
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to load or create billing account.");
    return {
      customerId: row.customerId,
      apiKeyHash: row.apiKeyHash,
      stripeCustomerId: row.stripeCustomerId ?? undefined,
      planId: row.planId ?? undefined,
      stripePriceId: row.stripePriceId ?? undefined,
      stripeSubscriptionId: row.stripeSubscriptionId ?? undefined,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd === true,
      subscriptionStatus: row.subscriptionStatus,
      creditsRemaining: row.creditsRemaining,
      creditsIncluded: row.creditsIncluded,
      currentPeriodStart: row.currentPeriodStart ?? undefined,
      currentPeriodEnd: row.currentPeriodEnd ?? undefined,
      updatedAt: row.updatedAt
    };
  }

  async hasActiveSubscription(customerId: string): Promise<boolean> {
    const rows = await executeBillingQuery<{ active: boolean }>(
      `MATCH (b:BillingAccount {customerId: $customerId})
       RETURN b.subscriptionStatus = 'active' AS active`,
      { customerId }
    );
    return Boolean(rows[0]?.active);
  }

  async getCreditsRemaining(customerId: string): Promise<number> {
    const rows = await executeBillingQuery<{ credits: number }>(
      `MATCH (b:BillingAccount {customerId: $customerId})
       RETURN COALESCE(b.creditsRemaining, 0) AS credits`,
      { customerId }
    );
    return rows[0]?.credits ?? 0;
  }

  async consumeCreditsForRoute(
    customerId: string,
    _route: string,
    routeCost: number,
    _source: "subscription" | "x402_fallback" = "subscription"
  ): Promise<{ ok: boolean; remaining: number }> {
    const rows = await executeBillingQuery<{ remaining: number }>(
      `MATCH (b:BillingAccount {customerId: $customerId})
       WHERE b.subscriptionStatus = 'active' AND COALESCE(b.creditsRemaining, 0) >= $cost
       SET b.creditsRemaining = COALESCE(b.creditsRemaining, 0) - $cost,
           b.updatedAt = datetime()
       RETURN b.creditsRemaining AS remaining`,
      { customerId, cost: routeCost }
    );
    if (rows[0]) {
      return { ok: true, remaining: rows[0].remaining };
    }
    const remaining = await this.getCreditsRemaining(customerId);
    return { ok: false, remaining };
  }

  async applyStripeState(update: StripeCustomerStateUpdate): Promise<BillingAccount> {
    if (!update.userId) {
      throw new Error("Stripe update missing user_id metadata.");
    }
    const customerId = update.userId;
    await this.getOrCreateAccount(customerId, update.apiKeyHash);
    await executeBillingQuery(
      `MATCH (b:BillingAccount {customerId: $customerId})
       SET b.subscriptionStatus = $status,
           b.currentPeriodStart = $periodStart,
           b.currentPeriodEnd = $periodEnd,
           b.updatedAt = datetime()
       FOREACH (_ IN CASE WHEN $stripeCustomerId IS NULL THEN [] ELSE [1] END |
         SET b.stripeCustomerId = $stripeCustomerId
       )
       FOREACH (_ IN CASE WHEN $planId IS NULL THEN [] ELSE [1] END |
         SET b.planId = $planId
       )
       FOREACH (_ IN CASE WHEN $stripePriceId IS NULL THEN [] ELSE [1] END |
         SET b.stripePriceId = $stripePriceId
       )
       FOREACH (_ IN CASE WHEN $stripeSubscriptionId IS NULL THEN [] ELSE [1] END |
         SET b.stripeSubscriptionId = $stripeSubscriptionId
       )
       FOREACH (_ IN CASE WHEN $cancelAtPeriodEnd IS NULL THEN [] ELSE [1] END |
         SET b.cancelAtPeriodEnd = $cancelAtPeriodEnd
       )
       FOREACH (_ IN CASE WHEN $creditsIncluded IS NULL THEN [] ELSE [1] END |
         SET b.creditsIncluded = $creditsIncluded
       )
       FOREACH (_ IN CASE WHEN $replenishCredits AND $status = 'active' THEN [1] ELSE [] END |
         SET b.creditsRemaining = COALESCE($creditsIncluded, b.creditsIncluded, 0)
       )`,
      {
        customerId,
        status: update.subscriptionStatus,
        periodStart: update.currentPeriodStart ?? null,
        periodEnd: update.currentPeriodEnd ?? null,
        stripeCustomerId: update.stripeCustomerId ?? null,
        planId: update.planId ?? null,
        stripePriceId: update.stripePriceId ?? null,
        stripeSubscriptionId: update.stripeSubscriptionId ?? null,
        cancelAtPeriodEnd: update.cancelAtPeriodEnd ?? null,
        creditsIncluded: update.creditsIncluded ?? null,
        replenishCredits: update.replenishCredits,
      }
    );
    return this.getOrCreateAccount(customerId, update.apiKeyHash);
  }

  async getAccount(customerId: string): Promise<BillingAccount | null> {
    const rows = await executeBillingQuery<{
      customerId: string;
      apiKeyHash: string;
      stripeCustomerId: string | null;
      planId: string | null;
      stripePriceId: string | null;
      stripeSubscriptionId: string | null;
      cancelAtPeriodEnd: boolean | null;
      subscriptionStatus: "active" | "inactive" | "past_due" | "canceled";
      creditsRemaining: number;
      creditsIncluded: number;
      currentPeriodStart: string | null;
      currentPeriodEnd: string | null;
      updatedAt: string;
    }>(
      `MATCH (b:BillingAccount {customerId: $customerId})
       RETURN b.customerId AS customerId,
              b.apiKeyHash AS apiKeyHash,
              b.stripeCustomerId AS stripeCustomerId,
              b.planId AS planId,
              b.stripePriceId AS stripePriceId,
              b.stripeSubscriptionId AS stripeSubscriptionId,
              b.cancelAtPeriodEnd AS cancelAtPeriodEnd,
              b.subscriptionStatus AS subscriptionStatus,
              COALESCE(b.creditsRemaining, 0) AS creditsRemaining,
              COALESCE(b.creditsIncluded, 0) AS creditsIncluded,
              b.currentPeriodStart AS currentPeriodStart,
              b.currentPeriodEnd AS currentPeriodEnd,
              toString(b.updatedAt) AS updatedAt`,
      { customerId }
    );
    const row = rows[0];
    if (!row) return null;
    return {
      customerId: row.customerId,
      apiKeyHash: row.apiKeyHash,
      stripeCustomerId: row.stripeCustomerId ?? undefined,
      planId: row.planId ?? undefined,
      stripePriceId: row.stripePriceId ?? undefined,
      stripeSubscriptionId: row.stripeSubscriptionId ?? undefined,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd === true,
      subscriptionStatus: row.subscriptionStatus,
      creditsRemaining: row.creditsRemaining,
      creditsIncluded: row.creditsIncluded,
      currentPeriodStart: row.currentPeriodStart ?? undefined,
      currentPeriodEnd: row.currentPeriodEnd ?? undefined,
      updatedAt: row.updatedAt
    };
  }
}
