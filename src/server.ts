// src/server.ts
import "dotenv/config";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { Neo4jBillingStore } from "./billing/store.js";
import { StripeBillingService } from "./billing/stripe.js";
import { loadBillingConfig } from "./billing/config.js";
import {
  buildCanonicalContractFromOpenApi,
  hashCanonicalOpenApi,
  loadCanonicalContract,
  resolveMonetizedRoutePolicy,
  type CanonicalContract
} from "./billing/contract.js";
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
const canonicalOpenApiUrl =
  process.env.QUOTIENT_CANONICAL_OPENAPI_URL ||
  new URL("/api/v1/openapi.json", config.quotientApiBaseUrl).toString();
const contractRefreshIntervalMs = Number(process.env.QUOTIENT_CONTRACT_REFRESH_INTERVAL_MS || 60000);
let activeCanonicalContract: CanonicalContract = await loadCanonicalContract({
  sourceUrl: canonicalOpenApiUrl
});
let activeMonetizedRoutePolicies = activeCanonicalContract.policies;
let activeCanonicalHash = hashCanonicalOpenApi(activeCanonicalContract.openApi);
const billingStore: BillingStoreLike = new Neo4jBillingStore(billingConfig);
const stripeBilling = new StripeBillingService(billingConfig);
let x402Gateway = new X402PaymentGateway(billingConfig, activeMonetizedRoutePolicies);
await x402Gateway.initialize();
let contractRefreshInFlight: Promise<void> | null = null;
const SIGNUP_FREE_CREDITS = 50000;
const MIN_PURCHASE_UNITS = 100;
const ADMIN_SECRET = "password";
const ADMIN_DEFAULT_CREDITS = 1000000; // $1,000 at 1,000 credits per USD
const ADMIN_DEFAULT_TERM_DAYS = 30;
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

async function proxyPublicDocument(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath: string
): Promise<void> {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }
  const upstreamUrl = new URL(targetPath, config.quotientApiBaseUrl);
  const upstreamRes = await fetch(upstreamUrl, {
    method: "GET",
    headers: {
      "x-request-id": requestIdFrom(req)
    }
  });
  const body = await upstreamRes.text();
  res.writeHead(upstreamRes.status, {
    "content-type": upstreamRes.headers.get("content-type") || "text/plain; charset=utf-8",
    "cache-control": upstreamRes.headers.get("cache-control") || "public, max-age=300"
  });
  res.end(body);
}

async function proxyToQuotient(req: IncomingMessage, body?: Buffer): Promise<Response> {
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const upstreamUrl = new URL(reqUrl.pathname + reqUrl.search, config.quotientApiBaseUrl);
  const method = req.method || "GET";
  const upstreamHeaders: Record<string, string> = {
    "content-type": "application/json",
    "x-quotient-gateway-secret": config.gatewaySharedSecret
  };
  const incomingRequestId = req.headers["x-request-id"];
  if (typeof incomingRequestId === "string" && incomingRequestId.trim() !== "") {
    upstreamHeaders["x-request-id"] = incomingRequestId.trim();
  }

  const fetchOptions: RequestInit = {
    method,
    headers: upstreamHeaders,
  };

  // Forward body for POST/PUT/PATCH
  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    fetchOptions.body = body.toString("utf-8");
  }

  return fetch(upstreamUrl, fetchOptions);
}

async function applyCanonicalOpenApi(
  openApi: Record<string, unknown>,
  source: "network",
  sourceLabel: string
): Promise<{ updated: boolean; hash: string; policyCount: number }> {
  const nextContract = buildCanonicalContractFromOpenApi(openApi, sourceLabel, source);
  const nextHash = hashCanonicalOpenApi(nextContract.openApi);
  if (nextHash === activeCanonicalHash) {
    return { updated: false, hash: nextHash, policyCount: nextContract.policies.length };
  }

  const nextGateway = new X402PaymentGateway(billingConfig, nextContract.policies);
  await nextGateway.initialize();

  activeCanonicalContract = nextContract;
  activeMonetizedRoutePolicies = nextContract.policies;
  activeCanonicalHash = nextHash;
  x402Gateway = nextGateway;

  console.log(
    JSON.stringify({
      type: "canonical_contract_applied",
      timestamp: new Date().toISOString(),
      source,
      sourceLabel,
      policyCount: nextContract.policies.length,
      hash: nextHash
    })
  );

  return { updated: true, hash: nextHash, policyCount: nextContract.policies.length };
}

