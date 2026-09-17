/**
 * Nonce binding for client-broadcast EIP-3009.
 *
 * ── Why this differs from x402 proposal #3504 ─────────────────────────────────────────────────────
 * The proposal derives the EIP-3009 nonce as a deterministic digest of the payment requirements
 * (amount, asset, payTo, resource). EIP-3009 nonces are SINGLE USE — the token records
 * `authorizationState(authorizer, nonce)` and rejects a repeat — so a deterministic nonce lets a
 * buyer pay for a given resource at a given price exactly ONCE, EVER. The second purchase reverts
 * with "authorization is used or canceled".
 *
 * That is not an edge case; it is the normal shape of x402 traffic. In our own production logs one
 * buyer called a single route at a single price 658 times.
 *
 * Fix: the server mints a short-lived SEED with each 402 challenge, and the nonce binds the
 * requirements AND that seed. The seed is self-authenticating (HMAC with an embedded expiry), so the
 * server stays stateless: nothing is remembered between the challenge and the payment, yet a replayed
 * or hand-made seed cannot pass, and every challenge yields a fresh nonce.
 *
 * The seed does NOT prevent a paid transaction from being presented twice — that is what the spent
 * store is for (see store.ts). It prevents the *authorization* from being un-mintable a second time.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The parts of the payment requirements the nonce is bound to. */
export type NonceBinding = {
  network: string;
  asset: string;
  payTo: string;
  /** Atomic units (6-decimal USDC on Arc), as a decimal string. */
  amount: string;
  /** The resource being bought — so an authorization for endpoint A cannot pay for endpoint B. */
  resource: string;
};

/**
 * Canonical form of a binding. Addresses are lowercased (EVM addresses are case-insensitive and
 * clients disagree about checksumming); everything else is compared verbatim. A fixed-order array
 * rather than an object, so key order can never change the digest.
 */
function canonical(b: NonceBinding): string {
  return JSON.stringify([
    b.network,
    b.asset.toLowerCase(),
    b.payTo.toLowerCase(),
    b.amount,
    b.resource,
  ]);
}

function seedMac(secret: string, exp: number, rand: string, b: NonceBinding): string {
  return createHmac("sha256", secret)
    .update(`arc-seed-v1|${exp}|${rand}|${canonical(b)}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Mint a seed to hand to the client in the 402 challenge.
 *
 * @param secret - server secret; never leaves the server and never appears in a response
 * @param ttlSec - how long the challenge stays payable
 */
export function mintSeed(
  secret: string,
  b: NonceBinding,
  ttlSec = 300,
  nowMs: number = Date.now(),
): string {
  if (!secret) throw new Error("mintSeed: a server secret is required");
  const exp = Math.floor(nowMs / 1000) + ttlSec;
  const rand = randomBytes(16).toString("hex");
  return `v1.${exp}.${rand}.${seedMac(secret, exp, rand, b)}`;
}

export type SeedCheck = { ok: true; expSec: number } | { ok: false; reason: string };

/** Verify a seed came from us, has not expired, and was minted for exactly these requirements. */
export function verifySeed(
  secret: string,
  seed: string,
  b: NonceBinding,
  nowMs: number = Date.now(),
): SeedCheck {
  if (typeof seed !== "string") return { ok: false, reason: "seed_missing" };
  const parts = seed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return { ok: false, reason: "seed_malformed" };
  const [, expRaw, rand, mac] = parts;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp <= 0) return { ok: false, reason: "seed_malformed" };
  if (!/^[0-9a-f]{32}$/.test(rand) || !/^[0-9a-f]{32}$/.test(mac)) {
    return { ok: false, reason: "seed_malformed" };
  }
  // Constant-time compare, and only then the expiry: an attacker must not learn whether a forged MAC
  // was "right but expired".
  const expect = Buffer.from(seedMac(secret, exp, rand, b), "hex");
  const got = Buffer.from(mac, "hex");
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) {
    return { ok: false, reason: "seed_invalid" };
  }
  if (Math.floor(nowMs / 1000) > exp) return { ok: false, reason: "seed_expired" };
  return { ok: true, expSec: exp };
}

/**
 * Client-nonce mode — the default, because it is the only mode that works on every x402 server.
 *
 * x402 servers REBUILD the payment requirements when verifying, and @x402/core matches the rebuilt
 * `extra` against the one the client echoed (`required.extra ⊆ accepted.extra`). Anything that changes
 * per request — a fresh seed, an expiry timestamp — therefore makes a valid payment unmatchable.
 * @x402/core 2.13, which is what real deployments are running, has no `dynamicExtraFields` escape
 * hatch for this.
 *
 * So the freshness comes from the BUYER instead: it picks a random value, and the nonce is a public
 * digest of (server-side binding ‖ that value). Nothing per-request needs to travel in `extra`.
 *
 * What still holds: the binding fields (network, asset, payTo, amount, resource) come from the
 * SERVER's requirements at verification time, so a payment made for a different price, payee or
 * resource simply does not produce the nonce the server expects. Replay is stopped by the spent store
 * and by EIP-3009's own single-use nonce.
 *
 * What is given up versus `mintSeed`: the server no longer authenticates its own challenge, and there
 * is no challenge expiry — receipt age bounds freshness instead. Use seed mode where the server
 * controls matching itself and wants both.
 */
export function clientNonceFor(clientNonce: string, b: NonceBinding): `0x${string}` {
  if (!/^[0-9a-fA-F]{8,64}$/.test(clientNonce)) {
    throw new Error("clientNonce must be 4-32 bytes of hex");
  }
  const d = createHash("sha256")
    .update(`arc-nonce-v2|${canonical(b)}|${clientNonce.toLowerCase()}`)
    .digest("hex");
  return `0x${d}` as `0x${string}`;
}

/**
 * Seed mode: the EIP-3009 nonce for this (requirements, seed) pair, 32 bytes as the token expects.
 * Both sides compute it independently — it is never transmitted as an authority, only checked.
 */
export function nonceFor(seed: string, b: NonceBinding): `0x${string}` {
  const d = createHash("sha256").update(`arc-nonce-v1|${canonical(b)}|${seed}`).digest("hex");
  return `0x${d}` as `0x${string}`;
}
