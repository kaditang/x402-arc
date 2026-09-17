/**
 * Buyer side: sign an EIP-3009 authorization and broadcast it yourself.
 *
 * This is the half that makes Arc work without a facilitator. The buyer pays the gas — in USDC, out
 * of the same balance the payment comes from, because on Arc the gas token and the payment token are
 * one balance viewed at two precisions (18 decimals as gas, 6 through the ERC-20 interface).
 *
 * `viem` is an OPTIONAL peer dependency: importing this module requires it, the server modules do not.
 */
import { ARC, ARC_USDC, ARC_USDC_EIP712 } from "./constants.js";
import { clientNonceFor, nonceFor, type NonceBinding } from "./nonce.js";
import { randomBytes } from "node:crypto";
import type { ArcPaymentPayload, PaymentRequirements } from "./types.js";

export type PayOnArcOptions = {
  /** A key that holds USDC on Arc. It signs AND broadcasts — it needs no other gas asset. */
  privateKey: `0x${string}`;
  /** The `accepts` entry chosen from the 402 response. */
  requirements: PaymentRequirements;
  chain?: "mainnet" | "testnet";
  rpcUrl?: string;
  /** Overrides `extra.resource` when the server did not set it. */
  resource?: string;
  /** Authorization validity window. */
  validForSec?: number;
  /** Wait for the receipt before returning. Leave on: the server needs a mined transaction. */
  waitForReceipt?: boolean;
};

const ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/**
 * Pay a 402 challenge on Arc. Returns the payload to put in the `X-PAYMENT` header.
 */
export async function payOnArc(opts: PayOnArcOptions): Promise<ArcPaymentPayload> {
  // Imported lazily so the server side of this package stays dependency-free.
  const { createWalletClient, createPublicClient, defineChain, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");

  const chainInfo = ARC[opts.chain ?? "mainnet"];
  const rpcUrl = opts.rpcUrl ?? chainInfo.rpcUrl;
  const req = opts.requirements;
  const asset = (req.asset ?? ARC_USDC) as `0x${string}`;
  const account = privateKeyToAccount(opts.privateKey);
  const binding: NonceBinding = {
    network: req.network,
    asset,
    payTo: req.payTo,
    amount: req.amount,
    resource: typeof req.extra?.resource === "string" ? (req.extra.resource as string) : (opts.resource ?? ""),
  };
  // Two challenge modes (see nonce.ts). A server on @x402/core 2.13 cannot put per-request data in
  // `extra`, so the absence of a seed is the normal case: the buyer supplies the freshness itself.
  const seed = typeof req.extra?.seed === "string" ? (req.extra.seed as string) : "";
  const clientNonce = seed ? undefined : randomBytes(16).toString("hex");
  const derived = seed ? nonceFor(seed, binding) : clientNonceFor(clientNonce!, binding);

  // Never pay against a nonce we did not derive ourselves: it is what binds this payment to this
  // challenge, so a server-published one that disagrees means the challenge is not what it claims.
  const published = typeof req.extra?.nonce === "string" ? (req.extra.nonce as string) : null;
  if (published && published.toLowerCase() !== derived.toLowerCase()) {
    throw new Error("payOnArc: the server's nonce does not match the challenge — refusing to pay");
  }

  const chain = defineChain({
    id: chainInfo.chainId,
    name: `Arc ${opts.chain ?? "mainnet"}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, // gas view of the same balance
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const validBefore = BigInt(Math.floor(Date.now() / 1000) + (opts.validForSec ?? req.maxTimeoutSeconds ?? 300));
  const message = {
    from: account.address,
    to: req.payTo as `0x${string}`,
    value: BigInt(req.amount),
    validAfter: 0n,
    validBefore,
    nonce: derived,
  };

  const signature = await account.signTypedData({
    domain: { ...ARC_USDC_EIP712, chainId: chainInfo.chainId, verifyingContract: asset },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message,
  });

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const hash = await wallet.writeContract({
    address: asset,
    abi: ABI,
    functionName: "transferWithAuthorization",
    args: [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, signature],
  });

  if (opts.waitForReceipt !== false) {
    const pub = createPublicClient({ chain, transport: http(rpcUrl) });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`payOnArc: the payment transaction reverted (${hash})`);
  }

  return { transaction: hash, ...(seed ? { seed } : { clientNonce }), nonce: derived };
}

/** Header value for a paid retry: base64 of the x402 payment payload. */
export function toPaymentHeader(payload: ArcPaymentPayload, requirements: PaymentRequirements, resource?: string): string {
  const body = {
    x402Version: 2,
    accepted: requirements,
    ...(resource ? { resource: { url: resource } } : {}),
    payload,
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}
