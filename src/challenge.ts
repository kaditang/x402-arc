/**
 * Reading a 402 challenge from a real x402 server.
 *
 * The challenge can arrive two ways, and a buyer that only knows one of them silently fails against
 * half the servers it meets:
 *   · in the JSON body            — what most examples show
 *   · in a `payment-required` header, base64 JSON — what x402 v2 actually puts on the wire, and what
 *     servers that keep their 402 body lean (a probe flood is cheaper to serve empty) return
 *
 * Kept dependency-free so the buyer side of this package works with plain `fetch`.
 */
import type { PaymentRequirements } from "./types.js";

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource?: { url: string; description?: string };
  accepts: PaymentRequirements[];
};

function decodeBase64Json(value: string): unknown {
  // Tolerate missing padding and the URL-safe alphabet: both appear in the wild.
  const normalised = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

/** Extract the challenge from a 402 response, header first. Returns null if there is none. */
export async function readPaymentRequired(res: Response): Promise<PaymentRequired | null> {
  const header = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
  if (header) {
    try {
      const parsed = decodeBase64Json(header) as PaymentRequired;
      if (Array.isArray(parsed?.accepts)) return parsed;
    } catch {
      /* fall through to the body */
    }
  }
  try {
    const body = (await res.clone().json()) as PaymentRequired;
    if (Array.isArray(body?.accepts) && body.accepts.length > 0) return body;
  } catch {
    /* no JSON body */
  }
  return null;
}

/** Pick the Arc option out of a challenge, if the server offers one. */
export function selectArcRequirements(
  challenge: PaymentRequired,
  chain: "mainnet" | "testnet" = "mainnet",
): PaymentRequirements | null {
  const want = chain === "mainnet" ? "eip155:5042" : "eip155:5042002";
  // Exact match: "eip155:5042" is a PREFIX of "eip155:5042002", so `startsWith` would let a testnet
  // offer answer a mainnet request — and the payment would go to a worthless chain.
  return challenge.accepts.find((a) => a.network === want) ?? null;
}
