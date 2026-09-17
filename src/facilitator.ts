/**
 * ArcLocalFacilitator — a FacilitatorClient that settles x402 payments on Arc with no facilitator
 * service at all.
 *
 * On Arc, gas IS USDC, so the buyer can broadcast its own EIP-3009 `transferWithAuthorization` and
 * pay for the gas out of the same balance. Nobody needs to sponsor anything; the server's job shrinks
 * to checking that a transaction really paid this request. @x402/core's own interface documents that
 * a FacilitatorClient "can be implemented for HTTP-based or local facilitators" — this is the local
 * one, so it plugs into an existing x402 server beside the Base/Solana rails instead of replacing
 * them (registration is per network).
 *
 * Verification lives in receipt.ts (pure), replay protection in store.ts, upstream protection in
 * rpc.ts. This file is the wiring and the policy.
 */
import { ARC, ARC_USDC, ARC_USDC_DECIMALS, ARC_USDC_EIP712, ASSET_TRANSFER_METHOD } from "./constants.js";
import { clientNonceFor, nonceFor, verifySeed, type NonceBinding } from "./nonce.js";
import { checkPaidReceipt } from "./receipt.js";
import { ArcRpc, RpcBudgetExceeded } from "./rpc.js";
import { MemorySpentStore, type SpentStore } from "./store.js";
import type {
  ArcPaymentPayload,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "./types.js";

export type ArcFacilitatorOptions = {
  /** Which Arc network. Default: mainnet. */
  chain?: "mainnet" | "testnet";
  /**
   * How the per-payment nonce is established. Default `client-nonce`, which is the only mode that
   * works against @x402/core 2.13 (see nonce.ts). `seed` additionally authenticates the challenge and
   * gives it an expiry, but requires a server that does not re-match a rebuilt `extra`.
   * `either` accepts both and is therefore only as strong as `client-nonce`.
   */
  challengeMode?: "client-nonce" | "seed" | "either";
  /** Secret for seed mode. Required only when seeds are accepted. */
  secret?: string;
  rpcUrl?: string;
  asset?: string;
  /** Arc has deterministic (BFT) finality, so 1 is genuinely final. */
  minConfirmations?: number;
  /** How old a receipt may be when presented. Also bounds how long the spent store must remember. */
  maxReceiptAgeSec?: number;
  /**
   * WHEN the payment is claimed as spent.
   *
   * `verify` (default) — during verification, which on a real x402 server runs BEFORE the handler.
   * This matters more than it sounds: @x402/core settles AFTER the handler, so with `settle` a
   * replayed payment still EXECUTES the handler (upstream calls, rate budget, metrics) and is only
   * rejected afterwards. Measured on a live server: one paid call, replayed, produced a second full
   * handler run and a second "paid" metrics row, while the buyer correctly got a 402.
   *
   * `settle` — claim at settlement. Correct only where settlement precedes the handler.
   */
  claimOn?: "verify" | "settle";
  store?: SpentStore;
  rpc?: ArcRpc;
  now?: () => number;
};

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export class ArcLocalFacilitator {
  readonly network: Network;
  private readonly chainId: number;
  private readonly asset: string;
  private readonly secret: string;
  private readonly challengeMode: "client-nonce" | "seed" | "either";
  private readonly minConfirmations: number;
  private readonly maxReceiptAgeSec: number;
  private readonly store: SpentStore;
  private readonly claimOn: "verify" | "settle";
  private readonly rpc: ArcRpc;
  private readonly now: () => number;

  constructor(opts: ArcFacilitatorOptions) {
    const chain = ARC[opts.chain ?? "mainnet"];
    this.challengeMode = opts.challengeMode ?? "client-nonce";
    if (this.challengeMode !== "client-nonce" && !opts.secret) {
      throw new Error("ArcLocalFacilitator: `secret` is required when seeds are accepted");
    }
    this.network = chain.network;
    this.chainId = chain.chainId;
    this.asset = (opts.asset ?? ARC_USDC).toLowerCase();
    this.secret = opts.secret ?? "";
    this.minConfirmations = opts.minConfirmations ?? 1;
    this.maxReceiptAgeSec = opts.maxReceiptAgeSec ?? 600;
    this.store = opts.store ?? new MemorySpentStore();
    this.claimOn = opts.claimOn ?? "verify";
    if (this.claimOn === "verify" && (typeof this.store.claim !== "function" || typeof this.store.markSettled !== "function")) {
      throw new Error("ArcLocalFacilitator: claimOn:'verify' needs a store implementing claim() and markSettled()");
    }
    this.rpc = opts.rpc ?? new ArcRpc({ url: opts.rpcUrl ?? chain.rpcUrl });
    this.now = opts.now ?? (() => Date.now());
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: this.network,
          extra: {
            assetTransferMethod: ASSET_TRANSFER_METHOD,
            asset: this.asset,
            decimals: ARC_USDC_DECIMALS,
            chainId: this.chainId,
            eip712: ARC_USDC_EIP712,
            minConfirmations: this.minConfirmations,
          },
        },
      ],
      extensions: [],
      signers: {},
    };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const checked = await this.check(payload, requirements);
    if (!checked.ok) {
      return { isValid: false, invalidReason: checked.reason, invalidMessage: checked.message };
    }
    if (this.claimOn === "verify") {
      let state: "new" | "same" | "conflict";
      try {
        state = await this.store.claim!(checked.nonce, checked.transaction, this.maxReceiptAgeSec + 60);
      } catch (e) {
        return {
          isValid: false,
          invalidReason: "store_unavailable",
          invalidMessage: e instanceof Error ? e.message : "spent store failed",
        };
      }
      if (state !== "new") {
        // "same" is a REPLAY: one verification per request is the contract, so a second verification
        // of the same transaction is someone presenting a receipt they already used.
        return {
          isValid: false,
          invalidReason: "authorization_already_spent",
          invalidMessage: "this payment has already been used",
        };
      }
    }
    return {
      isValid: true,
      payer: checked.payer,
      extra: {
        transaction: checked.transaction,
        blockNumber: checked.blockNumber,
        confirmations: checked.confirmations,
        amountPaid: checked.amountPaid.toString(),
      },
    };
  }

  /**
   * Settle = verify again, then claim the authorization.
   *
   * Deliberately NOT "trust that verify() already ran": a caller can invoke settle() directly, and a
   * settle path that skips verification is a free-service bug waiting to happen. The claim happens
   * here and only here, so a payment can be verified any number of times but spent once.
   */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const txHash = String((payload?.payload as ArcPaymentPayload | undefined)?.transaction ?? "");
    const checked = await this.check(payload, requirements);
    if (!checked.ok) {
      return {
        success: false,
        errorReason: checked.reason,
        errorMessage: checked.message,
        transaction: txHash,
        network: this.network,
      };
    }
    let claimed = false;
    try {
      // TTL only needs to outlive the window in which the receipt is presentable at all.
      if (this.claimOn === "verify") {
        // verify() already claimed it for this transaction; "same" is precisely the expected state.
        // "new" means settle was reached without a verify (a direct call) — claim it now rather than
        // letting an unverified path settle for free.
        const state = await this.store.claim!(checked.nonce, checked.transaction, this.maxReceiptAgeSec + 60);
        // "same" is this request's own verify. "new" means settle was reached without one. Either is
        // fine to settle ONCE — markSettled is what makes it once.
        claimed = state !== "conflict" && (await this.store.markSettled!(checked.nonce));
      } else {
        claimed = await this.store.reserve(checked.nonce, this.maxReceiptAgeSec + 60);
      }
    } catch (e) {
      return {
        success: false,
        errorReason: "store_unavailable",
        errorMessage: e instanceof Error ? e.message : "spent store failed",
        transaction: checked.transaction,
        network: this.network,
      };
    }
    if (!claimed) {
      return {
        success: false,
        errorReason: "authorization_already_spent",
        errorMessage: "this payment has already been used",
        transaction: checked.transaction,
        network: this.network,
        payer: checked.payer,
      };
    }
    return {
      success: true,
      payer: checked.payer,
      transaction: checked.transaction,
      network: this.network,
      amount: checked.amountPaid.toString(),
    };
  }

  /** Everything both verify() and settle() need, in one place so they cannot diverge. */
  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<
    | { ok: true; payer: string; transaction: string; nonce: string; amountPaid: bigint; blockNumber: number; confirmations: number }
    | { ok: false; reason: string; message: string }
  > {
    const bad = (reason: string, message: string) => ({ ok: false as const, reason, message });

    if (!requirements || requirements.scheme !== "exact") return bad("unsupported_scheme", "scheme must be `exact`");
    if (requirements.network !== this.network) return bad("unsupported_network", "wrong network for this facilitator");
    if ((requirements.asset ?? "").toLowerCase() !== this.asset) return bad("unsupported_asset", "payment asset is not Arc USDC");
    if (!requirements.payTo) return bad("invalid_requirements", "no payment address");

    let amount: bigint;
    try {
      amount = BigInt(requirements.amount);
    } catch {
      return bad("invalid_requirements", "price is not an integer amount of atomic units");
    }
    if (amount <= 0n) return bad("invalid_requirements", "price must be positive");

    const body = (payload?.payload ?? {}) as ArcPaymentPayload;
    const txHash = String(body.transaction ?? "");
    if (!HASH_RE.test(txHash)) return bad("invalid_payload", "`transaction` must be a 32-byte tx hash");
    const binding = this.bindingFor(requirements, payload);

    // Which nonce does THIS challenge require? Both modes derive it from server-side requirements;
    // they differ only in where the per-payment freshness comes from.
    let nonce: string;
    const hasClientNonce = typeof body.clientNonce === "string" && body.clientNonce.length > 0;
    if (hasClientNonce && this.challengeMode !== "seed") {
      try {
        nonce = clientNonceFor(String(body.clientNonce), binding);
      } catch {
        return bad("invalid_payload", "`clientNonce` must be 4-32 bytes of hex");
      }
    } else if (!hasClientNonce && this.challengeMode !== "client-nonce") {
      const seedCheck = verifySeed(this.secret, String(body.seed ?? ""), binding, this.now());
      if (!seedCheck.ok) {
        return bad(seedCheck.reason, "the payment challenge is missing, altered or expired");
      }
      nonce = nonceFor(String(body.seed), binding);
    } else {
      return bad(
        "invalid_payload",
        this.challengeMode === "seed" ? "this server requires a seed challenge" : "`clientNonce` is required",
      );
    }
    if (body.nonce && String(body.nonce).toLowerCase() !== nonce.toLowerCase()) {
      return bad("nonce_mismatch", "the nonce does not match this challenge");
    }

    let receipt, tip, blockTimestampSec;
    try {
      receipt = await this.rpc.getReceipt(txHash);
      if (!receipt) return bad("payment_not_found", "no such transaction on Arc (or not mined yet)");
      tip = await this.rpc.getTipBlockNumber();
      blockTimestampSec = await this.rpc.getBlockTimestampSec(receipt.blockNumber);
    } catch (e) {
      if (e instanceof RpcBudgetExceeded) return bad("verification_unavailable", "payment verification is rate limited; retry shortly");
      return bad("verification_unavailable", e instanceof Error ? e.message : "Arc RPC failed");
    }

    const result = checkPaidReceipt(
      {
        receipt,
        blockTimestampSec,
        tipBlockNumber: tip,
        nowMs: this.now(),
        minConfirmations: this.minConfirmations,
        maxReceiptAgeSec: this.maxReceiptAgeSec,
      },
      { asset: this.asset, payTo: requirements.payTo, amount, nonce },
    );
    if (!result.ok) return bad(result.reason, result.message);

    return {
      ok: true,
      payer: result.payer,
      transaction: receipt.transactionHash ?? txHash,
      nonce,
      amountPaid: result.amountPaid,
      blockNumber: result.blockNumber,
      confirmations: result.confirmations,
    };
  }

  /**
   * What the nonce is bound to.
   *
   * Money fields come from the SERVER's requirements, never from the payload — those are the fields an
   * attacker would want to lie about.
   *
   * `resource` comes ONLY from `requirements.extra.resource`, which the server controls. x402 v2 moved
   * the resource URL out of PaymentRequirements, and the copy in the payload is written by the buyer —
   * binding to that would bind to nothing, and (worse) the buyer and the server would derive different
   * nonces whenever they disagreed about it, rejecting perfectly valid payments.
   *
   * So when the integrator does not set `extra.resource`, the binding covers (network, asset, payTo,
   * amount) only, and the consequence is worth stating plainly: a challenge for one endpoint can
   * settle a DIFFERENT endpoint with the SAME price and payee. The buyer still paid the right price,
   * so nobody is underpaid — set `extra.resource` (as this package's scheme passes through) for
   * per-route binding.
   */
  private bindingFor(requirements: PaymentRequirements, _payload: PaymentPayload): NonceBinding {
    const resource =
      typeof requirements.extra?.resource === "string" ? (requirements.extra.resource as string) : "";
    return {
      network: requirements.network,
      asset: requirements.asset,
      payTo: requirements.payTo,
      amount: requirements.amount,
      resource,
    };
  }
}
