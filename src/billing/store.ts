import crypto from "node:crypto";
import type { AutoRechargeSettings, BillingAccount, BillingStoreLike } from "./types.js";
import type { BillingConfig } from "./config.js";
import { executeBillingQuery } from "./neo4j.js";

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
    const credits = 0;
    const rows = await executeBillingQuery<{
      customerId: string;
      apiKeyHash: string;
      stripeCustomerId: string | null;
      stripeDefaultPaymentMethodId: string | null;
      autoRechargeEnabled: boolean | null;
      autoRechargeThreshold: number | null;
      autoRechargePackId: string | null;
      creditsRemaining: number;
      updatedAt: string;
    }>(
      `MATCH (u:User {id: $customerId})
       MERGE (b:BillingAccount {customerId: $customerId})
       ON CREATE SET
         b.apiKeyHash = $apiKeyHash,
         b.creditsRemaining = $credits,
         b.autoRechargeEnabled = false,
         b.autoRechargeThreshold = 0,
         b.updatedAt = datetime()
       MERGE (u)-[:HAS_BILLING_ACCOUNT]->(b)
       RETURN b.customerId AS customerId,
              b.apiKeyHash AS apiKeyHash,
              b.stripeCustomerId AS stripeCustomerId,
              b.stripeDefaultPaymentMethodId AS stripeDefaultPaymentMethodId,
              b.autoRechargeEnabled AS autoRechargeEnabled,
              b.autoRechargeThreshold AS autoRechargeThreshold,
              b.autoRechargePackId AS autoRechargePackId,
              COALESCE(b.creditsRemaining, 0) AS creditsRemaining,
              toString(b.updatedAt) AS updatedAt`,
      {
        customerId,
        apiKeyHash,
        credits
      }
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to load or create billing account.");
    return {
      customerId: row.customerId,
      apiKeyHash: row.apiKeyHash,
      stripeCustomerId: row.stripeCustomerId ?? undefined,
      stripeDefaultPaymentMethodId: row.stripeDefaultPaymentMethodId ?? undefined,
      autoRechargeEnabled: row.autoRechargeEnabled === true,
      autoRechargeThreshold: row.autoRechargeThreshold ?? 0,
      autoRechargePackId: row.autoRechargePackId ?? undefined,
      creditsRemaining: row.creditsRemaining,
      updatedAt: row.updatedAt
    };
  }

  async getCreditsRemaining(customerId: string): Promise<number> {
    const rows = await executeBillingQuery<{ credits: number }>(
      `MATCH (b:BillingAccount {customerId: $customerId})
       RETURN COALESCE(b.creditsRemaining, 0) AS credits`,
      { customerId }
    );
    return rows[0]?.credits ?? 0;
  }

  async recordUsageDebit(input: {
    customerId: string;
    route: string;
    cost: number;
    requestId: string;
  }): Promise<{ ok: boolean; remaining: number }> {
    const rows = await executeBillingQuery<{ remaining: number }>(
      `MATCH (b:BillingAccount {customerId: $customerId})
       WHERE COALESCE(b.creditsRemaining, 0) >= $cost
       SET b.creditsRemaining = COALESCE(b.creditsRemaining, 0) - $cost,
           b.updatedAt = datetime()
       WITH b
       CREATE (e:BillingLedgerEvent {
         id: randomUUID(),
         customerId: $customerId,
         source: 'api_usage',
         amount: -$cost,
         route: $route,
         requestId: $requestId,
         balanceAfter: b.creditsRemaining,
         createdAt: datetime()
       })
       RETURN b.creditsRemaining AS remaining`,
      {
        customerId: input.customerId,
        cost: input.cost,
        route: input.route,
        requestId: input.requestId
      }
    );
    if (rows[0]) return { ok: true, remaining: rows[0].remaining };
    return { ok: false, remaining: await this.getCreditsRemaining(input.customerId) };
  }

  async consumeCreditsForRoute(
    customerId: string,
    route: string,
    routeCost: number,
    _source: "credits" | "x402_fallback" = "credits"
  ): Promise<{ ok: boolean; remaining: number }> {
    return this.recordUsageDebit({
      customerId,
      route,
      cost: routeCost,
      requestId: crypto.randomUUID()
    });
  }

  async grantCredits(input: {
    customerId: string;
    amount: number;
    source: "manual_purchase" | "auto_recharge";
    stripeCustomerId?: string;
    stripeEventId?: string;
    stripePaymentIntentId?: string;
    stripeCheckoutSessionId?: string;
  }): Promise<BillingAccount> {
    await executeBillingQuery(
      `MATCH (b:BillingAccount {customerId: $customerId})
       SET b.creditsRemaining = COALESCE(b.creditsRemaining, 0) + $amount,
           b.updatedAt = datetime()
       FOREACH (_ IN CASE WHEN $stripeCustomerId IS NULL THEN [] ELSE [1] END |
         SET b.stripeCustomerId = $stripeCustomerId
       )
       WITH b
       CREATE (e:BillingLedgerEvent {
         id: randomUUID(),
         customerId: $customerId,
         source: $source,
         amount: $amount,
         stripeEventId: $stripeEventId,
         stripePaymentIntentId: $stripePaymentIntentId,
         stripeCheckoutSessionId: $stripeCheckoutSessionId,
         balanceAfter: b.creditsRemaining,
         createdAt: datetime()
       })`,
      {
        customerId: input.customerId,
        amount: input.amount,
        source: input.source,
        stripeCustomerId: input.stripeCustomerId ?? null,
        stripeEventId: input.stripeEventId ?? null,
        stripePaymentIntentId: input.stripePaymentIntentId ?? null,
        stripeCheckoutSessionId: input.stripeCheckoutSessionId ?? null
      }
    );
    const account = await this.getAccount(input.customerId);
    if (!account) throw new Error("Billing account not found.");
    return account;
  }

  async hasProcessedStripeEvent(eventId: string): Promise<boolean> {
    const rows = await executeBillingQuery<{ id: string }>(
      `MATCH (e:ProcessedStripeEvent {id: $eventId}) RETURN e.id AS id LIMIT 1`,
      { eventId }
    );
    return rows.length > 0;
  }

  async markStripeEventProcessed(eventId: string, customerId: string): Promise<void> {
    await executeBillingQuery(
      `MERGE (e:ProcessedStripeEvent {id: $eventId})
       ON CREATE SET e.customerId = $customerId, e.createdAt = datetime()`,
      { eventId, customerId }
    );
  }

  async setStripeCustomerId(customerId: string, stripeCustomerId: string): Promise<BillingAccount> {
    await executeBillingQuery(
      `MATCH (b:BillingAccount {customerId: $customerId})
       SET b.stripeCustomerId = $stripeCustomerId,
           b.updatedAt = datetime()`,
      { customerId, stripeCustomerId }
    );
    const account = await this.getAccount(customerId);
    if (!account) throw new Error("Billing account not found.");
    return account;
  }

  async getAutoRechargeSettings(customerId: string): Promise<AutoRechargeSettings> {
    const rows = await executeBillingQuery<{
      enabled: boolean | null;
      threshold: number | null;
      packId: string | null;
    }>(
      `MATCH (b:BillingAccount {customerId: $customerId})
       RETURN b.autoRechargeEnabled AS enabled,
              b.autoRechargeThreshold AS threshold,
              b.autoRechargePackId AS packId`,
      { customerId }
    );
    const settings: AutoRechargeSettings = {
      enabled: rows[0]?.enabled === true,
      thresholdCredits: rows[0]?.threshold ?? 0
    };
    if (rows[0]?.packId) settings.packId = rows[0].packId;
    return settings;
  }

  async setAutoRechargeSettings(customerId: string, settings: AutoRechargeSettings): Promise<BillingAccount> {
    await executeBillingQuery(
      `MATCH (b:BillingAccount {customerId: $customerId})
       SET b.autoRechargeEnabled = $enabled,
           b.autoRechargeThreshold = $threshold,
           b.autoRechargePackId = $packId,
           b.updatedAt = datetime()`,
      {
        customerId,
        enabled: settings.enabled,
        threshold: settings.thresholdCredits,
        packId: settings.packId ?? null
      }
    );
    const account = await this.getAccount(customerId);
    if (!account) throw new Error("Billing account not found.");
    return account;
  }

  async getAccount(customerId: string): Promise<BillingAccount | null> {
    const rows = await executeBillingQuery<{
      customerId: string;
      apiKeyHash: string;
      stripeCustomerId: string | null;
      stripeDefaultPaymentMethodId: string | null;
      autoRechargeEnabled: boolean | null;
      autoRechargeThreshold: number | null;
      autoRechargePackId: string | null;
      creditsRemaining: number;
      updatedAt: string;
    }>(
      `MATCH (b:BillingAccount {customerId: $customerId})
       RETURN b.customerId AS customerId,
              b.apiKeyHash AS apiKeyHash,
              b.stripeCustomerId AS stripeCustomerId,
              b.stripeDefaultPaymentMethodId AS stripeDefaultPaymentMethodId,
              b.autoRechargeEnabled AS autoRechargeEnabled,
              b.autoRechargeThreshold AS autoRechargeThreshold,
              b.autoRechargePackId AS autoRechargePackId,
              COALESCE(b.creditsRemaining, 0) AS creditsRemaining,
              toString(b.updatedAt) AS updatedAt`,
      { customerId }
    );
    const row = rows[0];
    if (!row) return null;
    return {
      customerId: row.customerId,
      apiKeyHash: row.apiKeyHash,
      stripeCustomerId: row.stripeCustomerId ?? undefined,
      stripeDefaultPaymentMethodId: row.stripeDefaultPaymentMethodId ?? undefined,
      autoRechargeEnabled: row.autoRechargeEnabled === true,
      autoRechargeThreshold: row.autoRechargeThreshold ?? 0,
      autoRechargePackId: row.autoRechargePackId ?? undefined,
      creditsRemaining: row.creditsRemaining,
      updatedAt: row.updatedAt
    };
  }
}
