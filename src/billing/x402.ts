import type { IncomingMessage } from "node:http";
import {
  decodePaymentSignatureHeader,
  type HTTPAdapter,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type ProcessSettleResultResponse,
  type RouteConfig,
  type RoutesConfig,
  x402HTTPResourceServer
} from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declarePaymentIdentifierExtension, extractPaymentIdentifier } from "@x402/extensions/payment-identifier";
import type { BillingConfig, MonetizedRoutePolicy } from "./config.js";
import { MONETIZED_ROUTE_POLICIES } from "./config.js";

function moneyString(amountUsd: number): string {
  const value = amountUsd.toFixed(6).replace(/\.?0+$/, "");
  return `$${value}`;
}

function toRouteDescription(policy: MonetizedRoutePolicy): string {
  const descriptions: Record<MonetizedRoutePolicy["id"], string> = {
    markets: "List tracked prediction markets with coverage metadata.",
    mispriced: "Find markets where Quotient probability diverges from market odds.",
    intelligence: "Get full Quotient intelligence and drivers for a market slug.",
    signals: "Get paginated analyst signals for a market slug.",
    forecast: "Generate a Quotient forecast (disabled unless policy is enabled)."
  };
  return descriptions[policy.id] ?? `Quotient API access for ${policy.id}`;
}

function toFallbackChallenge(policy: MonetizedRoutePolicy): Record<string, unknown> {
  return {
    error: "payment_required",
    message: "Pay this request with x402 before retrying.",
    route: {
      route_id: policy.id,
      required_credits: policy.creditCost
    }
  };
}

function paymentHeaderFrom(req: IncomingMessage): string | null {
  const v2 = req.headers["payment-signature"];
  if (typeof v2 === "string" && v2.trim() !== "") return v2.trim();
  const v1 = req.headers["x-payment"];
  if (typeof v1 === "string" && v1.trim() !== "") return v1.trim();
  return null;
}

class NodeHttpAdapter implements HTTPAdapter {
  constructor(
    private readonly req: IncomingMessage,
    private readonly pathname: string
  ) {}

  getHeader(name: string): string | undefined {
    const value = this.req.headers[name.toLowerCase()];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value[0]) return value[0];
    return undefined;
  }

  getMethod(): string {
    return this.req.method || "GET";
  }

  getPath(): string {
    return this.pathname;
  }

  getUrl(): string {
    return this.req.url || this.pathname;
  }

  getAcceptHeader(): string {
    return this.getHeader("accept") || "application/json";
  }

  getUserAgent(): string {
    return this.getHeader("user-agent") || "";
  }
}

class PaymentIdCache {
  private readonly records = new Map<string, { expiresAt: number; headers: Record<string, string> }>();

  constructor(private readonly ttlSeconds: number) {}

  get(id: string): Record<string, string> | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.records.delete(id);
      return null;
    }
    return record.headers;
  }

  set(id: string, headers: Record<string, string>): void {
    this.pruneExpired();
    this.records.set(id, {
      expiresAt: Date.now() + this.ttlSeconds * 1000,
      headers
    });
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.records.entries()) {
      if (record.expiresAt < now) this.records.delete(id);
    }
  }
}

type RequirePaymentResult =
  | { kind: "deny"; response: HTTPResponseInstructions }
  | {
      kind: "authorized";
      requestContext: HTTPRequestContext;
      settlementContext?: {
        paymentPayload: Parameters<x402HTTPResourceServer["processSettlement"]>[0];
        paymentRequirements: Parameters<x402HTTPResourceServer["processSettlement"]>[1];
        declaredExtensions?: Parameters<x402HTTPResourceServer["processSettlement"]>[2];
      };
      paymentId: string | null;
      cachedHeaders: Record<string, string> | null;
    };