async function refreshCanonicalContractFromSource(trigger: string): Promise<void> {
  if (contractRefreshInFlight) {
    await contractRefreshInFlight;
    return;
  }
  contractRefreshInFlight = (async () => {
    try {
      const loaded = await loadCanonicalContract({
        sourceUrl: canonicalOpenApiUrl
      });
      await applyCanonicalOpenApi(loaded.openApi, loaded.loadedFrom, canonicalOpenApiUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          type: "canonical_contract_refresh_failed",
          timestamp: new Date().toISOString(),
          trigger,
          sourceUrl: canonicalOpenApiUrl,
          error: message
        })
      );
    }
  })();
  try {
    await contractRefreshInFlight;
  } finally {
    contractRefreshInFlight = null;
  }
}

async function handleCanonicalContractSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed", message: "Use POST." });
    return;
  }
  if (!isInternalServiceAuthorized(req)) {
    json(res, 401, { error: "unauthorized", message: "Missing or invalid internal service token." });
    return;
  }
  let body: { openApi?: unknown; sourceUrl?: string };
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 422, { error: "invalid_request", message: "Invalid JSON body." });
    return;
  }
  if (!body || typeof body !== "object" || !body.openApi || typeof body.openApi !== "object") {
    json(res, 422, { error: "invalid_request", message: "openApi object is required." });
    return;
  }

  try {
    const sourceLabel = typeof body.sourceUrl === "string" && body.sourceUrl.trim() !== ""
      ? body.sourceUrl.trim()
      : "internal_contract_sync";
    const result = await applyCanonicalOpenApi(body.openApi as Record<string, unknown>, "network", sourceLabel);
    json(res, 200, {
      ok: true,
      updated: result.updated,
      hash: result.hash,
      policyCount: result.policyCount
    });
  } catch (error: unknown) {
    json(res, 422, {
      error: "invalid_contract",
      message: error instanceof Error ? error.message : "Failed to apply canonical contract."
    });
  }
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

function isAdminAuthorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  return auth.slice(7).trim() === ADMIN_SECRET;
}

