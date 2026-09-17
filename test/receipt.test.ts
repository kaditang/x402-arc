/**
 * Receipt verification: one test per way a stranger could get a paid response without paying for it.
 * Every case below is an attack, not a hypothetical — the check exists because the attack works
 * without it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkPaidReceipt, type RpcLog, type RpcReceipt } from "../src/receipt.js";
import { ARC_USDC, TOPIC_AUTHORIZATION_USED, TOPIC_TRANSFER } from "../src/constants.js";

const PAYER = "0xAAaAaAaaAaAaaaAAaAaAaAAAAaaAAaAaAAAAaAAa";
const PAYTO = "0xbBbBBBBbbBBBbbbBbbBbbbbbBBbBbbbbBbBbbBBb";
const OTHER = "0xcCCcCcCCcccCCCCCcCcccCccCcCCCcCcccccCcCc";
const EVIL_TOKEN = "0xdddDDDddDDDdDddDDddDDDdDdDDdddDdDDDdDdDD";
const NONCE = `0x${"11".repeat(32)}`;
const BLOCK = 1000;
const NOW_MS = 1_760_000_000_000;
const TS = Math.floor(NOW_MS / 1000) - 30; // mined 30s ago

const addrTopic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`.toLowerCase();
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

const transferLog = (opts: { asset?: string; from?: string; to?: string; value?: bigint } = {}): RpcLog => ({
  address: opts.asset ?? ARC_USDC,
  topics: [TOPIC_TRANSFER, addrTopic(opts.from ?? PAYER), addrTopic(opts.to ?? PAYTO)],
  data: word(opts.value ?? 30_000n),
});
const authLog = (opts: { asset?: string; authorizer?: string; nonce?: string } = {}): RpcLog => ({
  address: opts.asset ?? ARC_USDC,
  topics: [TOPIC_AUTHORIZATION_USED, addrTopic(opts.authorizer ?? PAYER), opts.nonce ?? NONCE],
  data: "0x",
});
const receiptOf = (logs: RpcLog[], status = "0x1"): RpcReceipt => ({
  status,
  blockNumber: `0x${BLOCK.toString(16)}`,
  transactionHash: `0x${"ab".repeat(32)}`,
  logs,
});

const ctx = (receipt: RpcReceipt, over: Partial<Parameters<typeof checkPaidReceipt>[0]> = {}) => ({
  receipt,
  blockTimestampSec: TS,
  tipBlockNumber: BLOCK,
  nowMs: NOW_MS,
  minConfirmations: 1,
  maxReceiptAgeSec: 600,
  ...over,
});
const expected = { asset: ARC_USDC, payTo: PAYTO, amount: 30_000n, nonce: NONCE };

test("a real payment verifies and reports the payer", () => {
  const r = checkPaidReceipt(ctx(receiptOf([authLog(), transferLog()])), expected);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.payer, PAYER.toLowerCase());
    assert.equal(r.amountPaid, 30_000n);
    assert.equal(r.confirmations, 1);
  }
});

test("overpaying is accepted; underpaying is not", () => {
  assert.equal(checkPaidReceipt(ctx(receiptOf([authLog(), transferLog({ value: 50_000n })])), expected).ok, true);
  const short = checkPaidReceipt(ctx(receiptOf([authLog(), transferLog({ value: 29_999n })])), expected);
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.reason, "insufficient_amount");
});

test("a reverted transaction never pays, even with a valid-looking hash", () => {
  const r = checkPaidReceipt(ctx(receiptOf([], "0x0")), expected);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "transaction_failed");
});

test("a fake token emitting identical events is rejected (log.address is checked)", () => {
  const r = checkPaidReceipt(
    ctx(receiptOf([authLog({ asset: EVIL_TOKEN }), transferLog({ asset: EVIL_TOKEN })])),
    expected,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "nonce_mismatch");
});

test("someone else's payment to someone else does not pay us", () => {
  const r = checkPaidReceipt(ctx(receiptOf([authLog(), transferLog({ to: OTHER })])), expected);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "transfer_not_found");
});

test("a transfer from an account other than the authorizer is rejected", () => {
  const r = checkPaidReceipt(ctx(receiptOf([authLog(), transferLog({ from: OTHER })])), expected);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "transfer_not_found");
});

test("dust transfers are NOT summed into the price", () => {
  const dust = [transferLog({ value: 10_000n }), transferLog({ value: 10_000n }), transferLog({ value: 10_000n })];
  const r = checkPaidReceipt(ctx(receiptOf([authLog(), ...dust])), expected);
  assert.equal(r.ok, false, "3 × 10,000 must not satisfy a 30,000 price");
  if (!r.ok) assert.equal(r.reason, "insufficient_amount");
});

test("a payment for a different challenge (different nonce) is rejected", () => {
  const r = checkPaidReceipt(ctx(receiptOf([authLog({ nonce: `0x${"22".repeat(32)}` }), transferLog()])), expected);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "nonce_mismatch");
});

test("an unconfirmed payment waits", () => {
  const r = checkPaidReceipt(ctx(receiptOf([authLog(), transferLog()]), { tipBlockNumber: BLOCK - 1 }), expected);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "insufficient_confirmations");
});

test("an old payment cannot be presented forever, and a future-dated one is refused", () => {
  const stale = checkPaidReceipt(ctx(receiptOf([authLog(), transferLog()]), { blockTimestampSec: TS - 3600 }), expected);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "receipt_stale");

  const future = checkPaidReceipt(
    ctx(receiptOf([authLog(), transferLog()]), { blockTimestampSec: Math.floor(NOW_MS / 1000) + 600 }),
    expected,
  );
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.reason, "receipt_future");
});

test("address comparisons ignore checksum case", () => {
  const r = checkPaidReceipt(ctx(receiptOf([authLog(), transferLog()])), { ...expected, payTo: PAYTO.toUpperCase().replace("0X", "0x") });
  assert.equal(r.ok, true);
});

/**
 * Arc emits TWO Transfer events for one payment: the ERC-20 one from the USDC predeploy (6 decimals)
 * and a native-balance mirror from the system address 0xff…fe carrying the SAME amount scaled by 10^12
 * (18 decimals). Observed on a real testnet payment, 2026-09-18, tx 0xba2d36e3….
 *
 * Counting the mirror would let 0.000001 USDC satisfy any price up to a million dollars. The filter on
 * `log.address` is what prevents it, and these two tests are why it can never be relaxed.
 */
const NATIVE_MIRROR = "0xfffffffffffffffffffffffffffffffffffffffe";
const mirrorLog = (sixDecValue: bigint): RpcLog => ({
  address: NATIVE_MIRROR,
  topics: [TOPIC_TRANSFER, addrTopic(PAYER), addrTopic(PAYTO)],
  data: word(sixDecValue * 10n ** 12n),
});

test("the 18-decimal native mirror log cannot pay a 6-decimal price", () => {
  // A real payment of ONE atomic unit against a 30,000 price. The mirror log says 10^12.
  const r = checkPaidReceipt(ctx(receiptOf([authLog(), mirrorLog(1n), transferLog({ value: 1n })])), expected);
  assert.equal(r.ok, false, "10^12 in the mirror must not satisfy a 30,000 price");
  if (!r.ok) assert.equal(r.reason, "insufficient_amount");
});

test("a correct payment still verifies when the mirror log is present, and reports the 6-decimal amount", () => {
  const r = checkPaidReceipt(ctx(receiptOf([authLog(), mirrorLog(30_000n), transferLog()])), expected);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.amountPaid, 30_000n, "the reported amount must be the ERC-20 view");
});
