/**
 * Receipt verification — the security core of this package.
 *
 * With client-broadcast settlement the server never submits anything; it is handed a transaction hash
 * and must decide whether that transaction really paid THIS request. Every check below exists because
 * its absence is exploitable:
 *
 *   status              a reverted transaction emits no logs but still has a hash
 *   log.address         any contract can emit an event that LOOKS like a USDC Transfer
 *   recipient           otherwise someone else's payment to someone else pays for our resource
 *   amount              a $0.000001 transfer must not buy a $0.03 call
 *   nonce               binds the authorization to this challenge and this resource (see nonce.ts)
 *   authorizer = sender the Transfer must come from the account that signed the authorization
 *   confirmations       Arc has deterministic finality, but a reorg-free chain still has a tip
 *   age                 an old transaction must not be presentable forever
 *
 * Replay of one valid transaction across two requests is NOT handled here — that is the spent store.
 *
 * Pure function over already-fetched data, so every branch is unit-testable without a network.
 */
import { TOPIC_AUTHORIZATION_USED, TOPIC_TRANSFER } from "./constants.js";

export type RpcLog = { address: string; topics: string[]; data: string };
export type RpcReceipt = {
  status: string;
  blockNumber: string;
  transactionHash: string;
  logs: RpcLog[];
};

export type ExpectedPayment = {
  /** Token contract the payment must be denominated in. */
  asset: string;
  /** Who must receive it. */
  payTo: string;
  /** Minimum atomic units (6-decimal USDC on Arc). */
  amount: bigint;
  /** The nonce this challenge requires — see nonceFor(). */
  nonce: string;
};

export type ReceiptContext = {
  receipt: RpcReceipt;
  /** Unix seconds of the block the receipt is in. */
  blockTimestampSec: number;
  /** Current chain tip. */
  tipBlockNumber: number;
  nowMs: number;
  minConfirmations: number;
  maxReceiptAgeSec: number;
  /** Tolerance for a block timestamp slightly ahead of our clock. */
  clockSkewSec?: number;
};

export type ReceiptResult =
  | { ok: true; payer: string; amountPaid: bigint; blockNumber: number; confirmations: number }
  | { ok: false; reason: string; message: string };

const lower = (s: string) => (typeof s === "string" ? s.toLowerCase() : "");
/** An indexed address topic is a 32-byte left-padded word; the address is the last 20 bytes. */
const topicToAddress = (t: string) => (typeof t === "string" && t.length >= 42 ? `0x${t.slice(-40)}`.toLowerCase() : "");
const isHexQuantity = (s: string) => typeof s === "string" && /^0x[0-9a-fA-F]+$/.test(s);

/** Verify that `receipt` is a settled payment matching `expected`. */
export function checkPaidReceipt(ctx: ReceiptContext, expected: ExpectedPayment): ReceiptResult {
  const { receipt } = ctx;
  const fail = (reason: string, message: string): ReceiptResult => ({ ok: false, reason, message });

  if (!receipt || !Array.isArray(receipt.logs)) return fail("receipt_missing", "no receipt for this transaction");
  // Arc returns "0x1"/"0x0"; treat anything else as failure rather than guessing.
  if (receipt.status !== "0x1") return fail("transaction_failed", "the transaction reverted");
  if (!isHexQuantity(receipt.blockNumber)) return fail("receipt_missing", "receipt has no block (still pending?)");

  const asset = lower(expected.asset);
  const payTo = lower(expected.payTo);
  const wantNonce = lower(expected.nonce);

  // 1. The authorization actually used on-chain, for OUR nonce, on OUR token contract.
  const authLog = receipt.logs.find(
    (l) =>
      lower(l.address) === asset &&
      lower(l.topics?.[0] ?? "") === lower(TOPIC_AUTHORIZATION_USED) &&
      lower(l.topics?.[2] ?? "") === wantNonce,
  );
  if (!authLog) {
    return fail(
      "nonce_mismatch",
      "the transaction does not use the authorization nonce this challenge requires",
    );
  }
  const authorizer = topicToAddress(authLog.topics[1] ?? "");
  if (!authorizer) return fail("nonce_mismatch", "authorization log is malformed");

  // 2. The value transfer itself: right token, right payer, right recipient, enough money.
  //    Matched as ONE log — never summed across logs, so a pile of dust transfers cannot add up to
  //    the price.
  let best: { value: bigint } | null = null;
  for (const l of receipt.logs) {
    if (lower(l.address) !== asset) continue;
    if (lower(l.topics?.[0] ?? "") !== lower(TOPIC_TRANSFER)) continue;
    if (topicToAddress(l.topics?.[1] ?? "") !== authorizer) continue;
    if (topicToAddress(l.topics?.[2] ?? "") !== payTo) continue;
    if (!isHexQuantity(l.data)) continue;
    const value = BigInt(l.data);
    if (!best || value > best.value) best = { value };
  }
  if (!best) {
    return fail("transfer_not_found", "no USDC transfer from the authorizer to the payment address");
  }
  if (best.value < expected.amount) {
    return fail("insufficient_amount", "the transfer is smaller than the price");
  }

  // 3. Finality. Arc is BFT with deterministic finality, so one confirmation is genuinely final —
  //    but the caller decides, and a receipt from a block the node has not reached is refused.
  const blockNumber = Number(BigInt(receipt.blockNumber));
  const confirmations = ctx.tipBlockNumber - blockNumber + 1;
  if (confirmations < ctx.minConfirmations) {
    return fail("insufficient_confirmations", "the payment is not final yet");
  }

  // 4. Freshness. The spent store stops the same transaction being reused; this stops an ancient one
  //    from being presentable at all, and bounds how long the store must remember it.
  const skew = ctx.clockSkewSec ?? 60;
  const ageSec = Math.floor(ctx.nowMs / 1000) - ctx.blockTimestampSec;
  if (ageSec > ctx.maxReceiptAgeSec) return fail("receipt_stale", "this payment is too old to present");
  if (ageSec < -skew) return fail("receipt_future", "the payment's block is in the future");

  return { ok: true, payer: authorizer, amountPaid: best.value, blockNumber, confirmations };
}
