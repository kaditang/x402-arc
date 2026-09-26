# Proposed spec sections: `eip3009-client-broadcast`

Draft text for [`specs/schemes/exact/scheme_exact_evm.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md),
written against [x402#3504](https://github.com/x402-foundation/x402/issues/3504).

It contains three things:

1. an amendment to **§Summary** that makes `assetTransferMethod` load-bearing for payers;
2. a new **§4. AssetTransferMethod: `eip3009-client-broadcast`**;
3. **Annex** additions, and answers to the two questions left open in the issue.

Every normative rule below is one an implementation already enforces
([`x402-arc`](https://github.com/kaditang/x402-arc), MIT), and the failure each rule prevents has been
reproduced on Arc mainnet rather than reasoned about.

---

## 1. Amendment to §Summary

> **Rationale.** The table gains a fourth row, and the paragraph after it gains one sentence. The
> sentence is the important part: today a payer cannot tell two accepts apart when one of them is not
> payable by the default method, and the resulting failure looks like the seller's fault.

Replace the table with:

| AssetTransferMethod | Use Case | Recommendation | Usage Semantics |
| :------------------ | :------- | :------------- | :-------------- |
| **1. EIP-3009** | Tokens with native `transferWithAuthorization` (e.g., USDC). | **Recommended** (Simplest, truly gasless). | One-time use |
| **2. Permit2** | Tokens without EIP-3009. Uses a Proxy + Permit2. | **Universal Fallback** (Works for any ERC-20). | One-time use |
| **3. ERC-7710** | Smart accounts with delegation support. | **Smart Account Option** (Paid from ERC-7710 compatible account). | One-time use and multi-use |
| **4. EIP-3009 (client-broadcast)** | Networks where the gas token *is* the payment asset and no facilitator broadcasts (e.g. Arc). | **Facilitator-free option** (the payer broadcasts and pays its own gas). | One-time use |

Replace the paragraph that follows with:

> If no `assetTransferMethod` is specified in `PaymentRequired.extra`, clients MUST interpret the
> accept as `"eip3009"`. A `PaymentRequired.accepts` entry that **cannot** be settled by the default
> method MUST declare its `assetTransferMethod`; omitting it makes the accept indistinguishable from
> an `eip3009` accept, and a conforming payer will construct an `eip3009` authorization for it and be
> rejected. Payment payloads that use a non-default transfer method MUST echo the selected
> `assetTransferMethod` in `accepted.extra`.
>
> In all cases the Facilitator cannot modify the amount or destination. Under methods 1–3 it serves as
> the transaction broadcaster; under method 4 there is no broadcaster other than the payer itself.

**Why the MUST matters.** A buyer-side observatory reported on 2026-09-20 that its catalog held 981
accepts whose `extra` names a batched-settlement contract while declaring bare `"scheme": "exact"`
with no `assetTransferMethod`, across 84 hosts. Their payer cannot distinguish those from ordinary
EIP-3009 accepts except by matching a vendor's contract name in `extra.name`, which is not a protocol
field. With three transfer methods already defined and a fourth proposed here, a discriminator that is
optional in practice is a discriminator that does not work.

---

## 2. New section

### 4. AssetTransferMethod: `eip3009-client-broadcast`

On most networks the facilitator exists because the payer holds the payment asset but not the gas
asset. On a network whose **gas token is the payment asset** — Arc, where USDC pays for gas — that
reason disappears: the payer can broadcast its own `transferWithAuthorization` and pay the gas out of
the same balance the payment comes from.

This method covers that case. The payer settles on chain **before** presenting payment, and the
resource server's task is reduced to deciding whether a given transaction paid this request.

It is a fourth row rather than a new scheme because the `exact` semantics are unchanged: a
one-time-use authorization for an exact amount to an exact recipient, which the recipient cannot
alter. Only the broadcaster changes.

> **This method does not replace a facilitator where one exists.** If a facilitator settles plain
> `eip3009` on the network in question, prefer method 1: the payer spends no gas and needs no
> network-specific code. Declare this method when no facilitator available to your payers covers the
> network — which is the situation this method was written for, and which can change under you.

#### Phase 1: `PAYMENT-SIGNATURE` Header Payload

The payer:

1. derives the authorization `nonce` (below), which binds the payment to this offer;
2. signs `transferWithAuthorization` against the token's EIP-712 domain;
3. **broadcasts it itself** and waits for the receipt;
4. presents the transaction hash and the freshness value it chose.

The `payload` field MUST contain:

- `transaction`: the 32-byte hash of the broadcast `transferWithAuthorization` transaction.
- `clientNonce`: the payer's freshness value, 4–32 bytes, lowercase hex without `0x`.

The `payload` MAY contain:

- `nonce`: the EIP-3009 nonce the payer used. When present the verifier MUST check it against its own
  derivation and reject on mismatch. It is a convenience for debugging, never an input to verification.

No `signature` field is carried: the signature has already been consumed on chain, and the receipt —
not the header — is the evidence.

**Example PaymentPayload:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:5042",
    "amount": "30000",
    "asset": "0x3600000000000000000000000000000000000000",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "eip3009-client-broadcast",
      "name": "USDC",
      "version": "2",
      "resource": "https://api.example.com/premium-data",
      "confirmations": 1,
      "maxReceiptAgeSeconds": 600
    }
  },
  "payload": {
    "transaction": "0xa33aa96f529bb9d8ef399dc1c73fa94b21f13314f0384e7e52c434535d31487e",
    "clientNonce": "9f2c4d1ab7e35608f1a0c4d29e7b5531"
  }
}
```

**`extra` field definitions specific to `eip3009-client-broadcast`:**

- `extra.assetTransferMethod` (**required**): MUST be `"eip3009-client-broadcast"`. Unlike method 1
  this cannot be defaulted, because a payer that assumes `eip3009` would hand the authorization to a
  facilitator that will not broadcast it on this network.
- `extra.name` (required): the EIP-712 domain name of the token contract.
- `extra.version` (required): the EIP-712 domain version of the token contract.
- `extra.resource` (optional): the canonical resource URL this offer is for, used in the nonce
  binding. See *Resource binding* below for what is lost when it is omitted.
- `extra.confirmations` (optional, default `1`): the confirmation depth the verifier requires.
- `extra.maxReceiptAgeSeconds` (optional, default `600`): how old a receipt may be when presented.

**Nonce derivation.**

The EIP-3009 nonce MUST be:

```
nonce = SHA-256( "x402/exact/eip3009-client-broadcast/v1" || 0x1f || binding || 0x1f || clientNonce )

binding = UTF-8 of the JSON array, no insignificant whitespace:
          [network, asset, payTo, amount, resource]

  network   accepted.network                      verbatim
  asset     accepted.asset                        lowercased
  payTo     accepted.payTo                        lowercased
  amount    accepted.amount                       verbatim, decimal string, atomic units
  resource  accepted.extra.resource, or ""        verbatim
  clientNonce  payload.clientNonce                lowercased hex, no 0x
```

**Test vector.** Implementations SHOULD check against this before interoperating:

```
network      eip155:5042
asset        0x3600000000000000000000000000000000000000
payTo        0x209693Bc6afc0C5328bA36FaF03C514EF312287C
amount       30000
resource     https://api.example.com/premium-data
clientNonce  9f2c4d1ab7e35608f1a0c4d29e7b5531

binding      ["eip155:5042","0x3600000000000000000000000000000000000000",
              "0x209693bc6afc0c5328ba36faf03c514ef312287c","30000",
              "https://api.example.com/premium-data"]        (no whitespace, addresses lowercased)

nonce        0x61e3a41ebc30332be5ed1c6cce7e7a2a625277ea21289708afaaf5b522b447e6
```

Both sides derive it independently; it is never transmitted as an authority. The verifier MUST derive
the binding from **its own** `PaymentRequirements`, never from `accepted` as echoed by the payer, and
never from `resource` as carried in the payload — those are the fields an attacker would otherwise
choose. A payment made for a different price, payee, asset, network or resource simply does not
produce the nonce the verifier expects.

> **Why the payer supplies the freshness.** The digest MUST include a value chosen per payment, and
> that value MUST NOT travel in `PaymentRequired.extra`.
>
> EIP-3009 nonces are single-use: the token records `authorizationState(authorizer, nonce)` and
> rejects a repeat. A nonce derived from the requirements alone is therefore the *same* nonce every
> time, so a payer can buy a given resource at a given price **exactly once, ever** — the second
> purchase reverts with `authorization is used or canceled`. This is the normal shape of x402 traffic,
> not an edge case: in one production deployment a single buyer called one route at one price 658
> times.
>
> Server-minted freshness does not work either, and the reason is structural rather than a quirk of
> one implementation: a resource server **rebuilds** its `PaymentRequirements` when verifying, and
> implementations match the rebuilt requirements against the payer's echoed `accepted` — an `extra`
> that differs per request makes every valid payment unmatchable, and the failure surfaces as *"no
> matching requirements"*, pointing nowhere near the nonce.
>
> A value the payer picks satisfies both constraints: fresh per payment, and absent from the offer.

**Resource binding.** When `extra.resource` is omitted the binding covers
`(network, asset, payTo, amount)` only, and an authorization minted for one resource can settle a
**different resource of the same price and payee**. Nobody is underpaid, and for a seller whose
endpoints are interchangeable at a given price this is acceptable; a seller whose $0.03 endpoints are
not interchangeable MUST set `extra.resource`.

#### Phase 2: Verification Logic

Verification is receipt inspection. Given `payload.transaction`, the verifier:

1. **Fetches** the transaction receipt. A receipt that is absent or has no block is *not yet* payment.
2. **Verifies** `status == 0x1`. A reverted transaction still has a hash.
3. **Locates** an `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` log where
   `log.address == accepted.asset` and the nonce topic equals the derived nonce. The `authorizer`
   topic is the payer.
4. **Locates** a `Transfer(address indexed from, address indexed to, uint256 value)` log where
   `log.address == accepted.asset`, `from == authorizer`, `to == accepted.payTo`, and
   `value >= accepted.amount`. A **single** log MUST satisfy the amount; values from several logs MUST
   NOT be summed.
5. **Verifies** the confirmation depth is at least `extra.confirmations`.
6. **Verifies** the receipt's block timestamp is within `extra.maxReceiptAgeSeconds`, and is not in the
   future beyond a small clock-skew allowance.
7. **Claims** the nonce as spent — see *Claim ordering*, which is normative.

The verify response SHOULD carry `payer` set to the `authorizer` address. Under methods 1–3 the payer
is in the header; here it exists only in the receipt, and a server that does not surface it can only
record that *someone* on this network paid.

> **`log.address` is not optional, and this is where implementations will fail.** On Arc every payment
> emits **two** `Transfer` logs with identical topics: the ERC-20 one from the USDC predeploy
> (6 decimals) and a native-balance mirror from the system address
> `0xfffffffffffffffffffffffffffffffffffffffe` carrying the same amount **scaled by 10¹²**, which
> appears **first** in the receipt. A verifier that matches `Transfer` by topic alone and takes the
> largest value will accept `0.000001 USDC` as payment for anything up to a million dollars.
>
> Verified on a real payment: [`0xa33aa96f…`](https://explorer.arc.io/tx/0xa33aa96f529bb9d8ef399dc1c73fa94b21f13314f0384e7e52c434535d31487e),
> and independently reproduced by the proposal's author on the same receipt.

**Claim ordering.** The verifier MUST record the nonce as spent **before the resource is served**, and
MUST reject a payload whose nonce is already recorded.

This is stated normatively because the obvious place to put it does not work. Implementations settle
*after* the handler — settlement is what marks a payment consumed under methods 1–3, where it is also
what moves the money. Here the money moved before the request arrived, so a claim deferred to
settlement lets a replayed transaction **execute the request** and be rejected only afterwards: the
payer correctly receives a 402 while the server has already done the work, every time, for free.
Reproduced on a live deployment: one payment, replayed, produced a second full handler run before the
rejection.

#### Phase 3: Settlement Logic

There is nothing to broadcast. Settlement is an accounting step: the verifier confirms the claim made
during verification and marks it settled, then returns `transaction` set to the hash it verified and
`payer` set to the authorizer.

Claiming and settling MUST be distinct states. With the claim taken at verification, settlement
observes its own earlier claim and must accept it — so without a separate settled state, a caller that
settles without verifying first can settle the same payment twice.

#### Security Considerations

1. **Replay is bounded by state the server keeps, not by the chain.** The chain prevents the
   *authorization* being used twice; only the server can prevent the resulting *transaction hash*
   being presented twice. A verifier MUST keep spent nonces for at least
   `extra.maxReceiptAgeSeconds`, and `maxReceiptAgeSeconds` is what makes that retention finite.

2. **Process-local state is not enough.** Across several instances, or across a restart, an in-memory
   record is empty while a receipt may still be inside its age window — one replay per instance, or
   one replay per restart, is possible. Deployments that cannot tolerate that MUST back the store with
   shared storage (a unique constraint is sufficient).

3. **The payer pays before it is served.** Under methods 1–3 a failed handler means no settlement and
   the payer keeps its money. Here the transfer is already final when the request arrives, so a 5xx
   costs the payer the payment. Sellers SHOULD document their refund policy; payers SHOULD prefer
   method 1 where it is available.

4. **The verifier's RPC is a public amplification surface.** Verification is triggered by a
   caller-supplied hash, so an unauthenticated stranger can make the verifier call an upstream node by
   sending nonsense. Verifiers SHOULD cache receipt lookups — including misses, which is what blunts a
   flood of invented hashes — single-flight concurrent lookups of the same hash, and cap upstream
   calls per interval, failing closed with a retryable error rather than skipping verification.

5. **Gas is a real cost to the payer, and it is not a constant.** The payer pays the broadcast, so this
   method is uneconomic for very small payments. On Arc a payment costs ~112,500 gas; at 20 gwei that
   is ~0.00225 USDC, which is 7.5% of a $0.03 call and 75% of a $0.003 one. The network's base fee was
   80–200 gwei at launch and 20 gwei two weeks later, so the floor moves with it — sellers SHOULD
   measure before deciding which prices to offer this method on, and MUST NOT treat any published
   figure as fixed.

---

## 3. Annex addition

### Networks where the gas token is the payment asset

**Arc** (`eip155:5042`, testnet `eip155:5042002`) settles gas in USDC. The USDC predeploy at
`0x3600000000000000000000000000000000000000` is a standard FiatTokenV2: EIP-712 domain name `USDC`,
version `2`, **6 decimals through the ERC-20 interface**, while the same balance is **18 decimals** as
the native gas token. Payment amounts are always the 6-decimal view.

Every payment additionally emits a native-balance mirror `Transfer` from
`0xfffffffffffffffffffffffffffffffffffffffe` with the amount scaled by 10¹² — see Phase 2.

Arc reaches deterministic finality, so `confirmations: 1` is genuinely final. On a network with
probabilistic finality a seller offering this method SHOULD declare a depth that reflects it.

---

## 4. The two questions left open in the issue

**"A fourth row in the EVM table, or a separate scheme?"** — A fourth row. The `exact` guarantees are
untouched: an exact amount, an exact recipient, a one-time-use authorization, and a recipient who
cannot alter either. Only the broadcaster differs, which is what `assetTransferMethod` exists to
express. A separate scheme would also split the Bazaar catalog and every payer's selection logic along
a line that does not correspond to anything a payer cares about.

**"How should confirmation depth be specified per network?"** — By the seller, in the offer, as
`extra.confirmations` with a default of `1`, rather than by a table of networks in the specification.
The verifier is the party bearing the risk of an unconfirmed payment, the value it needs depends on
its own tolerance as much as on the chain, and a per-network table in the spec would be a second place
to update every time a network changes its finality properties. `extra.maxReceiptAgeSeconds` follows
the same reasoning.

---

## Provenance

Reference implementation: [`x402-arc`](https://github.com/kaditang/x402-arc) (MIT, `npm i x402-arc`),
running in production on Arc mainnet. Every rule marked normative above is enforced there and covered
by tests, including the mirror-log case, the replay-before-handler case, and the double-settle case.
