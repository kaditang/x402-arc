/**
 * Seed + nonce binding, including the defect this package exists to fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mintSeed, nonceFor, verifySeed, type NonceBinding } from "../src/nonce.js";
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
