/**
 * The facilitator end to end, against a stubbed Arc RPC: the happy path, double-spend, a direct
 * settle that skips verify, and the upstream-amplification guards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ArcLocalFacilitator } from "../src/facilitator.js";
import { ArcExactScheme } from "../src/scheme.js";
import { ArcRpc } from "../src/rpc.js";
import { ARC_USDC, TOPIC_AUTHORIZATION_USED, TOPIC_TRANSFER } from "../src/constants.js";
import { clientNonceFor, nonceFor, type NonceBinding } from "../src/nonce.js";
import type { PaymentPayload, PaymentRequirements } from "../src/types.js";

const SECRET = "facilitator-secret";
const PAYER = "0xAAaAaAaaAaAaaaAAaAaAaAAAAaaAAaAaAAAAaAAa";
const PAYTO = "0xbBbBBBBbbBBBbbbBbbBbbbbbBBbBbbbbBbBbbBBb";
const TX = `0x${"ab".repeat(32)}`;
const BLOCK = 4096;
const NOW = 1_760_000_000_000;

const addrTopic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`.toLowerCase();
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

/** A stub Arc node. Counts calls so the amplification guards can be asserted, not assumed. */
function stubRpc(nonce: string, over: { value?: bigint; to?: string } = {}) {
  const calls: Record<string, number> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { method } = JSON.parse(String(init.body));
    calls[method] = (calls[method] ?? 0) + 1;
    const result =
      method === "eth_getTransactionReceipt"
        ? {
            status: "0x1",
            blockNumber: `0x${BLOCK.toString(16)}`,
            transactionHash: TX,
            logs: [
              { address: ARC_USDC, topics: [TOPIC_AUTHORIZATION_USED, addrTopic(PAYER), nonce], data: "0x" },
              {
                address: ARC_USDC,
                topics: [TOPIC_TRANSFER, addrTopic(PAYER), addrTopic(over.to ?? PAYTO)],
                data: word(over.value ?? 30_000n),
              },
            ],
          }
        : method === "eth_blockNumber"
          ? `0x${BLOCK.toString(16)}`
          : { timestamp: `0x${(Math.floor(NOW / 1000) - 10).toString(16)}` };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:5042",
  asset: ARC_USDC,
  amount: "30000",
  payTo: PAYTO,
  maxTimeoutSeconds: 300,
  extra: { resource: "https://example.com/api/thing" },
  ...over,
});

const bindingOf = (r: PaymentRequirements): NonceBinding => ({
  network: r.network,
  asset: r.asset,
  payTo: r.payTo,
  amount: r.amount,
  resource: String(r.extra?.resource ?? ""),
});

async function challenge(r: PaymentRequirements) {
  const scheme = new ArcExactScheme({ secret: SECRET, challengeMode: "seed" });
  return scheme.enhancePaymentRequirements(r);
}
const payloadFor = (r: PaymentRequirements, seed: string, tx = TX): PaymentPayload => ({
  x402Version: 2,
  accepted: r,
  payload: { transaction: tx, seed, nonce: nonceFor(seed, bindingOf(r)) },
});

function facilitatorFor(nonce: string, over: { value?: bigint; to?: string } = {}, rpcOpts = {}, mode: "client-nonce" | "seed" | "either" = "seed") {
  const { calls, fetchImpl } = stubRpc(nonce, over);
  const rpc = new ArcRpc({ url: "http://stub", fetchImpl, ...rpcOpts });
  return { calls, f: new ArcLocalFacilitator({ secret: SECRET, rpc, now: () => NOW, challengeMode: mode }) };
}

test("a real payment verifies, settles once, and cannot be spent twice", async () => {
  const req = await challenge(requirements());
  const seed = String(req.extra.seed);
  const { f } = facilitatorFor(nonceFor(seed, bindingOf(req)));
  const payload = payloadFor(req, seed);

  const v = await f.verify(payload, req);
  assert.equal(v.isValid, true, v.invalidMessage ?? "verify failed");
  assert.equal(v.payer, PAYER.toLowerCase());

  const s1 = await f.settle(payload, req);
  assert.equal(s1.success, true, s1.errorMessage ?? "settle failed");
  assert.equal(s1.transaction, TX);
  assert.equal(s1.amount, "30000");

  const s2 = await f.settle(payload, req);
  assert.equal(s2.success, false, "the same payment must not settle twice");
  assert.equal(s2.errorReason, "authorization_already_spent");
});

test("settle does its own verification — it cannot be reached by skipping verify", async () => {
  const req = await challenge(requirements());
  const seed = String(req.extra.seed);
  // The node reports a payment of 1 atomic unit against a 30,000 price.
  const { f } = facilitatorFor(nonceFor(seed, bindingOf(req)), { value: 1n });
  const s = await f.settle(payloadFor(req, seed), req);
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "insufficient_amount");
});

