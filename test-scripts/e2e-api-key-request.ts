import "dotenv/config";

const gatewayBaseUrl = process.env.TEST_GATEWAY_URL
  || `http://localhost:${process.env.PORT || "3001"}`;
const endpoint = new URL("/api/v1/markets?limit=1", gatewayBaseUrl).toString();
const testApiKey = process.env.TEST_API_KEY;

function fail(message: string): never {
  console.error(`api-key e2e failed: ${message}`);
  process.exit(1);
}

if (!testApiKey) {
  fail("Missing TEST_API_KEY.");
}

console.log("api-key e2e target:", endpoint);

try {
  const response = await fetch(endpoint, {
    headers: {
      "x-quotient-api-key": testApiKey
    }
  });
  const body = await response.text();

  console.log("api-key response status:", response.status);
  if (!response.ok) {
    fail(`Expected HTTP 2xx, got ${response.status}. Body: ${body}`);
  }

  console.log("response body:");
  console.log(body);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Could not complete request against ${endpoint}. ${message}`);
}
