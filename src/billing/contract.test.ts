import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  buildPoliciesFromOpenApi,
  loadCanonicalContract,
  resolveMonetizedRoutePolicy
} from "./contract.js";

const openApiFixture = {
  openapi: "3.1.0",
  paths: {
    "/api/v1/markets": {
      get: {
        operationId: "getMarkets",
        summary: "List markets",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { limit: { type: "integer" } } }
            }
          }
        },
        "x-payment-info": {
          protocols: ["x402"],
          pricingMode: "fixed",
          price: "0.005"
        },
        responses: {
          "200": { description: "ok" },
          "402": { description: "Payment Required" }
        }
      }
    },
    "/api/v1/markets/{slug}/intelligence": {
      get: {
        operationId: "getMarketIntelligence",
        summary: "Get market intelligence",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] }
            }
          }
        },
        "x-payment-info": {
          protocols: ["x402"],
          pricingMode: "fixed",
          price: "0.25"
        },
        responses: {
          "200": { description: "ok" },
          "402": { description: "Payment Required" }
        }
      }
    }
  }
};

test("buildPoliciesFromOpenApi parses payable routes from canonical spec", () => {
  const policies = buildPoliciesFromOpenApi(openApiFixture);
  assert.equal(policies.length, 2);
  assert.equal(policies[0]?.method, "GET");
  assert.equal(policies[0]?.x402Amount, 0.005);
  assert.equal(policies[0]?.creditCost, 5);
  assert.equal(policies[1]?.x402RoutePatterns[0], "GET /api/v1/markets/*/intelligence");
});

test("resolveMonetizedRoutePolicy matches templated path routes", () => {
  const policies = buildPoliciesFromOpenApi(openApiFixture);
  const match = resolveMonetizedRoutePolicy("/api/v1/markets/btc/intelligence", "GET", policies);
  assert.ok(match);
  assert.equal(match?.id, "getMarketIntelligence");
});

test("buildPoliciesFromOpenApi rejects payable routes missing required request schema", () => {
  const invalidOpenApi = {
    openapi: "3.1.0",
    paths: {
      "/api/v1/markets": {
        get: {
          "x-payment-info": {
            protocols: ["x402"],
            pricingMode: "fixed",
            price: "0.005"
          },
          responses: {
            "402": { description: "Payment Required" }
          }
        }
      }
    }
  };
  assert.throws(
    () => buildPoliciesFromOpenApi(invalidOpenApi),
    /must define input schema via parameters and\/or requestBody\.content\.application\/json\.schema/
  );
});

test("buildPoliciesFromOpenApi accepts payable GET routes with parameter-only input schema", () => {
  const parameterOnlyOpenApi = {
    openapi: "3.1.0",
    paths: {
      "/api/v1/markets": {
        get: {
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1 } }],
          "x-payment-info": {
            protocols: ["x402"],
            pricingMode: "fixed",
            price: "0.005"
          },
          responses: {
            "402": { description: "Payment Required" }
          }
        }
      }
    }
  };
  const policies = buildPoliciesFromOpenApi(parameterOnlyOpenApi);
  assert.equal(policies.length, 1);
  assert.ok(policies[0]?.inputSpec.queryParams?.limit);
});

test("gateway canonical contract loader builds resolver-compatible policies from canonical API", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(openApiFixture));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/v1/openapi.json`;
  const loaded = await loadCanonicalContract({ sourceUrl: url });
  assert.equal(loaded.policies.length, 2);
  assert.ok(resolveMonetizedRoutePolicy("/api/v1/markets", "GET", loaded.policies));
  assert.ok(resolveMonetizedRoutePolicy("/api/v1/markets/eth/intelligence", "GET", loaded.policies));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});