async function handleAdminProvisionKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed", message: "Use POST." });
    return;
  }
  if (!isAdminAuthorized(req)) {
    json(res, 401, { error: "unauthorized", message: "Invalid admin secret." });
    return;
  }

  let body: { email?: string; termDays?: number; credits?: number };
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 422, { error: "invalid_request", message: "Invalid JSON body." });
    return;
  }

  const email = typeof body.email === "string" ? body.email.trim() : null;
  if (!email) {
    json(res, 422, { error: "invalid_request", message: "email is required." });
    return;
  }

  const termDays = Number.isFinite(body.termDays) ? Math.floor(body.termDays!) : ADMIN_DEFAULT_TERM_DAYS;
  const credits = Number.isFinite(body.credits) ? Math.floor(body.credits!) : ADMIN_DEFAULT_CREDITS;

  const userId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + termDays * 24 * 60 * 60 * 1000).toISOString();

  const serviceToken = billingConfig.internalServiceToken;
  if (!serviceToken) {
    json(res, 503, { error: "service_unavailable", message: "Internal service token not configured." });
    return;
  }

  const requestId = requestIdFrom(req);

  let apiKey: string;
  try {
    const provisionUrl = new URL("/api/internal/provision/paid-user", config.quotientApiBaseUrl);
    const provisionRes = await fetch(provisionUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serviceToken}`,
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        userId,
        email,
        source: "admin_provision",
        expiresAt,
      }),
    });
    if (!provisionRes.ok) {
      const text = await provisionRes.text();
      json(res, 500, { error: "provision_failed", message: `User provisioning failed: ${text}` });
      return;
    }
    const provisionData = await provisionRes.json() as { apiKey: string };
    apiKey = provisionData.apiKey;
  } catch (error: unknown) {
    json(res, 500, {
      error: "provision_failed",
      message: error instanceof Error ? error.message : "Failed to provision user."
    });
    return;
  }

  try {
    const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
    await billingStore.getOrCreateAccount(userId, apiKeyHash);
    await billingStore.grantCredits({
      customerId: userId,
      amount: credits,
      source: "manual_purchase",
    });
  } catch (error: unknown) {
    json(res, 500, {
      error: "billing_setup_failed",
      message: error instanceof Error ? error.message : "Failed to set up billing."
    });
    return;
  }

  json(res, 200, {
    ok: true,
    apiKey,
    userId,
    email,
    credits,
    expiresAt,
    termDays,
  });
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

async function handleSignupBonusGrant(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed", message: "Use POST." });
    return;
  }
  if (!isInternalServiceAuthorized(req)) {
    json(res, 401, { error: "unauthorized", message: "Missing or invalid internal service token." });
    return;
  }

  let body: { userId?: string; apiKey?: string };
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 422, { error: "invalid_request", message: "Invalid JSON body." });
    return;
  }

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!userId || !apiKey) {
    json(res, 422, { error: "invalid_request", message: "userId and apiKey are required." });
    return;
  }

  try {
    const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const result = await billingStore.grantSignupCreditsOnce({
      customerId: userId,
      apiKeyHash,
      amount: SIGNUP_FREE_CREDITS,
      requestId: requestIdFrom(req)
    });
    json(res, 200, {
      ok: true,
      granted: result.granted,
      creditsRemaining: result.account.creditsRemaining
    });
  } catch (error: unknown) {
    json(res, 500, {
      error: "signup_bonus_grant_failed",
      message: error instanceof Error ? error.message : "Failed to grant signup bonus."
    });
  }
}

function handlePublicPricing(req: IncomingMessage, res: ServerResponse): void {
  // Sync contract: pricing is derived from the canonical OpenAPI contract loaded
  // from quotient-api and refreshed in-memory at runtime (pull + internal sync).
  // This powers gateway enforcement and x402 discovery metadata together.
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }

  const x402PaymentAssets = billingConfig.x402.enabledNetworks.map((network) => ({
    network,
    token: "USDC"
  }));

  const pricing = activeMonetizedRoutePolicies.flatMap((policy) =>
    policy.x402RoutePatterns.map((routePattern) => ({
      policyId: policy.id,
      routePattern,
      creditCost: policy.creditCost,
      x402AmountUsd: policy.x402Amount
    }))
  );

  json(res, 200, {
    source: "gateway_monetized_route_policies",
    x402PaymentAssets,
    pricing
  });
}

function handleWellKnownX402(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }
  const resources = Array.from(
    new Set(
      activeMonetizedRoutePolicies.flatMap((policy) => policy.x402RoutePatterns)
    )
  );
  json(
    res,
    200,
    {
      version: 1,
      resources,
    },
    {
      "cache-control": "public, max-age=300",
    }
  );
}

function handleOpenApiDiscovery(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }
  json(res, 200, activeCanonicalContract.openApi, {
    "cache-control": "public, max-age=300",
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

// Allowed HTTP methods for monetized /api/v1/* routes
const MONETIZED_METHODS = new Set(["GET", "POST"]);

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

    if (pathname === "/openapi.json" || pathname === "/api/v1/openapi.json") {
      handleOpenApiDiscovery(req, res);
      return;
    }

    if (pathname === "/llms.txt" || pathname === "/skill/skill.md" || pathname.startsWith("/skill/references/")) {
      await proxyPublicDocument(req, res, pathname);
      return;
    }

    if (pathname === "/.well-known/x402") {
      handleWellKnownX402(req, res);
      return;
    }

    if (pathname === "/api/admin/provision-key") {
      await handleAdminProvisionKey(req, res);
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

    if (pathname === "/api/internal/discovery/contract-sync") {
      await handleCanonicalContractSync(req, res);
      return;
    }

    if (pathname === "/api/internal/billing/signup-bonus") {
      await handleSignupBonusGrant(req, res);
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

    if (pathname.startsWith("/api/v1/") && MONETIZED_METHODS.has(method)) {
      const policy = resolveMonetizedRoutePolicy(pathname, method, activeMonetizedRoutePolicies);
      if (!policy) {
        const matchingPolicies = activeMonetizedRoutePolicies.filter((candidate) =>
          candidate.matcher.test(pathname)
        );
        if (matchingPolicies.length > 0) {
          const allowedMethods = Array.from(new Set(matchingPolicies.map((candidate) => candidate.method)));
          json(res, 405, {
            error: "method_not_allowed",
            message: `Route '${pathname}' does not support method '${method}'.`,
            allowed_methods: allowedMethods
          });
          return;
        }
        // Route is outside monetized policy scope: proxy upstream without gateway billing/x402 enforcement.
        const requestId = requestIdFrom(req);
        const reqBody =
          method === "POST" || method === "PUT" || method === "PATCH"
            ? await readRawBody(req)
            : undefined;
        const upstreamRes = await proxyToQuotient(req, reqBody);
        const text = await upstreamRes.text();
        res.writeHead(upstreamRes.status, {
          "content-type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8",
          "x-request-id": requestId
        });
        res.end(text);
        return;
      }
      const requestId = requestIdFrom(req);

      // Read body upfront for POST requests so we can forward it
      let reqBody: Buffer | undefined;
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        reqBody = await readRawBody(req);
      }

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

        const upstreamRes = await proxyToQuotient(req, reqBody);
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
      const upstreamRes = await proxyToQuotient(req, reqBody);
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

if (Number.isFinite(contractRefreshIntervalMs) && contractRefreshIntervalMs > 0) {
  const timer = setInterval(() => {
    void refreshCanonicalContractFromSource("interval");
  }, contractRefreshIntervalMs);
  timer.unref?.();
}

server.listen(config.port, () => {
  console.log(`quotient-api-gateway listening on http://localhost:${config.port}`);
});
