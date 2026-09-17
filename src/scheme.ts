/**
 * ArcExactScheme — the server side of the `exact` scheme on Arc.
 *
 * Two jobs: turn a price into 6-decimal USDC, and attach the challenge (seed + derived nonce) to the
 * 402 response so the buyer can build an authorization the facilitator will accept.
 */
import { ARC, ARC_USDC, ARC_USDC_DECIMALS, ARC_USDC_EIP712, ASSET_TRANSFER_METHOD } from "./constants.js";
import { mintSeed, nonceFor, type NonceBinding } from "./nonce.js";
import type { AssetAmount, Money, Network, PaymentFlowConfig, PaymentRequirements, Price, SupportedKind } from "./types.js";

export type ArcSchemeOptions = {
  chain?: "mainnet" | "testnet";
  /** See ArcFacilitatorOptions.challengeMode. Default `client-nonce`. */
  challengeMode?: "client-nonce" | "seed";
  /** Must match the facilitator's secret. Required only in seed mode. */
  secret?: string;
  /** How long a 402 challenge stays payable. */
  challengeTtlSec?: number;
  asset?: string;
};

/**
 * Decimal money → atomic units, with string math only.
 *
 * Rounds UP at the 7th decimal: `$0.0000001` becomes 1 atomic unit, not 0. Floats and truncation both
 * fail the same way here — silently charging less than the price, or nothing at all.
 */
export function toAtomicUsdc(money: Money, decimals = ARC_USDC_DECIMALS): string {
  const raw = typeof money === "number" ? String(money) : money.trim();
  const s = raw.replace(/^\$/, "").replace(/\s+/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`price "${raw}" is not a plain decimal amount (exponent notation is not accepted)`);
  }
  const [whole, frac = ""] = s.split(".");
  const padded = frac.padEnd(decimals, "0");
  let atomic = BigInt(whole + padded.slice(0, decimals));
  if (/[1-9]/.test(padded.slice(decimals))) atomic += 1n; // never undercharge
  return atomic.toString();
}

export class ArcExactScheme {
  readonly scheme = "exact" as const;

  /** What a client should assume when `requirements.extra.assetTransferMethod` is absent. */
  readonly defaultAssetTransferMethod = ASSET_TRANSFER_METHOD;

  /**
   * `upfront`, and deliberately not `authorization`.
   *
   * In the standard EVM flow the server holds a signed authorization and submits it AFTER serving the
   * response. Here the money has already moved before we ever see the request — so the only thing left
   * to do, claiming the authorization so it cannot be presented twice, must happen BEFORE the handler
   * runs. Settling afterwards would mean a double-spend is detected only once the response has been
   * given away.
   */
  readonly paymentFlows: Readonly<Record<string, PaymentFlowConfig>> = {
    [ASSET_TRANSFER_METHOD]: { supported: ["upfront"], default: "upfront" },
  };

  readonly network: Network;
  private readonly chainId: number;
  private readonly asset: string;
  private readonly secret: string;
  private readonly challengeMode: "client-nonce" | "seed";
  private readonly ttlSec: number;

  constructor(opts: ArcSchemeOptions) {
    const chain = ARC[opts.chain ?? "mainnet"];
    this.challengeMode = opts.challengeMode ?? "client-nonce";
    if (this.challengeMode === "seed" && !opts.secret) {
      throw new Error("ArcExactScheme: `secret` is required in seed mode");
    }
    this.network = chain.network;
    this.chainId = chain.chainId;
    this.asset = opts.asset ?? ARC_USDC;
    this.secret = opts.secret ?? "";
    this.ttlSec = opts.challengeTtlSec ?? 300;
  }

  getAssetDecimals(_asset?: string, _network?: Network): number {
    return ARC_USDC_DECIMALS;
  }

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) return price;
    return {
      asset: this.asset,
      amount: toAtomicUsdc(price as Money),
      extra: { decimals: ARC_USDC_DECIMALS, ...ARC_USDC_EIP712 },
    };
  }

  /**
   * Attach the challenge. The seed is fresh per 402 — that is what lets the same buyer buy the same
   * thing twice (see nonce.ts), and what bounds how long an unused challenge stays payable.
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind?: SupportedKind,
    _facilitatorExtensions?: string[],
  ): Promise<PaymentRequirements> {
    const binding: NonceBinding = {
      network: requirements.network,
      asset: requirements.asset,
      payTo: requirements.payTo,
      amount: requirements.amount,
      resource: typeof requirements.extra?.resource === "string" ? (requirements.extra.resource as string) : "",
    };
    // STATIC fields only in client-nonce mode. x402 servers rebuild these requirements when verifying
    // and match the rebuilt `extra` against the client's echo, so a per-request value here (a seed, an
    // expiry) makes every valid payment unmatchable. That is not a style preference — it is why this
    // mode exists (see nonce.ts).
    const staticExtra = {
      ...requirements.extra,
      assetTransferMethod: ASSET_TRANSFER_METHOD,
      chainId: this.chainId,
      verifyingContract: this.asset,
      eip712: ARC_USDC_EIP712,
      decimals: ARC_USDC_DECIMALS,
    };
    if (this.challengeMode === "client-nonce") {
      return { ...requirements, extra: staticExtra };
    }
    const seed = mintSeed(this.secret, binding, this.ttlSec);
    return {
      ...requirements,
      extra: {
        ...staticExtra,
        seed,
        // Convenience for clients; the facilitator re-derives it and never trusts this value.
        nonce: nonceFor(seed, binding),
        expiresAtSec: Math.floor(Date.now() / 1000) + this.ttlSec,
      },
    };
  }
}
