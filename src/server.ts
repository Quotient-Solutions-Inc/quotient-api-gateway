import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { URL } from "node:url";
import { InMemoryBillingStore, Neo4jBillingStore } from "./billing/store.js";
import { StripeBillingService } from "./billing/stripe.js";
import { loadBillingConfig, routeKeyForPath } from "./billing/config.js";
import type { BillingStoreLike, CreditUsageEvent } from "./billing/types.js";

interface Config {
  port: number;
  quotientApiBaseUrl: string;
  quotientApiKey: string;
  x402AcceptedChain: string;
  x402AcceptedAsset: string;
  x402PriceMarkets: number;
  x402PriceIntelligence: number;
  x402PriceSignals: number;
  x402TestToken: string;
}

interface ApiError {
  error: string;
  message: string;
}

interface PaymentChallenge extends ApiError {
  payment: {
    protocol: "x402";
    chain: string;
    asset: string;
    amount: number;
    recipient: string;
    memo: string;
  };
  billing?: {
    plan_id: string;
    required_credits: number;
  };
}

const config: Config = {
  port: Number(process.env.PORT || 8787),
  quotientApiBaseUrl: process.env.QUOTIENT_API_BASE_URL || "https://quotient-api.vercel.app",
  quotientApiKey: process.env.QUOTIENT_API_KEY || "",
  x402AcceptedChain: process.env.X402_ACCEPTED_CHAIN || "base",
  x402AcceptedAsset: process.env.X402_ACCEPTED_ASSET || "USDC",
  x402PriceMarkets: Number(process.env.X402_PRICE_MARKETS || 0.01),
  x402PriceIntelligence: Number(process.env.X402_PRICE_INTELLIGENCE || 0.02),
  x402PriceSignals: Number(process.env.X402_PRICE_SIGNALS || 0.015),
  x402TestToken: process.env.X402_TEST_TOKEN || "pay_local_test_token"
};
const billingConfig = loadBillingConfig();
const billingStore: BillingStoreLike = process.env.BILLING_STORE_BACKEND === "neo4j"
  ? new Neo4jBillingStore(billingConfig)
  : new InMemoryBillingStore(billingConfig);
const stripeBilling = new StripeBillingService(billingConfig);
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const publicSkillPath = path.resolve(thisDir, "../public/skills/quotient-api-gateway/SKILL.md");

if (!config.quotientApiKey) {
  console.error("Missing QUOTIENT_API_KEY");
  process.exit(1);
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  res.end(JSON.stringify(body, null, 2));
}

function getPriceForPath(pathname: string): number {
  if (pathname.includes("/intelligence")) return config.x402PriceIntelligence;
  if (pathname.includes("/signals")) return config.x402PriceSignals;
  return config.x402PriceMarkets;
}

