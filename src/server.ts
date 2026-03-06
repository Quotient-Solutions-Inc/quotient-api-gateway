import "dotenv/config";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { URL } from "node:url";
import { Neo4jBillingStore } from "./billing/store.js";
import { StripeBillingService } from "./billing/stripe.js";
import { MONETIZED_ROUTE_POLICIES, loadBillingConfig, resolveMonetizedRoutePolicy } from "./billing/config.js";
import type { BillingStoreLike, CreditUsageEvent } from "./billing/types.js";
import { X402PaymentGateway } from "./billing/x402.js";

interface Config {
  port: number;
  quotientApiBaseUrl: string;
  gatewaySharedSecret: string;
}

interface ApiError {
  error: string;
  message: string;
}
const config: Config = {
  port: Number(process.env.PORT || 3001),
  quotientApiBaseUrl: process.env.QUOTIENT_API_BASE_URL || "http://localhost:3000",
  gatewaySharedSecret: process.env.QUOTIENT_GATEWAY_SHARED_SECRET || ""
};
const billingConfig = loadBillingConfig();
const billingStore: BillingStoreLike = new Neo4jBillingStore(billingConfig);
const stripeBilling = new StripeBillingService(billingConfig);
const x402Gateway = new X402PaymentGateway(billingConfig);
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const publicSkillPath = path.resolve(thisDir, "../public/skills/quotient-api-gateway/SKILL.md");
const MIN_PURCHASE_UNITS = 5;
const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Request-Id",
  "X-Quotient-Api-Key",
  "Payment-Signature",
  "Payment-Identifier"
].join(", ");

if (!config.gatewaySharedSecret) {
  console.error("Missing QUOTIENT_GATEWAY_SHARED_SECRET");
  process.exit(1);
}
if (!billingConfig.internalServiceToken) {
  console.error("Missing QUOTIENT_INTERNAL_SERVICE_TOKEN");
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

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    throw new Error("invalid_json_body");
  }
}

async function proxyToQuotient(req: IncomingMessage): Promise<Response> {
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const upstreamUrl = new URL(reqUrl.pathname + reqUrl.search, config.quotientApiBaseUrl);
  const upstreamHeaders: Record<string, string> = {
    "content-type": "application/json",
    "x-quotient-gateway-secret": config.gatewaySharedSecret
  };
  const incomingRequestId = req.headers["x-request-id"];
  if (typeof incomingRequestId === "string" && incomingRequestId.trim() !== "") {
    upstreamHeaders["x-request-id"] = incomingRequestId.trim();
  }

  return fetch(upstreamUrl, {
    method: "GET",
    headers: upstreamHeaders
  });
}

function emitUsageLog(event: CreditUsageEvent): void {
  console.log(JSON.stringify({ type: "billing_usage", ...event }));
}

function requestIdFrom(req: IncomingMessage): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.trim() !== "") return incoming.trim();
  return crypto.randomUUID();
}

function isInternalServiceAuthorized(req: IncomingMessage): boolean {
  const token = billingConfig.internalServiceToken;
  if (!token) return false;
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  return auth.slice(7).trim() === token;
}

