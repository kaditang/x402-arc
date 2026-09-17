/**
 * The buyer: fetch → 402 → pay on Arc → retry with X-PAYMENT.
 *
 * This is the whole point of client-broadcast settlement — the buyer needs no facilitator and no
 * second gas asset, because on Arc the gas IS the USDC being paid.
 *
 * Run:  ARC_CHAIN=testnet BUYER_KEY=0x… npx tsx examples/pay.ts [url]
 *
 * BUYER_KEY is read from the environment and never written anywhere by this script.
 */
import { payOnArc, toPaymentHeader } from "../src/client.js";
import { readPaymentRequired, selectArcRequirements } from "../src/challenge.js";

const url = process.argv[2] ?? "http://localhost:8402/api/price";
const chain = (process.env.ARC_CHAIN === "mainnet" ? "mainnet" : "testnet") as "mainnet" | "testnet";
const rawKey = process.env.BUYER_KEY?.trim();
if (!rawKey) {
  console.error("BUYER_KEY=0x… is required (a key holding USDC on Arc)");
  process.exit(1);
}
// Accept the key with or without the 0x prefix — .env files carry both spellings.
const key = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("BUYER_KEY is not a 32-byte hex private key");
  process.exit(1);
}

const first = await fetch(url);
if (first.status !== 402) {
  console.error(`expected 402, got ${first.status}`);
  process.exit(1);
}
const challenge = await readPaymentRequired(first);
if (!challenge) {
  console.error("the 402 carries no challenge (neither body nor `payment-required` header)");
  process.exit(1);
}
const requirements = selectArcRequirements(challenge, chain);
if (!requirements) {
  console.error(`no Arc ${chain} option in the 402 (offered: ${challenge.accepts.map((a) => a.network).join(", ")})`);
  process.exit(1);
}

const human = (Number(requirements.amount) / 1e6).toFixed(6);
console.log(`402 → paying ${human} USDC to ${requirements.payTo} on Arc ${chain}`);

const payment = await payOnArc({ privateKey: key, requirements, chain });
console.log(`paid: ${payment.transaction}`);

// v2 servers read `payment-signature`; older/other adapters read `X-PAYMENT`. Send both — they
// carry the same value, so whichever the server looks at, it sees the same payment.
const payHeaders = (p: typeof payment) => {
  const h = toPaymentHeader(p, requirements, String(requirements.extra?.resource ?? url));
  return { "PAYMENT-SIGNATURE": h, "X-PAYMENT": h };
};

const paid = await fetch(url, {
  headers: payHeaders(payment),
});
console.log(`retry → HTTP ${paid.status}`);
console.log(await paid.text());

// Presenting the SAME payment again must fail: the authorization is spent.
const replay = await fetch(url, { headers: payHeaders(payment) });
console.log(`replay of the same payment → HTTP ${replay.status} (402 expected)`);
console.log(await replay.text());
