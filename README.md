# x402-arc

**Accept [x402](https://x402.org) payments on Circle's [Arc](https://arc.io) — with no facilitator.**

On Arc, gas *is* USDC. So the buyer can broadcast its own [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)
`transferWithAuthorization` and pay the gas from the same balance as the payment. Nobody needs to
sponsor anything, and the server's job shrinks to one question: *did this transaction pay this request?*

Working end to end on **Arc mainnet** and **Arc testnet** today.

| | |
|---|---|
| Mainnet payment | [`0x8b7869c2…`](https://explorer.arc.io/tx/0x8b7869c28f2e3027408410800f0c90df13f35c176ec0053ca9a43b96bbe4a4b6) |
| Testnet payment | [`0xba2d36e3…`](https://explorer.testnet.arc.io/tx/0xba2d36e307447a88645595407af5f652f6a149e2cf75f2bb0fbec8fc97fc97b1) |
| Tests | 38, no network required |
| Runtime dependencies (server) | none |

---

## The gap this fills

x402's `exact` scheme settles through a facilitator that broadcasts the buyer's EIP-3009 authorization
and sponsors the gas. On Arc, [no facilitator does this](https://github.com/x402-foundation/x402/issues/3504):
the one listed option is Circle Gateway, which assumes pre-deposited funds and a different contract
interface. So an x402 server on Arc has no settlement path — even though the chain itself is ready:

```
Arc mainnet   chain 5042 (0x13b2)   USDC predeploy 0x3600…0000   name "USDC" / version "2" / 6 decimals
```

Verified by signing an authorization and static-calling it: a **correct** signature reverts with
`ERC20: transfer amount exceeds balance` (accepted), a **tampered** one with
`FiatTokenV2: invalid signature`. The cryptography was never the blocker — only the broadcaster.

This package implements the `eip3009-client-broadcast` asset transfer method proposed in that issue,
with one correction (below), as a **local** `FacilitatorClient`: it plugs into an existing x402 server
next to the Base and Solana rails, because registration is per network.

## Install

```bash
npm install x402-arc
```

## Server

```ts
import { ArcExactScheme, ArcLocalFacilitator } from "x402-arc";

const secret = process.env.ARC_SECRET!;          // the one value both halves must share
const scheme      = new ArcExactScheme({ chain: "mainnet", secret });
const facilitator = new ArcLocalFacilitator({ chain: "mainnet", secret });

// 402 challenge
const accepts = await scheme.enhancePaymentRequirements({
  scheme: "exact", network: "eip155:5042", asset: ARC_USDC,
  amount: (await scheme.parsePrice("$0.03", "eip155:5042")).amount,
  payTo: YOUR_WALLET, maxTimeoutSeconds: 300,
  extra: { resource: "https://api.example.com/thing" },
});

// paid retry — claim BEFORE serving (see "upfront", below)
const settled = await facilitator.settle(payload, requirements);
if (!settled.success) return http402(settled.errorReason);
```

With `@x402/core` it is a one-line registration beside your existing rails:

```ts
new x402ResourceServer([cdpFacilitator, arcFacilitator])
  .register("eip155:8453", new ExactEvmScheme())   // Base, unchanged
  .register("eip155:5042", arcScheme);             // Arc, added
```

## Buyer

```ts
import { payOnArc, toPaymentHeader } from "x402-arc/client";

const payment = await payOnArc({ privateKey: KEY, requirements, chain: "mainnet" });
await fetch(url, { headers: { "X-PAYMENT": toPaymentHeader(payment, requirements) } });
```

Runnable demo: `examples/server.ts` + `examples/pay.ts`.

---

## The correction to proposal #3504

The proposal derives the EIP-3009 nonce as a **deterministic digest of the payment requirements**
(amount, asset, payTo, resource). EIP-3009 nonces are single-use — the token records
`authorizationState(authorizer, nonce)` — so a deterministic nonce lets a buyer pay for a given
resource at a given price **exactly once, ever**. Purchase #2 reverts with *"authorization is used or
canceled"*.

That is not an edge case. In one production x402 service, a single buyer called one route at one price
**658 times**.

**Fix:** the server mints a short-lived seed with each 402 challenge; the nonce binds the requirements
*and* that seed. The seed is an HMAC with an embedded expiry, so the server stays stateless — nothing
is remembered between challenge and payment — yet every challenge yields a fresh, unforgeable nonce.

## What the verifier checks

Each check exists because its absence is exploitable:

| Check | Without it |
|---|---|
| `status == 0x1` | a reverted transaction still has a hash |
| `log.address == USDC` | any contract can emit a convincing `Transfer` |
| recipient `== payTo` | someone else's payment pays for your resource |
| `value >= price`, single log | dust transfers add up to a purchase |
| nonce matches the challenge | a payment for something cheap buys something expensive |
| `Transfer.from == authorizer` | an unrelated transfer in the same block counts |
| confirmations, receipt age | stale or unmined receipts |
| spent store | one payment serves unlimited requests |

Replay across processes is the one thing a single-instance store cannot cover — behind several
instances, back `SpentStore` with Redis or a unique constraint.

## Two Arc traps

1. **10¹² between the two views of one balance.** USDC is 18 decimals as the gas token and 6 through
   the ERC-20 interface. Payment amounts are always the 6-decimal view.
2. **Every payment emits two `Transfer` events.** One from the USDC predeploy (6 decimals) and a
   native-balance mirror from the system address `0xff…fe` carrying the same amount × 10¹². Counting
   the mirror would let `0.000001 USDC` satisfy a price of up to a million dollars. Filtering on
   `log.address` is what prevents it; two regression tests pin it.

## Economics: measure before you ship

A payment costs **0.00226 USDC in gas**, measured on mainnet (112,519 gas).

| Price | Gas as a share |
|---|---|
| $0.003 | 75% |
| $0.01 | 23% |
| $0.03 | 7.5% |
| $0.50 | 0.5% |

Client-broadcast moves the gas cost onto the buyer, which is exactly what makes it possible without a
facilitator — and what makes it wrong for sub-cent payments. For true nanopayments on Arc, batching
(Circle Gateway) is the right rail; this package is for ordinary per-call pricing at roughly $0.03 and
up. If your price is a tenth of a cent, the honest answer is that this is not yet your rail.

## Status

Implements an **open, unratified** proposal (filed 2026-09-16, no maintainer decision yet). The
receipt-verification core does not depend on that outcome; the wire format may. Built against
`@x402/core` 2.26.0 — the compatibility assertions in `test/compat.test.ts` fail loudly if the
interfaces move.

## License

MIT
