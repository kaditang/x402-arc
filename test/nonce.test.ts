/**
 * Seed + nonce binding, including the defect this package exists to fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clientNonceFor, mintSeed, nonceFor, verifySeed, type NonceBinding } from "../src/nonce.js";
import { createHash } from "node:crypto";

const SECRET = "test-secret";
const B: NonceBinding = {
  network: "eip155:5042",
  asset: "0x3600000000000000000000000000000000000000",
  payTo: "0xbBbBBBBbbBBBbbbBbbBbbbbbBBbBbbbbBbBbbBBb",
  amount: "30000",
  resource: "https://example.com/api/thing",
};
const NOW = 1_760_000_000_000;

test("a freshly minted seed verifies", () => {
  const s = mintSeed(SECRET, B, 300, NOW);
  assert.equal(verifySeed(SECRET, s, B, NOW).ok, true);
});

test("REPEAT PURCHASES WORK — the flaw in proposal #3504", () => {
  // The proposal derives the nonce from the requirements alone, so it is the same every time. EIP-3009
  // nonces are single-use, so buy #2 of the same thing at the same price would revert on-chain forever.
  const deterministic = (b: NonceBinding) =>
    `0x${createHash("sha256").update(JSON.stringify([b.network, b.asset, b.payTo, b.amount, b.resource])).digest("hex")}`;
  assert.equal(deterministic(B), deterministic(B), "the proposal's nonce repeats — that is the bug");

  // With a per-challenge seed, the same buyer buying the same thing twice gets two distinct nonces.
  const n1 = nonceFor(mintSeed(SECRET, B, 300, NOW), B);
  const n2 = nonceFor(mintSeed(SECRET, B, 300, NOW), B);
  assert.notEqual(n1, n2);
  assert.match(n1, /^0x[0-9a-f]{64}$/, "must be exactly 32 bytes for EIP-3009");
});

test("a tampered seed is rejected", () => {
  const s = mintSeed(SECRET, B, 300, NOW);
  const parts = s.split(".");
  const flipped = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].replace(/.$/, (c) => (c === "0" ? "1" : "0"))}`;
  const r = verifySeed(SECRET, flipped, B, NOW);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "seed_invalid");
});

test("a seed minted by someone else's secret is rejected", () => {
  const s = mintSeed("another-secret", B, 300, NOW);
  const r = verifySeed(SECRET, s, B, NOW);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "seed_invalid");
});

test("a seed expires", () => {
  const s = mintSeed(SECRET, B, 300, NOW);
  assert.equal(verifySeed(SECRET, s, B, NOW + 299_000).ok, true);
  const late = verifySeed(SECRET, s, B, NOW + 301_000);
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.reason, "seed_expired");
});

test("a seed cannot be moved to a cheaper price, another payee, or another resource", () => {
  const s = mintSeed(SECRET, B, 300, NOW);
  for (const [field, value] of [
    ["amount", "1"],
    ["payTo", "0xcCCcCcCCcccCCCCCcCcccCccCcCCCcCcccccCcCc"],
    ["resource", "https://example.com/api/expensive"],
    ["network", "eip155:8453"],
  ] as const) {
    const r = verifySeed(SECRET, s, { ...B, [field]: value }, NOW);
    assert.equal(r.ok, false, `${field} must be bound`);
    if (!r.ok) assert.equal(r.reason, "seed_invalid");
  }
});

test("checksum case does not change the binding", () => {
  const s = mintSeed(SECRET, B, 300, NOW);
  const upper = { ...B, payTo: B.payTo.toUpperCase().replace("0X", "0x"), asset: B.asset.toUpperCase().replace("0X", "0x") };
  assert.equal(verifySeed(SECRET, s, upper, NOW).ok, true);
  assert.equal(nonceFor(s, upper), nonceFor(s, B));
});

test("malformed seeds are refused without throwing", () => {
  for (const bad of ["", "nonsense", "v1.abc.def.ghi", "v2.1.2.3", `v1.${NOW}.zz.${"0".repeat(32)}`]) {
    const r = verifySeed(SECRET, bad, B, NOW);
    assert.equal(r.ok, false);
  }
  assert.equal(verifySeed(SECRET, undefined as unknown as string, B, NOW).ok, false);
});

/**
 * SPEC CONFORMANCE — a known-answer vector for the client-broadcast nonce.
 *
 * The other tests only prove both halves of THIS package agree with each other, which they would
 * keep doing after a refactor that silently walked away from the published derivation. This one
 * recomputes the digest straight from the formula in spec/scheme_exact_evm_client_broadcast.md:
 *
 *   SHA-256( "x402/exact/eip3009-client-broadcast/v1" || 0x1f || binding || 0x1f || clientNonce )
 *   binding = JSON array [network, asset, payTo, amount, resource], addresses lowercased
 *
 * If the two ever disagree, one of the two is wrong and both are public.
 */
test("the nonce matches the spec's derivation byte for byte", () => {
  const b: NonceBinding = {
    network: "eip155:5042",
    asset: "0x3600000000000000000000000000000000000000",
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    amount: "30000",
    resource: "https://api.example.com/premium-data",
  };
  const clientNonce = "9f2c4d1ab7e35608f1a0c4d29e7b5531";

  const binding = JSON.stringify([
    b.network,
    b.asset.toLowerCase(),
    b.payTo.toLowerCase(),
    b.amount,
    b.resource,
  ]);
  const expected =
    "0x" +
    createHash("sha256")
      .update(`x402/exact/eip3009-client-broadcast/v1\u001f${binding}\u001f${clientNonce}`)
      .digest("hex");

  assert.equal(clientNonceFor(clientNonce, b), expected);
  // Case of the payer's hex must not change the result, and neither must address checksumming.
  assert.equal(clientNonceFor(clientNonce.toUpperCase(), b), expected);
  assert.equal(clientNonceFor(clientNonce, { ...b, asset: b.asset.toUpperCase().replace("0X", "0x") }), expected);
});