async function provisionPaidUserFromStripe(userId: string, requestId: string): Promise<void> {
  const serviceToken = billingConfig.internalServiceToken;
  if (!serviceToken) {
    throw new Error("missing_internal_service_token");
  }
  const provisionUrl = new URL("/api/internal/provision/paid-user", config.quotientApiBaseUrl);
  const response = await fetch(provisionUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${serviceToken}`,
      "x-request-id": requestId
    },
    body: JSON.stringify({
      userId,
      source: "stripe_webhook"
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`provisioning_failed:${response.status}:${body}`);
  }
}

async function handleCheckoutSessionCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed", message: "Use POST." });
    return;
  }
  if (!isInternalServiceAuthorized(req)) {
    json(res, 401, { error: "unauthorized", message: "Missing or invalid internal service token." });
    return;
  }
  if (!stripeBilling.canCreateCheckoutSessions()) {
    json(res, 503, { error: "stripe_checkout_not_configured", message: "Stripe checkout is not configured." });
    return;
  }

  let body: { userId?: string; privyId?: string; units?: number; email?: string | null };
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 422, { error: "invalid_request", message: "Invalid JSON body." });
    return;
  }

  const userId = body.userId?.trim();
  const privyId = body.privyId?.trim();
  const units = Number.isFinite(body.units) ? Math.floor(Number(body.units)) : NaN;
  if (!userId || !privyId || !Number.isInteger(units) || units < MIN_PURCHASE_UNITS) {
    json(res, 422, {
      error: "invalid_request",
      message: `userId, privyId, and integer units >= ${MIN_PURCHASE_UNITS} are required.`
    });
    return;
  }

  try {
    const session = await stripeBilling.createCheckoutSession({
      userId,
      privyId,
      units,
      email: typeof body.email === "string" ? body.email : null
    });
    json(res, 200, {
      checkoutUrl: session.url,
      sessionId: session.id
    });
  } catch (error: unknown) {
    json(res, 500, {
      error: "checkout_session_create_failed",
      message: error instanceof Error ? error.message : "Failed to create Stripe checkout session."
    });
  }
}

async function handlePlansList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }
  if (!isInternalServiceAuthorized(req)) {
    json(res, 401, { error: "unauthorized", message: "Missing or invalid internal service token." });
    return;
  }
  try {
    const packs = await stripeBilling.listSelectablePacks();
    json(res, 200, { packs });
  } catch (error: unknown) {
    console.log(error);
    json(res, 500, {
      error: "packs_list_failed",
      message: error instanceof Error ? error.message : "Failed to list available packs."
    });
  }
}

function handlePublicPricing(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }

  const pricing = MONETIZED_ROUTE_POLICIES.flatMap((policy) =>
    policy.x402RoutePatterns.map((routePattern) => ({
      policyId: policy.id,
      routePattern,
      creditCost: policy.creditCost,
      x402AmountUsd: policy.x402Amount
    }))
  );

  json(res, 200, {
    source: "gateway_monetized_route_policies",
    pricing
  });
}

async function handleCheckoutSessionLookup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }
  if (!isInternalServiceAuthorized(req)) {
    json(res, 401, { error: "unauthorized", message: "Missing or invalid internal service token." });
    return;
  }
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const sessionId = reqUrl.searchParams.get("sessionId");
  if (!sessionId) {
    json(res, 422, { error: "invalid_request", message: "sessionId is required." });
    return;
  }
  try {
    const session = await stripeBilling.getCheckoutSession(sessionId);
    json(res, 200, session);
  } catch (error: unknown) {
    json(res, 500, {
      error: "checkout_session_lookup_failed",
      message: error instanceof Error ? error.message : "Failed to fetch checkout session."
    });
  }
}

async function handleAutoRechargeGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }
  if (!isInternalServiceAuthorized(req)) {
    json(res, 401, { error: "unauthorized", message: "Missing or invalid internal service token." });
    return;
  }
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const userId = reqUrl.searchParams.get("userId")?.trim();
  if (!userId) {
    json(res, 422, { error: "invalid_request", message: "userId is required." });
    return;
  }
  const account = await billingStore.getAccount(userId);
  if (!account) {
    json(res, 404, { error: "not_found", message: "Billing account not found." });
    return;
  }
  const settings = await billingStore.getAutoRechargeSettings(userId);
  json(res, 200, {
    enabled: settings.enabled,
    thresholdCredits: settings.thresholdCredits,
    units: settings.units ?? null
  });
}

async function handleAutoRechargeSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed", message: "Use POST." });
    return;
  }
  if (!isInternalServiceAuthorized(req)) {
    json(res, 401, { error: "unauthorized", message: "Missing or invalid internal service token." });
    return;
  }
  let body: { userId?: string; enabled?: boolean; thresholdCredits?: number; units?: number | null };
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 422, { error: "invalid_request", message: "Invalid JSON body." });
    return;
  }
  const userId = body.userId?.trim();
  if (!userId) {
    json(res, 422, { error: "invalid_request", message: "userId is required." });
    return;
  }
  const account = await billingStore.getAccount(userId);
  if (!account) {
    json(res, 404, { error: "not_found", message: "Billing account not found." });
    return;
  }
  const enabled = body.enabled === true;
  const thresholdCredits = Number.isFinite(body.thresholdCredits) ? Math.max(0, Math.floor(body.thresholdCredits || 0)) : 0;
  const units = Number.isFinite(body.units) ? Math.floor(Number(body.units)) : undefined;
  if (enabled && (!Number.isInteger(units) || (units ?? 0) < MIN_PURCHASE_UNITS)) {
    json(res, 422, {
      error: "invalid_request",
      message: `units is required and must be an integer >= ${MIN_PURCHASE_UNITS} when auto-recharge is enabled.`
    });
    return;
  }
  let stripeCustomerId = account.stripeCustomerId;
  if (enabled && !stripeCustomerId) {
    try {
      const discoveredCustomerId = await stripeBilling.findCustomerIdForUser(userId);
      if (discoveredCustomerId) {
        const updated = await billingStore.setStripeCustomerId(userId, discoveredCustomerId);
        stripeCustomerId = updated.stripeCustomerId;
      }
    } catch {
      // Preserve existing behavior if Stripe lookup fails.
    }
  }
  if (enabled && !stripeCustomerId) {
    json(res, 422, { error: "missing_payment_method", message: "User must complete at least one checkout before enabling auto-recharge." });
    return;
  }
  try {
    const settings = typeof units === "number"
      ? { enabled, thresholdCredits, units }
      : { enabled, thresholdCredits };
    const updated = await billingStore.setAutoRechargeSettings(userId, settings);
    json(res, 200, {
      ok: true,
      customerId: updated.customerId,
      enabled: updated.autoRechargeEnabled,
      thresholdCredits: updated.autoRechargeThreshold,
      units: updated.autoRechargeUnits ?? null
    });
  } catch (error: unknown) {
    json(res, 500, {
      error: "auto_recharge_update_failed",
      message: error instanceof Error ? error.message : "Failed to update auto-recharge settings."
    });
  }
}

async function maybeTriggerAutoRecharge(customerId: string, requestId: string): Promise<void> {
  const account = await billingStore.getAccount(customerId);
  if (!account || !account.autoRechargeEnabled) return;
  if (!account.stripeCustomerId || !account.autoRechargeUnits || account.autoRechargeUnits < MIN_PURCHASE_UNITS) return;
  if (account.creditsRemaining >= account.autoRechargeThreshold) return;
  const charge = await stripeBilling.createAutoRechargeCharge({
    customerId,
    stripeCustomerId: account.stripeCustomerId,
    units: account.autoRechargeUnits
  });
  console.log(
    JSON.stringify({
      type: "auto_recharge_intent_created",
      timestamp: new Date().toISOString(),
      requestId,
      customerId,
      stripePaymentIntentId: charge.paymentIntentId,
      status: charge.status,
      packId: charge.packId,
      credits: charge.credits
    })
  );
}

async function canUseCredits(
  apiKey: string,
  pathname: string,
  routeCreditCost: number,
  requestId: string
): Promise<{ allowed: boolean; invalidKey?: boolean; customerId: string; remaining: number }> {
  const resolved = await billingStore.resolveCustomerFromApiKey(apiKey);
  if (!resolved) {
    return { allowed: false, invalidKey: true, customerId: "invalid_api_key", remaining: 0 };
  }
  const { customerId, apiKeyHash } = resolved;
  const account = await billingStore.getOrCreateAccount(customerId, apiKeyHash);
  const consumed = await billingStore.recordUsageDebit({
    customerId,
    route: pathname,
    cost: routeCreditCost,
    requestId
  });

  let attemptedRecharge = false;
  if (consumed.ok) {
    const threshold = account.autoRechargeThreshold;
    const previousRemaining = consumed.remaining + routeCreditCost;
    const crossedBelowThreshold =
      account.autoRechargeEnabled &&
      previousRemaining >= threshold &&
      consumed.remaining < threshold;


    if (crossedBelowThreshold) {
      attemptedRecharge = true;
      try {
        await maybeTriggerAutoRecharge(customerId, requestId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          JSON.stringify({
            type: "auto_recharge_failure",
            timestamp: new Date().toISOString(),
            requestId,
            customerId,
            route: pathname,
            trigger: "threshold_crossed",
            threshold,
            previousRemaining,
            remainingAfterDebit: consumed.remaining,
            error: message
          })
        );
        // Auto-recharge failure should not break request handling.
      }
    }
  } else {
    attemptedRecharge = true;
    try {
      await maybeTriggerAutoRecharge(customerId, requestId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        JSON.stringify({
          type: "auto_recharge_failure",
          timestamp: new Date().toISOString(),
          requestId,
          customerId,
          route: pathname,
          trigger: "insufficient_credits",
          requiredCredits: routeCreditCost,
          remainingBeforeRechargeAttempt: consumed.remaining,
          error: message
        })
      );
      // Auto-recharge failure should not break request handling.
    }
  }

  const refreshedRemaining =
    consumed.ok && !attemptedRecharge
      ? consumed.remaining
      : await billingStore.getCreditsRemaining(customerId);
  emitUsageLog({
    timestamp: new Date().toISOString(),
    requestId,
    customerId,
    route: pathname,
    creditsCharged: consumed.ok ? routeCreditCost : 0,
    creditsRemaining: refreshedRemaining,
    decision: consumed.ok ? "credits_allowed" : "credits_insufficient",
    source: "credits"
  });
  return { allowed: consumed.ok, customerId, remaining: refreshedRemaining };
}

function respondWithX402Instructions(
  res: ServerResponse,
  status: number,
  response: { body?: unknown; headers: Record<string, string> },
  requestId: string
): void {
  json(
    res,
    status,
    response.body || { error: "payment_required", message: "Payment is required for this route." },
    {
      ...response.headers,
      "x-request-id": requestId
    }
  );
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
  let event;
  try {
    event = stripeBilling.parseWebhookEvent(body, typeof signature === "string" ? signature : undefined);
  } catch (error: unknown) {
    json(res, 400, {
      error: "invalid_webhook",
      message: error instanceof Error ? error.message : "Failed to process webhook."
    });
    return;
  }

  const grant = stripeBilling.toCreditGrantFromEvent(event);
  if (!grant) {
    json(res, 200, { ok: true, ignored: true, eventType: event.type });
    return;
  }

  try {
    const alreadyProcessed = await billingStore.hasProcessedStripeEvent(grant.stripeEventId);
    if (alreadyProcessed) {
      json(res, 200, { ok: true, duplicate: true, eventType: event.type });
      return;
    }
    await provisionPaidUserFromStripe(grant.userId, requestIdFrom(req));
    await billingStore.getOrCreateAccount(grant.userId, grant.apiKeyHash);
    const grantInput = {
      customerId: grant.userId,
      amount: grant.credits,
      source: grant.source,
      stripeEventId: grant.stripeEventId,
      ...(grant.stripeCustomerId ? { stripeCustomerId: grant.stripeCustomerId } : {}),
      ...(grant.stripePaymentIntentId ? { stripePaymentIntentId: grant.stripePaymentIntentId } : {}),
      ...(grant.stripeCheckoutSessionId ? { stripeCheckoutSessionId: grant.stripeCheckoutSessionId } : {})
    } as const;
    const account = await billingStore.grantCredits(grantInput);
    await billingStore.markStripeEventProcessed(grant.stripeEventId, grant.userId);
    json(res, 200, {
      ok: true,
      eventType: event.type,
      customerId: account.customerId,
      creditsRemaining: account.creditsRemaining,
      credited: grant.credits
    });
  } catch (error: unknown) {
    json(res, 500, {
      error: "stripe_state_update_failed",
      message: error instanceof Error ? error.message : "Failed to apply Stripe state update."
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
    const autoRecharge = await billingStore.getAutoRechargeSettings(resolved.customerId);
    json(res, 200, {
      customerId: account.customerId,
      creditsRemaining: account.creditsRemaining,
      autoRecharge: {
        enabled: autoRecharge.enabled,
        thresholdCredits: autoRecharge.thresholdCredits,
        units: autoRecharge.units ?? null
      }
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
  const startedAtMs = Date.now();
  const requestId = requestIdFrom(req);
  const method = req.method || "UNKNOWN";
  const rawUrl = req.url || "/";
  const pathname = (() => {
    try {
      return new URL(rawUrl, "http://localhost").pathname;
    } catch {
      return rawUrl;
    }
  })();

  res.on("finish", () => {
    const forwardedFor = req.headers["x-forwarded-for"];
    const clientIp =
      typeof forwardedFor === "string"
        ? forwardedFor.split(",")[0]?.trim()
        : req.socket.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"];
    console.log(
      JSON.stringify({
        type: "gateway_request",
        timestamp: new Date().toISOString(),
        requestId,
        method,
        pathname,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAtMs,
        clientIp,
        userAgent: typeof userAgent === "string" ? userAgent : undefined
      })
    );
  });

  if (!res.hasHeader("x-request-id")) {
    res.setHeader("x-request-id", requestId);
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");

  try {
    if (!req.url) {
      json(res, 400, { error: "invalid_request", message: "Missing URL." });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
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

    if (pathname === "/api/internal/billing/checkout-session") {
      await handleCheckoutSessionCreate(req, res);
      return;
    }

    if (pathname === "/api/internal/billing/checkout-session/status") {
      await handleCheckoutSessionLookup(req, res);
      return;
    }

    if (pathname === "/api/internal/billing/plans") {
      await handlePlansList(req, res);
      return;
    }

    if (pathname === "/api/public/pricing") {
      handlePublicPricing(req, res);
      return;
    }

    if (pathname === "/api/internal/billing/auto-recharge") {
      if (req.method === "GET") {
        await handleAutoRechargeGet(req, res);
        return;
      }
      if (req.method === "POST") {
        await handleAutoRechargeSet(req, res);
        return;
      }
      json(res, 405, { error: "method_not_allowed", message: "Use GET or POST." });
      return;
    }

    if (pathname === "/api/billing/summary") {
      await handleBillingSummary(req, res);
      return;
    }

    if (pathname.startsWith("/api/v1/") && req.method === "GET") {
      const policy = resolveMonetizedRoutePolicy(pathname);
      if (!policy) {
        json(res, 422, {
          error: "unpriced_route",
          message: `No monetization policy defined for route '${pathname}'.`
        });
        return;
      }
      const requestId = requestIdFrom(req);
      const clientKey = req.headers["x-quotient-api-key"];
      const hasClientKey = typeof clientKey === "string" && clientKey.trim() !== "";

      if (hasClientKey) {
        let billing;
        try {
          billing = await canUseCredits(clientKey.trim(), pathname, policy.creditCost, requestId);
        } catch (error: unknown) {
          json(res, 500, {
            error: "billing_identity_mapping_error",
            message: error instanceof Error ? error.message : "Failed to resolve billing identity."
          }, {
            "x-request-id": requestId
          });
          return;
        }
        if (billing.invalidKey) {
          json(res, 401, {
            error: "invalid_api_key",
            message: "Provided API key is invalid."
          }, {
            "x-request-id": requestId
          });
          return;
        }
        if (!billing.allowed) {
          json(res, 403, {
            error: "insufficient_credits",
            message: "Insufficient credits for this route.",
            billing: {
              required_credits: policy.creditCost,
              credits_remaining: billing.remaining
            }
          }, {
            "x-request-id": requestId
          });
          return;
        }

        const upstreamRes = await proxyToQuotient(req);
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

      const paymentAuth = await x402Gateway.requirePayment(req, pathname);
      if (paymentAuth.kind === "deny") {
        respondWithX402Instructions(res, paymentAuth.response.status, paymentAuth.response, requestId);
        return;
      }
      const upstreamRes = await proxyToQuotient(req);
      const text = await upstreamRes.text();
      const settlementHeaders = await x402Gateway.finalizeSettlement(paymentAuth, text, upstreamRes.status);
      emitUsageLog({
        timestamp: new Date().toISOString(),
        requestId,
        customerId: "x402_fallback_unknown",
        route: pathname,
        creditsCharged: policy.creditCost,
        decision: "x402_fallback_paid",
        source: "x402_fallback"
      });
      res.writeHead(upstreamRes.status, {
        "content-type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8",
        "x-request-id": requestId,
        ...settlementHeaders
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

await x402Gateway.initialize();

server.listen(config.port, () => {
  console.log(`quotient-api-gateway listening on http://localhost:${config.port}`);
});
