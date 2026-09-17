/**
 * A complete x402 server on Arc, in one file and with no framework.
 *
 * GET /api/price              → 402 with a payable challenge
 * GET /api/price + X-PAYMENT  → 200, once the payment is verified and claimed on Arc
 *
 * Run:  ARC_CHAIN=testnet PAY_TO=0x… ARC_SECRET=… npx tsx examples/server.ts
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { ArcExactScheme, ArcLocalFacilitator, ARC, ARC_USDC } from "../src/index.js";
import type { PaymentPayload, PaymentRequirements } from "../src/types.js";

const chain = (process.env.ARC_CHAIN === "mainnet" ? "mainnet" : "testnet") as "mainnet" | "testnet";
const payTo = process.env.PAY_TO;
const price = process.env.PRICE ?? "$0.01";
const port = Number(process.env.PORT ?? 8402);
// A random secret per boot is fine for a demo: it only invalidates unpaid challenges on restart.
// In production this is a stable secret, and it is the ONE value that must match between the scheme
// and the facilitator.
const secret = process.env.ARC_SECRET ?? randomBytes(32).toString("hex");

if (!payTo) {
  console.error("PAY_TO=<your wallet> is required");
  process.exit(1);
}

const scheme = new ArcExactScheme({ chain, secret });
const facilitator = new ArcLocalFacilitator({ chain, secret });
const RESOURCE = `http://localhost:${port}/api/price`;

async function challenge(): Promise<PaymentRequirements> {
  const { amount, asset } = await scheme.parsePrice(price, ARC[chain].network);
  return scheme.enhancePaymentRequirements({
    scheme: "exact",
    network: ARC[chain].network,
    asset: asset ?? ARC_USDC,
    amount,
    payTo: payTo!,
    maxTimeoutSeconds: 300,
    extra: { resource: RESOURCE },
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== "/api/price") {
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    return;
  }

  const header = req.headers["x-payment"];
  if (!header) {
    const accepts = await challenge();
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ x402Version: 2, resource: { url: RESOURCE }, accepts: [accepts] }, null, 2));
    return;
  }

  let payload: PaymentPayload;
  try {
    payload = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "X-PAYMENT is not valid base64 JSON" }));
    return;
  }

  // The requirements are rebuilt SERVER-SIDE (price, payee, network) — never taken from the payload.
  // Only the seed travels with the client, and it is MAC-checked against these same fields.
  const requirements = { ...(await challenge()), extra: { resource: RESOURCE } };

  // `upfront` flow: claim the payment BEFORE serving, so a double-spend cannot be discovered after
  // the answer has already been handed over.
  const settled = await facilitator.settle(payload, requirements);
  if (!settled.success) {
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: settled.errorReason, message: settled.errorMessage }, null, 2));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
    "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settled), "utf8").toString("base64"),
  });
  res.end(
    JSON.stringify(
      {
        paid: true,
        payer: settled.payer,
        amount: settled.amount,
        transaction: settled.transaction,
        explorer: `${ARC[chain].explorer}/tx/${settled.transaction}`,
        data: { answer: 42, note: "this response cost real USDC on Arc" },
      },
      null,
      2,
    ),
  );
}).listen(port, () => {
  console.log(`x402 server on Arc ${chain} → http://localhost:${port}/api/price  (${price} → ${payTo})`);
  console.log(`ARC_SECRET=${secret === process.env.ARC_SECRET ? "(from env)" : "(generated for this run)"}`);
});