function toBazaarInputSchema(routePattern: string, policy: MonetizedRoutePolicy): Record<string, unknown> {
  if (routePattern === "GET /api/v1/markets/lookup") {
    return {
      queryParams: {
        slugs: {
          type: "string",
          description: "Comma-separated market slugs (1-10). Mutually exclusive with condition_ids."
        },
        condition_ids: {
          type: "string",
          description: "Comma-separated market condition IDs (1-10). Mutually exclusive with slugs."
        }
      }
    };
  }

  switch (policy.id) {
    case "markets":
      return {
        queryParams: {
          topic: {
            type: "string",
            description: "Optional topic/category filter."
          },
          max_forecast_age: {
            type: "integer",
            description: "Max forecast age in hours.",
            minimum: 1
          },
          sort: {
            type: "string",
            enum: ["updated_desc", "volume_desc", "signal_count_desc"],
            description: "Sort order for market list."
          },
          cursor: {
            type: "string",
            description: "Opaque pagination cursor."
          },
          limit: {
            type: "integer",
            description: "Page size (1-50).",
            minimum: 1,
            maximum: 50
          }
        }
      };
    case "mispriced":
      return {
        queryParams: {
          min_spread: {
            type: "number",
            description: "Minimum absolute spread between Quotient and market odds (0-1).",
            minimum: 0,
            maximum: 1
          },
          max_forecast_age: {
            type: "integer",
            description: "Max forecast age in hours.",
            minimum: 1
          },
          sort: {
            type: "string",
            enum: ["spread_desc", "spread_asc", "updated_desc", "volume_desc"],
            description: "Sort order for mispriced list."
          },
          cursor: {
            type: "string",
            description: "Opaque pagination cursor."
          },
          limit: {
            type: "integer",
            description: "Page size (1-50).",
            minimum: 1,
            maximum: 50
          }
        }
      };
    case "intelligence":
      return {
        pathParams: {
          slug: {
            type: "string",
            description: "Market slug identifier."
          }
        }
      };
    case "signals":
      return {
        pathParams: {
          slug: {
            type: "string",
            description: "Market slug identifier."
          }
        },
        queryParams: {
          cursor: {
            type: "string",
            description: "Opaque pagination cursor."
          },
          limit: {
            type: "integer",
            description: "Page size (1-50).",
            minimum: 1,
            maximum: 50
          }
        }
      };
    case "forecast":
      return {
        body: {
          type: "object",
          description: "Forecast request payload."
        }
      };
  }
}

function toBazaarOutputSchema(policy: MonetizedRoutePolicy): Record<string, unknown> {
  const descriptionByPolicy: Record<MonetizedRoutePolicy["id"], string> = {
    markets: "Paginated market list with coverage metadata.",
    mispriced: "Paginated list of markets with forecast vs odds spread.",
    intelligence: "Single market intelligence object with forecast and drivers.",
    signals: "Paginated market signal list with sentiment summary.",
    forecast: "Forecast generation result."
  };
  return {
    type: "object",
    description: descriptionByPolicy[policy.id],
    additionalProperties: true
  };
}

function buildRoutes(config: BillingConfig): RoutesConfig {
  // Sync contract: this route declaration is what facilitators discover.
  // Keep it aligned with:
  // - src/billing/config.ts MONETIZED_ROUTE_POLICIES (route set + pricing),
  // - src/server.ts handlePublicPricing (public pricing payload),
  // - quotient-api/src/app/api/v1/openapi.json/route.ts (public contract),
  // - quotient-api/src/app/llms.txt/route.ts and quotient-api/public/skill/skill.md (agent docs).
  const routes: Record<string, RouteConfig> = {};
  const acceptsForPolicy = (policy: MonetizedRoutePolicy) =>
    config.x402.enabledNetworks.map((network) => {
      const payTo = config.x402.payToByNetwork[network];
      if (!payTo) {
        throw new Error(`Missing x402 payTo for enabled network '${network}'.`);
      }
      return {
        scheme: "exact",
        network: network as `${string}:${string}`,
        payTo,
        price: moneyString(policy.x402Amount)
      };
    });

  for (const policy of MONETIZED_ROUTE_POLICIES) {
    for (const routePattern of policy.x402RoutePatterns) {
      routes[routePattern] = {
        accepts: acceptsForPolicy(policy),
        description: toRouteDescription(policy),
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: toBazaarInputSchema(routePattern, policy),
            outputSchema: toBazaarOutputSchema(policy)
          },
          "payment-identifier": declarePaymentIdentifierExtension(config.x402.paymentIdRequired)
        },
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: toFallbackChallenge(policy)
        })
      };
    }
  }

  return routes;
}

