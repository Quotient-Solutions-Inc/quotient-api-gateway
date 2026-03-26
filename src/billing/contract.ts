import crypto from "node:crypto";

type UnknownRecord = Record<string, unknown>;

export interface BazaarInputSpec {
  queryParams?: Record<string, UnknownRecord>;
  pathParams?: Record<string, UnknownRecord>;
  body?: UnknownRecord;
}

export interface MonetizedRoutePolicy {
  id: string;
  method: "GET" | "POST";
  pathTemplate: string;
  matcher: RegExp;
  x402RoutePatterns: readonly string[];
  creditCost: number;
  x402Amount: number;
  pricingMode: "fixed" | "range" | "quote";
  summary: string;
  description: string;
  inputSpec: BazaarInputSpec;
}

export interface CanonicalContract {
  readonly openApi: UnknownRecord;
  readonly policies: readonly MonetizedRoutePolicy[];
  readonly sourceUrl: string;
  readonly loadedFrom: "network";
}

export interface LoadCanonicalContractInput {
  sourceUrl: string;
}

interface OpenApiOperation extends UnknownRecord {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: UnknownRecord;
  responses?: UnknownRecord;
  "x-payment-info"?: UnknownRecord;
}

function isObject(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePathTemplate(pathTemplate: string): string {
  return pathTemplate.replace(/\{[^/}]+\}/g, "*");
}

function matcherForPathTemplate(pathTemplate: string): RegExp {
  const escaped = pathTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withParams = escaped.replace(/\\\{[^/}]+\\\}/g, "[^/]+");
  return new RegExp(`^${withParams}$`);
}

function asSchemaObject(value: unknown): UnknownRecord {
  if (!isObject(value)) return {};
  const schema: UnknownRecord = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      key === "type" ||
      key === "description" ||
      key === "enum" ||
      key === "minimum" ||
      key === "maximum" ||
      key === "default" ||
      key === "nullable" ||
      key === "format" ||
      key === "example" ||
      key === "required" ||
      key === "properties" ||
      key === "items" ||
      key === "oneOf" ||
      key === "anyOf" ||
      key === "allOf"
    ) {
      schema[key] = raw;
    }
  }
  return schema;
}

function parseInputSpec(pathTemplate: string, operation: OpenApiOperation): BazaarInputSpec {
  const queryParams: Record<string, UnknownRecord> = {};
  const pathParams: Record<string, UnknownRecord> = {};
  for (const parameter of operation.parameters || []) {
    if (!isObject(parameter)) continue;
    const name = typeof parameter.name === "string" ? parameter.name : null;
    const location = typeof parameter.in === "string" ? parameter.in : null;
    if (!name || !location) continue;
    const schema = asSchemaObject(parameter.schema);
    if (location === "query") queryParams[name] = schema;
    if (location === "path") pathParams[name] = schema;
  }

  // Ensure templated path params are represented even if omitted in parameters.
  const templatedParams = pathTemplate.match(/\{([^/}]+)\}/g) || [];
  for (const rawParam of templatedParams) {
    const param = rawParam.slice(1, -1);
    if (!pathParams[param]) {
      pathParams[param] = { type: "string", description: `Path parameter '${param}'.` };
    }
  }

  let body: UnknownRecord | undefined;
  const requestBody = isObject(operation.requestBody) ? operation.requestBody : undefined;
  const content = requestBody && isObject(requestBody.content) ? requestBody.content : undefined;
  const appJson = content && isObject(content["application/json"]) ? content["application/json"] : undefined;
  if (appJson && isObject(appJson.schema)) {
    body = appJson.schema;
  }

  return {
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
    ...(Object.keys(pathParams).length > 0 ? { pathParams } : {}),
    ...(body ? { body } : {})
  };
}

