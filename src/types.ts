/**
 * Structural mirrors of the x402 core types.
 *
 * Declared here rather than imported so this package has NO runtime dependency and is not pinned to
 * one @x402/core version. test/compat.test.ts assigns our classes to the real interfaces from
 * @x402/core (a devDependency), so drift is a compile error rather than a surprise in production.
 */
/** CAIP-2. Mirrors @x402/core exactly: a plain `string` is NOT assignable to it. */
export type Network = `${string}:${string}`;

/** Payment flow names as @x402/core defines them. */
export type PaymentFlowName = "authorization" | "upfront" | "escrow";
export type PaymentFlowConfig = {
  readonly supported: readonly PaymentFlowName[];
  readonly default: PaymentFlowName;
};

export type PaymentRequirements = {
  scheme: string;
  network: Network;
  asset: string;
  /** Atomic units, decimal string. */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

export type ResourceInfo = { url: string; description?: string; mimeType?: string };

export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

export type VerifyResponse = {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

export type SettleResponse = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: Network;
  amount?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

export type SupportedKind = {
  x402Version: number;
  scheme: string;
  network: Network;
  extra?: Record<string, unknown>;
};

export type SupportedResponse = {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
};

export type Money = string | number;
export type AssetAmount = { asset: string; amount: string; extra?: Record<string, unknown> };
export type Price = Money | AssetAmount;

/** The payload a client sends back after broadcasting its own EIP-3009 authorization. */
export type ArcPaymentPayload = {
  /** Transaction hash of the client-broadcast `transferWithAuthorization`. */
  transaction: string;
  /** Seed mode: the seed from the 402 challenge, echoed back. */
  seed?: string;
  /** Client-nonce mode (default): the buyer's random hex, 4-32 bytes. */
  clientNonce?: string;
  /** Optional: the nonce the client used. Checked against our own derivation when present. */
  nonce?: string;
};
