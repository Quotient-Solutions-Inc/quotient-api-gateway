import "dotenv/config";

import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const gatewayBaseUrl = process.env.TEST_GATEWAY_URL
  || `http://localhost:${process.env.PORT || "3001"}`;

const paidPath = "/api/v1/markets?limit=1";
const endpoint = new URL(paidPath, gatewayBaseUrl).toString();
const network = process.env.TEST_X402_NETWORK;
const privateKey = process.env.TEST_X402_PRIVATE_KEY;

function fail(message: string): never {
  console.error(`x402 e2e failed: ${message}`);
  process.exit(1);
}

if (!network) {
  fail("Missing TEST_X402_NETWORK (example: eip155:84532).");
}
if (!privateKey) {
  fail("Missing TEST_X402_PRIVATE_KEY.");
}
if (!privateKey.startsWith("0x")) {
  fail("TEST_X402_PRIVATE_KEY must be a 0x-prefixed hex private key.");
}

function resolveChain(caip2Network: string) {
  if (caip2Network === "eip155:8453") return base;
  if (caip2Network === "eip155:84532") return baseSepolia;
  fail(`Unsupported TEST_X402_NETWORK '${caip2Network}'. Use eip155:8453 or eip155:84532.`);
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
const publicClient = createPublicClient({
  chain: resolveChain(network),
  transport: http()
});
const signer = toClientEvmSigner(account, publicClient);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: network as `${string}:${string}`,
      client: new ExactEvmScheme(signer)
    }
  ]
});

console.log("x402 local e2e target:", endpoint);
console.log("x402 payer network:", network);
console.log("x402 payer address:", account.address);

try {
  const challengeResponse = await fetch(endpoint);
  const challengeHeader = challengeResponse.headers.get("payment-required");
  const challengeBody = await challengeResponse.text();

  console.log("challenge status:", challengeResponse.status);
  if (challengeResponse.status !== 402) {
    fail(`Expected initial 402 challenge, got ${challengeResponse.status}. Body: ${challengeBody}`);
  }
  if (!challengeHeader) {
    fail("Expected PAYMENT-REQUIRED header on 402 response.");
  }
  console.log("challenge header present: PAYMENT-REQUIRED");

  const paidResponse = await fetchWithPayment(endpoint);
  const paidBody = await paidResponse.text();

  console.log("paid status:", paidResponse.status);
  if (!paidResponse.ok) {
    fail(`Expected paid response 2xx, got ${paidResponse.status}. Body: ${paidBody}`);
  }

  const settlementHeader = paidResponse.headers.get("payment-response");
  if (!settlementHeader) {
    fail("Expected PAYMENT-RESPONSE settlement headers on successful paid request.");
  }
  const settlement = decodePaymentResponseHeader(settlementHeader);

  console.log("payment settled:", JSON.stringify(settlement));
  console.log("response body:");
  console.log(paidBody);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Could not complete request flow against ${endpoint}. ${message}`);
}