test("a challenge from another server (wrong secret) does not pay", async () => {
  const other = new ArcExactScheme({ secret: "someone-elses-secret", challengeMode: "seed" });
  const req = await other.enhancePaymentRequirements(requirements());
  const seed = String(req.extra.seed);
  const { f } = facilitatorFor(nonceFor(seed, bindingOf(req)));
  const v = await f.verify(payloadFor(req, seed), req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "seed_invalid");
});

test("wrong scheme, network or asset are refused before any RPC call", async () => {
  const req = await challenge(requirements());
  const seed = String(req.extra.seed);
  const { f, calls } = facilitatorFor(nonceFor(seed, bindingOf(req)));
  for (const bad of [{ scheme: "upto" }, { network: "eip155:8453" }, { asset: "0xdead" }]) {
    const r = { ...req, ...bad } as PaymentRequirements;
    const v = await f.verify(payloadFor(r, seed), r);
    assert.equal(v.isValid, false);
  }
  assert.equal(calls.eth_getTransactionReceipt ?? 0, 0, "must not touch the chain for malformed requests");
});

test("a malformed transaction hash never reaches the RPC", async () => {
  const req = await challenge(requirements());
  const seed = String(req.extra.seed);
  const { f, calls } = facilitatorFor(nonceFor(seed, bindingOf(req)));
  const v = await f.verify(payloadFor(req, seed, "0xnothex"), req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_payload");
  assert.equal(calls.eth_getTransactionReceipt ?? 0, 0);
});

test("a burst of the same payment: ONE receipt lookup, and only ONE of them is valid", async () => {
  const req = await challenge(requirements());
  const seed = String(req.extra.seed);
  const { f, calls } = facilitatorFor(nonceFor(seed, bindingOf(req)));
  const payload = payloadFor(req, seed);

  const results = await Promise.all(Array.from({ length: 10 }, () => f.verify(payload, req)));

  // Upstream protection: ten requests, one RPC call.
  assert.equal(calls.eth_getTransactionReceipt, 1, "single-flight + cache must collapse the burst");
  // Replay protection under concurrency: claiming is atomic, so nine of them lose the race. A burst
  // is exactly how someone would try to slip a double-spend past a check-then-act store.
  assert.equal(results.filter((r) => r.isValid).length, 1, "exactly one verification may win");
  assert.ok(
    results.filter((r) => !r.isValid).every((r) => r.invalidReason === "authorization_already_spent"),
    "the losers must be rejected as replays, not for some other reason",
  );
});

test("a flood of invented hashes is capped by the RPC budget", async () => {
  const req = await challenge(requirements());
  const seed = String(req.extra.seed);
  const { f, calls } = facilitatorFor(nonceFor(seed, bindingOf(req)), {}, { maxCallsPerMin: 5, missTtlMs: 0 });
  const reasons: string[] = [];
  for (let i = 0; i < 12; i++) {
    const v = await f.verify(payloadFor(req, seed, `0x${i.toString(16).padStart(64, "0")}`), req);
    reasons.push(String(v.invalidReason));
  }
  assert.ok(calls.eth_getTransactionReceipt <= 5, `upstream calls must be capped, got ${calls.eth_getTransactionReceipt}`);
  assert.ok(reasons.includes("verification_unavailable"), "over-budget requests must say so, not pass");
  assert.ok(!reasons.includes(undefined as unknown as string));
});

test("getSupported advertises Arc and the transfer method", async () => {
  const { f } = facilitatorFor(`0x${"00".repeat(32)}`);
  const s = await f.getSupported();
  assert.equal(s.kinds[0].network, "eip155:5042");
  assert.equal(s.kinds[0].scheme, "exact");
  assert.equal(s.kinds[0].extra?.assetTransferMethod, "eip3009-client-broadcast");
  assert.equal(s.kinds[0].extra?.decimals, 6, "payments are the 6-decimal view, never the 18-decimal gas view");
});

// ── client-nonce mode (the default, and the only one that works on @x402/core 2.13) ────────────────
test("client-nonce mode: a payment verifies, settles once, and repeat purchases each get a new nonce", async () => {
  const req = requirements(); // NOT enhanced with a seed
  const c1 = "a".repeat(32);
  const n1 = clientNonceFor(c1, bindingOf(req));
  const { f } = facilitatorFor(n1, {}, {}, "client-nonce");
  const payload: PaymentPayload = { x402Version: 2, accepted: req, payload: { transaction: TX, clientNonce: c1 } };

  const v = await f.verify(payload, req);
  assert.equal(v.isValid, true, v.invalidMessage ?? "verify failed");
  assert.equal((await f.settle(payload, req)).success, true);
  assert.equal((await f.settle(payload, req)).errorReason, "authorization_already_spent");

  // The same buyer buying the same thing again: a different clientNonce ⇒ a different EIP-3009 nonce,
  // which is exactly what proposal #3504's deterministic digest cannot do.
  assert.notEqual(clientNonceFor("b".repeat(32), bindingOf(req)), n1);
});

test("client-nonce mode: a payment for a cheaper route cannot settle an expensive one", async () => {
  const cheap = requirements({ amount: "1000" });
  const c = "c".repeat(32);
  // The buyer paid against the CHEAP binding; the server verifies against the EXPENSIVE requirements.
  const { f } = facilitatorFor(clientNonceFor(c, bindingOf(cheap)), {}, {}, "client-nonce");
  const expensive = requirements({ amount: "30000" });
  const v = await f.verify({ x402Version: 2, accepted: expensive, payload: { transaction: TX, clientNonce: c } }, expensive);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "nonce_mismatch");
});