function build402Challenge(pathname: string): PaymentChallenge {
  const routeKey = routeKeyForPath(pathname);
  const routeCreditCost = billingConfig.routeCreditCosts[routeKey];
  return {
    error: "payment_required",
    message: "Pay this request with x402 before retrying.",
    payment: {
      protocol: "x402",
      chain: config.x402AcceptedChain,
      asset: config.x402AcceptedAsset,
      amount: getPriceForPath(pathname),
      recipient: "quotient-api-gateway",
      memo: pathname
    },
    billing: {
      plan_id: billingConfig.monthlyPlanId,
      required_credits: routeCreditCost
    }
  };
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function requirePayment(req: IncomingMessage, res: ServerResponse): boolean {
  const paymentHeader = req.headers["x-payment"];
  if (paymentHeader !== config.x402TestToken) {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    json(res, 402, build402Challenge(path), {
      "x-payment-protocol": "x402",
      "x-payment-chain": config.x402AcceptedChain,
      "x-payment-asset": config.x402AcceptedAsset
    });
    return false;
  }
  return true;
}

async function proxyToQuotient(req: IncomingMessage): Promise<Response> {
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const upstreamUrl = new URL(reqUrl.pathname + reqUrl.search, config.quotientApiBaseUrl);
  const quotedApiKey = req.headers["x-quotient-api-key"];
  const hasQuotedApiKey = typeof quotedApiKey === "string" && quotedApiKey.trim() !== "";
  const upstreamApiKey = hasQuotedApiKey ? quotedApiKey.trim() : config.quotientApiKey;
  const gatewaySharedSecret = process.env.QUOTIENT_GATEWAY_SHARED_SECRET;
  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${upstreamApiKey}`,
    "content-type": "application/json"
  };
  if (gatewaySharedSecret) {
    upstreamHeaders["x-quotient-gateway-secret"] = gatewaySharedSecret;
  }

  return fetch(upstreamUrl, {
    method: "GET",
    headers: upstreamHeaders
  });
}

function getRouteCreditCost(pathname: string): number {
  const key = routeKeyForPath(pathname);
  return billingConfig.routeCreditCosts[key];
}

function emitUsageLog(event: CreditUsageEvent): void {
  console.log(JSON.stringify({ type: "billing_usage", ...event }));
}

function requestIdFrom(req: IncomingMessage): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.trim() !== "") return incoming.trim();
  return crypto.randomUUID();
}

async function canUseSubscriptionCredits(
  apiKey: string,
  pathname: string,
  requestId: string
): Promise<{ allowed: boolean; customerId: string; remaining: number }> {
  if (!billingConfig.enabled) {
    return { allowed: true, customerId: "billing_disabled", remaining: Number.MAX_SAFE_INTEGER };
  }
  const resolved = await billingStore.resolveCustomerFromApiKey(apiKey);
  if (!resolved) {
    throw new Error("Billing identity resolution failed for provided API key.");
  }
  const { customerId, apiKeyHash } = resolved;
  await billingStore.getOrCreateAccount(customerId, apiKeyHash);

  if (!(await billingStore.hasActiveSubscription(customerId))) {
    const remaining = await billingStore.getCreditsRemaining(customerId);
    emitUsageLog({
      timestamp: new Date().toISOString(),
      requestId,
      customerId,
      route: pathname,
      creditsCharged: 0,
      creditsRemaining: remaining,
      decision: "subscription_inactive",
      source: "subscription"
    });
    return { allowed: false, customerId, remaining };
  }
  const routeCost = getRouteCreditCost(pathname);
  const consumed = await billingStore.consumeCreditsForRoute(customerId, pathname, routeCost, "subscription");
  emitUsageLog({
    timestamp: new Date().toISOString(),
    requestId,
    customerId,
    route: pathname,
    creditsCharged: consumed.ok ? routeCost : 0,
    creditsRemaining: consumed.remaining,
    decision: consumed.ok ? "subscription_allowed" : "subscription_insufficient_credits",
    source: "subscription"
  });
  return { allowed: consumed.ok, customerId, remaining: consumed.remaining };
}

async function servePublicSkill(res: ServerResponse): Promise<void> {
  const markdown = await readFile(publicSkillPath, "utf8");
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "public, max-age=300"
  });
  res.end(markdown);
}

async function handleStripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed", message: "Use POST." });
    return;
  }
  if (!stripeBilling.isEnabled()) {
    json(res, 503, { error: "stripe_not_configured", message: "Stripe webhook handling is not configured." });
    return;
  }

  const body = await readRawBody(req);
  const signature = req.headers["stripe-signature"];
  try {
    const event = stripeBilling.parseWebhookEvent(body, typeof signature === "string" ? signature : undefined);
    const update = stripeBilling.toStateUpdateFromEvent(event);
    if (update) {
      const account = await billingStore.applyStripeState(update);
      json(res, 200, {
        ok: true,
        event_type: event.type,
        customer_id: account.customerId,
        subscription_status: account.subscriptionStatus,
        credits_remaining: account.creditsRemaining
      });
      return;
    }
    json(res, 200, { ok: true, ignored: true, event_type: event.type });
  } catch (error: unknown) {
    json(res, 400, {
      error: "invalid_webhook",
      message: error instanceof Error ? error.message : "Failed to process webhook."
    });
  }
}

async function handleBillingSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }

  const keyHeader = req.headers["x-quotient-api-key"];
  if (typeof keyHeader !== "string" || keyHeader.trim() === "") {
    json(res, 422, { error: "missing_api_key", message: "x-quotient-api-key is required." });
    return;
  }

  const apiKey = keyHeader.trim();
  const requestId = requestIdFrom(req);
  try {
    const resolved = await billingStore.resolveCustomerFromApiKey(apiKey);
    if (!resolved) {
      json(res, 401, { error: "invalid_api_key", message: "Provided API key is invalid." }, {
        "x-request-id": requestId
      });
      return;
    }
    const account = await billingStore.getOrCreateAccount(resolved.customerId, resolved.apiKeyHash);
    json(res, 200, {
      customer_id: account.customerId,
      subscription_status: account.subscriptionStatus,
      credits_remaining: account.creditsRemaining,
      credits_included: account.creditsIncluded,
      current_period_start: account.currentPeriodStart ?? null,
      current_period_end: account.currentPeriodEnd ?? null
    }, {
      "x-request-id": requestId
    });
  } catch (error: unknown) {
    json(res, 500, {
      error: "billing_identity_mapping_error",
      message: error instanceof Error ? error.message : "Failed to resolve billing identity."
    }, {
      "x-request-id": requestId
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      json(res, 400, { error: "invalid_request", message: "Missing URL." });
      return;
    }

    const reqUrl = new URL(req.url, "http://localhost");
    const pathname = reqUrl.pathname;

    if (pathname === "/health") {
      json(res, 200, { ok: true, service: "quotient-api-gateway" });
      return;
    }

    if (
      (pathname === "/public/skills/quotient-api-gateway/SKILL.md" ||
        pathname === "/public/skills/quotient-gateway/SKILL.md") &&
      req.method === "GET"
    ) {
      await servePublicSkill(res);
      return;
    }

    if (pathname === "/api/billing/stripe/webhook") {
      await handleStripeWebhook(req, res);
      return;
    }

    if (pathname === "/api/billing/summary") {
      await handleBillingSummary(req, res);
      return;
    }

    if (pathname.startsWith("/api/v1/markets") && req.method === "GET") {
      const requestId = requestIdFrom(req);
      const clientKey = req.headers["x-quotient-api-key"];
      const hasClientKey = typeof clientKey === "string" && clientKey.trim() !== "";

      if (hasClientKey) {
        const upstreamRes = await proxyToQuotient(req);
        if (upstreamRes.status === 401 || upstreamRes.status === 403) {
          const text = await upstreamRes.text();
          res.writeHead(upstreamRes.status, {
            "content-type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8"
          });
          res.end(text);
          return;
        }

        let billing;
        try {
          billing = await canUseSubscriptionCredits(clientKey.trim(), pathname, requestId);
        } catch (error: unknown) {
          json(res, 500, {
            error: "billing_identity_mapping_error",
            message: error instanceof Error ? error.message : "Failed to resolve billing identity."
          }, {
            "x-request-id": requestId
          });
          return;
        }
        if (!billing.allowed) {
          json(res, 402, build402Challenge(pathname), {
            "x-payment-protocol": "x402",
            "x-payment-chain": config.x402AcceptedChain,
            "x-payment-asset": config.x402AcceptedAsset,
            "x-request-id": requestId
          });
          return;
        }

        const text = await upstreamRes.text();
        res.writeHead(upstreamRes.status, {
          "content-type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8",
          "x-billing-customer-id": billing.customerId,
          "x-billing-credits-remaining": String(billing.remaining),
          "x-request-id": requestId
        });
        res.end(text);
        return;
      }

      if (!requirePayment(req, res)) return;
      const upstreamRes = await proxyToQuotient(req);
      const text = await upstreamRes.text();
      emitUsageLog({
        timestamp: new Date().toISOString(),
        requestId,
        customerId: "x402_fallback_unknown",
        route: pathname,
        creditsCharged: getRouteCreditCost(pathname),
        decision: "x402_fallback_paid",
        source: "x402_fallback"
      });
      res.writeHead(upstreamRes.status, {
        "content-type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8",
        "x-request-id": requestId
      });
      res.end(text);
      return;
    }

    json(res, 404, { error: "not_found", message: "Route not found." });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const body: ApiError = { error: "internal_error", message };
    json(res, 500, body);
  }
});

server.listen(config.port, () => {
  console.log(`quotient-api-gateway listening on http://localhost:${config.port}`);
});