function parseFixedPriceUsd(rawPrice: unknown): number {
  if (typeof rawPrice !== "string" || rawPrice.trim() === "") {
    throw new Error("x-payment-info.fixed pricing requires string field 'price'.");
  }
  const parsed = Number(rawPrice);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid fixed price '${rawPrice}'.`);
  }
  return parsed;
}

function validatePayableOperation(pathTemplate: string, method: string, operation: OpenApiOperation): {
  pricingMode: "fixed" | "range" | "quote";
  x402Amount: number;
} {
  const paymentInfo = operation["x-payment-info"];
  if (!isObject(paymentInfo)) {
    throw new Error(`${method} ${pathTemplate} is missing x-payment-info.`);
  }
  const protocols = Array.isArray(paymentInfo.protocols) ? paymentInfo.protocols : [];
  if (!protocols.includes("x402")) {
    throw new Error(`${method} ${pathTemplate} x-payment-info.protocols must include 'x402'.`);
  }
  const pricingMode = paymentInfo.pricingMode;
  if (pricingMode !== "fixed" && pricingMode !== "range" && pricingMode !== "quote") {
    throw new Error(`${method} ${pathTemplate} has invalid x-payment-info.pricingMode.`);
  }
  const responses = isObject(operation.responses) ? operation.responses : {};
  const response402 = responses["402"];
  if (!isObject(response402) || response402.description !== "Payment Required") {
    throw new Error(`${method} ${pathTemplate} must declare responses.402.description as 'Payment Required'.`);
  }
  if (pricingMode === "fixed") {
    return {
      pricingMode,
      x402Amount: parseFixedPriceUsd(paymentInfo.price)
    };
  }
  if (pricingMode === "range") {
    if (typeof paymentInfo.minPrice !== "string" || typeof paymentInfo.maxPrice !== "string") {
      throw new Error(`${method} ${pathTemplate} range pricing requires minPrice and maxPrice strings.`);
    }
    const min = Number(paymentInfo.minPrice);
    const max = Number(paymentInfo.maxPrice);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
      throw new Error(`${method} ${pathTemplate} has invalid range pricing values.`);
    }
    // Credit accounting only supports fixed debit right now; use max as safe bound.
    return {
      pricingMode,
      x402Amount: max
    };
  }
  return {
    pricingMode,
    // Quote endpoints are not currently enabled for fixed-credit accounting.
    x402Amount: 1
  };
}

function buildPolicy(pathTemplate: string, method: "GET" | "POST", operation: OpenApiOperation): MonetizedRoutePolicy {
  const { pricingMode, x402Amount } = validatePayableOperation(pathTemplate, method, operation);
  const summary = typeof operation.summary === "string" ? operation.summary : `${method} ${pathTemplate}`;
  const description = typeof operation.description === "string" ? operation.description : summary;
  const routePattern = `${method} ${normalizePathTemplate(pathTemplate)}`;
  const inputSpec = parseInputSpec(pathTemplate, operation);
  const id =
    (typeof operation.operationId === "string" && operation.operationId.trim() !== "" && operation.operationId.trim()) ||
    `${method.toLowerCase()}_${pathTemplate.replace(/[^a-zA-Z0-9]+/g, "_")}`;
  return {
    id,
    method,
    pathTemplate,
    matcher: matcherForPathTemplate(pathTemplate),
    x402RoutePatterns: [routePattern],
    x402Amount,
    creditCost: Math.round(x402Amount * 1000),
    pricingMode,
    summary,
    description,
    inputSpec
  };
}

export function buildPoliciesFromOpenApi(openApi: UnknownRecord): MonetizedRoutePolicy[] {
  const paths = openApi.paths;
  if (!isObject(paths)) {
    throw new Error("OpenAPI document is missing top-level paths object.");
  }
  const policies: MonetizedRoutePolicy[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    for (const method of ["get", "post"] as const) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;
      if (!("x-payment-info" in operation)) continue;
      const inputSpec = parseInputSpec(pathTemplate, operation);
      const hasInputSchema =
        Boolean(inputSpec.body) ||
        Boolean(inputSpec.queryParams && Object.keys(inputSpec.queryParams).length > 0) ||
        Boolean(inputSpec.pathParams && Object.keys(inputSpec.pathParams).length > 0);
      if (!hasInputSchema) {
        throw new Error(
          `Payable operation ${method.toUpperCase()} ${pathTemplate} must define input schema via parameters and/or requestBody.content.application/json.schema.`
        );
      }
      policies.push(buildPolicy(pathTemplate, method.toUpperCase() as "GET" | "POST", operation));
    }
  }
  if (policies.length === 0) {
    throw new Error("No payable operations were found in canonical OpenAPI.");
  }
  return policies;
}

export function hashCanonicalOpenApi(openApi: UnknownRecord): string {
  return crypto.createHash("sha256").update(JSON.stringify(openApi)).digest("hex");
}

export function buildCanonicalContractFromOpenApi(
  openApi: UnknownRecord,
  sourceUrl: string,
  loadedFrom: "network"
): CanonicalContract {
  return {
    openApi,
    policies: buildPoliciesFromOpenApi(openApi),
    sourceUrl,
    loadedFrom
  };
}

export async function loadCanonicalContract(input: LoadCanonicalContractInput): Promise<CanonicalContract> {
  const response = await fetch(input.sourceUrl, {
    method: "GET",
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`Canonical OpenAPI fetch failed with status ${response.status}.`);
  }
  const parsed = (await response.json()) as unknown;
  if (!isObject(parsed)) {
    throw new Error("Canonical OpenAPI response is not an object.");
  }
  return buildCanonicalContractFromOpenApi(parsed, input.sourceUrl, "network");
}

export function resolveMonetizedRoutePolicy(
  pathname: string,
  method: string | undefined,
  policies: readonly MonetizedRoutePolicy[]
): MonetizedRoutePolicy | null {
  const normalizedMethod = (method || "GET").toUpperCase();
  for (const policy of policies) {
    if (policy.method !== normalizedMethod) continue;
    if (policy.matcher.test(pathname)) return policy;
  }
  return null;
}