test("a seed is not accepted by a client-nonce server, and vice versa", async () => {
  const req = requirements();
  const c = "d".repeat(32);
  const seedServer = facilitatorFor(clientNonceFor(c, bindingOf(req)), {}, {}, "seed").f;
  const v1 = await seedServer.verify({ x402Version: 2, accepted: req, payload: { transaction: TX, clientNonce: c } }, req);
  assert.equal(v1.isValid, false);
  assert.equal(v1.invalidReason, "invalid_payload");

  const enhanced = await challenge(requirements());
  const seed = String(enhanced.extra.seed);
  const cnServer = facilitatorFor(nonceFor(seed, bindingOf(enhanced)), {}, {}, "client-nonce").f;
  const v2 = await cnServer.verify(payloadFor(enhanced, seed), enhanced);
  assert.equal(v2.isValid, false);
  assert.equal(v2.invalidReason, "invalid_payload");
});

test("malformed clientNonce values are refused", async () => {
  const req = requirements();
  const { f } = facilitatorFor(`0x${"00".repeat(32)}`, {}, {}, "client-nonce");
  for (const bad of ["", "zz", "abc", "x".repeat(32), "a".repeat(200)]) {
    const v = await f.verify({ x402Version: 2, accepted: req, payload: { transaction: TX, clientNonce: bad } }, req);
    assert.equal(v.isValid, false, `clientNonce "${bad.slice(0, 8)}" must be refused`);
  }
});

test("the buyer's own `resource` field cannot change the binding", async () => {
  const req = requirements(); // extra.resource is set by the SERVER
  const c = "e".repeat(32);
  const { f } = facilitatorFor(clientNonceFor(c, bindingOf(req)), {}, {}, "client-nonce");
  // A payload claiming a different resource must still verify: only the server's value counts.
  const v = await f.verify(
    { x402Version: 2, accepted: req, resource: { url: "https://evil.example/whatever" }, payload: { transaction: TX, clientNonce: c } },
    req,
  );
  assert.equal(v.isValid, true, v.invalidMessage ?? "the payload's resource must be ignored");
});

// ── claim-at-verify: the default, because @x402/core settles AFTER the handler ─────────────────────
test("claim-at-verify blocks a replay BEFORE the handler would run", async () => {
  const req = requirements();
  const c = "f".repeat(32);
  const { f } = facilitatorFor(clientNonceFor(c, bindingOf(req)), {}, {}, "client-nonce");
  const payload: PaymentPayload = { x402Version: 2, accepted: req, payload: { transaction: TX, clientNonce: c } };

  assert.equal((await f.verify(payload, req)).isValid, true, "first verification must pass");
  assert.equal((await f.settle(payload, req)).success, true, "its settlement must pass");

  // The replay: rejected at VERIFY, which is what stops the handler from doing free work.
  const replay = await f.verify(payload, req);
  assert.equal(replay.isValid, false);
  assert.equal(replay.invalidReason, "authorization_already_spent");
});

test("settle cannot be called twice, even without a verify in between", async () => {
  const req = requirements();
  const c = "0".repeat(32);
  const { f } = facilitatorFor(clientNonceFor(c, bindingOf(req)), {}, {}, "client-nonce");
  const payload: PaymentPayload = { x402Version: 2, accepted: req, payload: { transaction: TX, clientNonce: c } };
  assert.equal((await f.settle(payload, req)).success, true);
  const second = await f.settle(payload, req);
  assert.equal(second.success, false, "a direct settle path must not double-spend");
  assert.equal(second.errorReason, "authorization_already_spent");
});

test("the facilitator remembers who paid, so a server can attribute the payment", async () => {
  const req = requirements();
  const c = "1".repeat(32);
  const { f } = facilitatorFor(clientNonceFor(c, bindingOf(req)), {}, {}, "client-nonce");
  assert.equal(f.payerOf(TX), null, "nothing is claimed before verification");

  await f.verify({ x402Version: 2, accepted: req, payload: { transaction: TX, clientNonce: c } }, req);
  assert.equal(f.payerOf(TX), PAYER.toLowerCase(), "the on-chain payer, not the rail name");
  assert.equal(f.payerOf("0x" + "99".repeat(32)), null, "an unknown tx must return null, never a guess");
});