export class X402PaymentGateway {
  private readonly cache: PaymentIdCache;
  private readonly httpResourceServer: x402HTTPResourceServer;

  constructor(private readonly billingConfig: BillingConfig) {
    const facilitatorClient = new HTTPFacilitatorClient({
      url: billingConfig.x402.facilitatorUrl
    });
    const resourceServer = new x402ResourceServer(facilitatorClient).register("eip155:*", new ExactEvmScheme());
    this.httpResourceServer = new x402HTTPResourceServer(resourceServer, buildRoutes(billingConfig));
    this.cache = new PaymentIdCache(billingConfig.x402.idempotencyTtlSeconds);
    this.httpResourceServer.onProtectedRequest(async (context) => {
      if (!context.paymentHeader) return;
      const paymentId = this.extractPaymentId(context.paymentHeader);
      if (!paymentId) return;
      if (this.cache.get(paymentId)) {
        return { grantAccess: true };
      }
    });
  }

  async initialize(): Promise<void> {
    await this.httpResourceServer.initialize();
  }

  async requirePayment(req: IncomingMessage, pathname: string): Promise<RequirePaymentResult> {
    const adapter = new NodeHttpAdapter(req, pathname);
    const paymentHeader = paymentHeaderFrom(req);
    const paymentId = paymentHeader ? this.extractPaymentId(paymentHeader) : null;
    const cachedHeaders = paymentId ? this.cache.get(paymentId) : null;
    const requestContext: HTTPRequestContext = {
      adapter,
      path: pathname,
      method: adapter.getMethod()
    };
    if (paymentHeader) {
      requestContext.paymentHeader = paymentHeader;
    }

    const processed = await this.httpResourceServer.processHTTPRequest(requestContext);
    if (processed.type === "payment-error") {
      return { kind: "deny", response: processed.response };
    }
    if (processed.type === "no-payment-required") {
      return {
        kind: "authorized",
        requestContext,
        paymentId,
        cachedHeaders
      };
    }
    return {
      kind: "authorized",
      requestContext,
      settlementContext: {
        paymentPayload: processed.paymentPayload,
        paymentRequirements: processed.paymentRequirements,
        declaredExtensions: processed.declaredExtensions
      },
      paymentId,
      cachedHeaders
    };
  }

  async finalizeSettlement(
    authorized: Extract<RequirePaymentResult, { kind: "authorized" }>,
    responseBody: string,
    upstreamStatus: number
  ): Promise<Record<string, string>> {
    if (authorized.cachedHeaders) {
      return authorized.cachedHeaders;
    }
    if (!authorized.settlementContext) {
      return {};
    }
    if (upstreamStatus >= 400) {
      return {};
    }
    const settled = await this.httpResourceServer.processSettlement(
      authorized.settlementContext.paymentPayload,
      authorized.settlementContext.paymentRequirements,
      authorized.settlementContext.declaredExtensions,
      {
        request: authorized.requestContext,
        responseBody: Buffer.from(responseBody, "utf8")
      }
    );
    if (!settled.success) {
      throw new Error(`x402_settlement_failed:${settled.errorReason}`);
    }
    if (authorized.paymentId) {
      this.cache.set(authorized.paymentId, settled.headers);
    }
    return settled.headers;
  }

  private extractPaymentId(paymentHeader: string): string | null {
    try {
      const payload = decodePaymentSignatureHeader(paymentHeader);
      return extractPaymentIdentifier(payload);
    } catch {
      return null;
    }
  }
}

export type { RequirePaymentResult, ProcessSettleResultResponse };
