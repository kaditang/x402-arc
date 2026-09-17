/**
 * Pricing and the 402 challenge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ArcExactScheme, toAtomicUsdc } from "../src/scheme.js";
import { nonceFor } from "../src/nonce.js";
import { ARC_USDC } from "../src/constants.js";
import { MemorySpentStore } from "../src/store.js";
import { readPaymentRequired, selectArcRequirements } from "../src/challenge.js";
import type { PaymentRequirements } from "../src/types.js";

const req: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:5042",
  asset: ARC_USDC,
  amount: "30000",
  payTo: "0xbBbBBBBbbBBBbbbBbbBbbbbbBBbBbbbbBbBbbBBb",
  maxTimeoutSeconds: 300,
  extra: { resource: "https://example.com/api/thing" },
};

test("prices convert to 6-decimal USDC without floating point", () => {
  assert.equal(toAtomicUsdc("$0.003"), "3000");
  assert.equal(toAtomicUsdc("0.03"), "30000");
  assert.equal(toAtomicUsdc(0.03), "30000");
  assert.equal(toAtomicUsdc("1"), "1000000");
  assert.equal(toAtomicUsdc("$1.50"), "1500000");
  assert.equal(toAtomicUsdc("0.1"), "100000");
  // 0.1 + 0.2 territory: the classic float bug would give 30000.000000000004
  assert.equal(toAtomicUsdc("0.030000000000000004"), "30001", "sub-cent dust rounds UP, never down");
});

test("a price below one atomic unit is charged, not rounded to zero", () => {
  assert.equal(toAtomicUsdc("0.0000001"), "1");
});

test("exponent notation is rejected rather than silently mispriced", () => {
  assert.throws(() => toAtomicUsdc("1e-7"), /not a plain decimal/);
  assert.throws(() => toAtomicUsdc("abc"), /not a plain decimal/);
  assert.throws(() => toAtomicUsdc("-1"), /not a plain decimal/);
});

test("parsePrice passes an explicit AssetAmount through untouched", async () => {
  const s = new ArcExactScheme({ secret: "s" });
  const explicit = { asset: ARC_USDC, amount: "12345" };
  assert.deepEqual(await s.parsePrice(explicit, "eip155:5042"), explicit);
  assert.equal((await s.parsePrice("$0.003", "eip155:5042")).amount, "3000");
  assert.equal(s.getAssetDecimals(), 6);
});

test("each challenge carries a fresh seed and a matching nonce (seed mode)", async () => {
  const s = new ArcExactScheme({ secret: "s", challengeMode: "seed" });
  const a = await s.enhancePaymentRequirements(req);
  const b = await s.enhancePaymentRequirements(req);
  assert.notEqual(a.extra.seed, b.extra.seed, "a repeat purchase needs a new seed");
  assert.equal(
    a.extra.nonce,
    nonceFor(String(a.extra.seed), {
      network: req.network, asset: req.asset, payTo: req.payTo, amount: req.amount,
      resource: String(req.extra.resource),
    }),
    "the published nonce must be the one the facilitator will derive",
  );
  assert.equal(a.extra.assetTransferMethod, "eip3009-client-broadcast");
  assert.equal(a.extra.chainId, 5042);
  assert.equal(a.amount, "30000", "enhancing must not change the price");
});

test("the spent store claims a nonce once, expires it, and refuses rather than forgets when full", async () => {
  const store = new MemorySpentStore(2);
  assert.equal(await store.reserve("0xaa", 60), true);
  assert.equal(await store.reserve("0xaa", 60), false, "second claim must fail");
  assert.equal(await store.reserve("0xAA", 60), false, "case must not create a second slot");
  assert.equal(await store.reserve("0xbb", 0), true);
  assert.equal(await store.reserve("0xbb", 60), true, "an expired entry frees the slot");
  await assert.rejects(() => store.reserve("0xcc", 60), /full/, "a full store must refuse, not evict");
});

/**
 * THE compatibility guard. @x402/core rebuilds the requirements when verifying a payment and matches
 * the rebuilt `extra` against the client's echo. Any per-request value here — a seed, an expiry —
 * makes every valid payment unmatchable, and the failure looks like "no matching requirements", not
 * like a bug in this file. Two identical challenges must therefore be byte-identical.
 */
test("client-nonce mode emits a STATIC extra — no per-request field can sneak in", async () => {
  const s = new ArcExactScheme({ chain: "mainnet" });
  const a = await s.enhancePaymentRequirements(req);
  await new Promise((r) => setTimeout(r, 1100)); // cross a second boundary: a timestamp would differ
  const b = await s.enhancePaymentRequirements(req);
  assert.deepEqual(a, b, "two challenges for the same route must be identical");
  for (const forbidden of ["seed", "nonce", "expiresAtSec"]) {
    assert.ok(!(forbidden in a.extra), `extra.${forbidden} breaks requirement matching on @x402/core 2.13`);
  }
  assert.equal(a.extra.assetTransferMethod, "eip3009-client-broadcast");
});

test("client-nonce mode needs no secret; seed mode refuses to start without one", () => {
  assert.doesNotThrow(() => new ArcExactScheme({}));
  assert.throws(() => new ArcExactScheme({ challengeMode: "seed" }), /secret/);
});

test("selecting the Arc option never confuses mainnet with testnet (5042 is a PREFIX of 5042002)", () => {
  const mk = (network: string) => ({ ...req, network }) as PaymentRequirements;
  const challenge = { x402Version: 2, accepts: [mk("eip155:8453"), mk("eip155:5042002")] };
  assert.equal(selectArcRequirements(challenge, "mainnet"), null, "a testnet offer must not answer a mainnet request");
  assert.equal(selectArcRequirements(challenge, "testnet")?.network, "eip155:5042002");
});

test("a challenge is read from the `payment-required` header as well as the body", async () => {
  const body = { x402Version: 2, accepts: [{ ...req, network: "eip155:5042" }] };
  const header = Buffer.from(JSON.stringify(body)).toString("base64");
  const fromHeader = await readPaymentRequired(new Response("{}", { status: 402, headers: { "payment-required": header } }));
  assert.equal(fromHeader?.accepts[0].network, "eip155:5042");

  const fromBody = await readPaymentRequired(new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json" } }));
  assert.equal(fromBody?.accepts[0].network, "eip155:5042");

  assert.equal(await readPaymentRequired(new Response("{}", { status: 402 })), null);
});
