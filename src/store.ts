/**
 * Spent-authorization store: stops one settled transaction paying for two requests.
 *
 * The chain already prevents the same EIP-3009 authorization being USED twice — that is
 * `authorizationState`. What the chain cannot know is how many times someone PRESENTED the resulting
 * transaction hash to us. Without this, a single $0.003 payment is an unlimited pass.
 *
 * `reserve()` must be atomic: check-then-set with an await in between would let two concurrent
 * requests both win. The in-memory implementation is synchronous inside, so it is.
 */
export interface SpentStore {
  /** Returns true if this nonce was previously unseen (and is now claimed), false if already spent. */
  reserve(nonce: string, ttlSec: number): Promise<boolean>;
  /**
   * Tx-aware claim, used when the claim happens during verify (see ArcLocalFacilitator.claimOn).
   *   "new"      — first time this nonce is seen; it is now claimed for `tx`
   *   "same"     — already claimed BY THIS SAME transaction
   *   "conflict" — claimed by a different transaction
   * Verify treats "same" as a replay and refuses; settle treats it as its own earlier verify.
   */
  claim?(nonce: string, tx: string, ttlSec: number): Promise<"new" | "same" | "conflict">;
  /**
   * Mark a claimed nonce as SETTLED. Returns false if it was already settled.
   *
   * Claiming and settling are separate states on purpose: with claim-at-verify, settle sees its own
   * earlier claim ("same") and must accept it — so without this second state, calling settle twice
   * would succeed twice on any server that settles without verifying first.
   */
  markSettled?(nonce: string): Promise<boolean>;
}

/**
 * Default store: one process, one map.
 *
 * ⚠️ Single-instance only. Behind several server instances (or serverless), two instances share
 * nothing and the same payment can be spent once per instance — use a shared store (Redis, a
 * database unique constraint) in that topology. Documented rather than silently wrong.
 */
export class MemorySpentStore implements SpentStore {
  private readonly seen = new Map<string, number>();
  private readonly txFor = new Map<string, string>();
  private readonly settled = new Set<string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 100_000) {
    this.maxEntries = maxEntries;
  }

  async reserve(nonce: string, ttlSec: number): Promise<boolean> {
    const now = Date.now();
    this.sweep(now);
    const key = nonce.toLowerCase();
    const until = this.seen.get(key);
    if (until !== undefined && until > now) return false;
    // A full map must not become a free pass: refuse rather than forget, so the failure mode is
    // "payment rejected" (visible, retryable) instead of "payment reusable" (invisible, exploitable).
    if (this.seen.size >= this.maxEntries) throw new Error("spent store full");
    this.seen.set(key, now + ttlSec * 1000);
    return true;
  }

  async claim(nonce: string, tx: string, ttlSec: number): Promise<"new" | "same" | "conflict"> {
    const now = Date.now();
    this.sweep(now);
    const key = nonce.toLowerCase();
    const until = this.seen.get(key);
    if (until !== undefined && until > now) {
      return this.txFor.get(key) === tx.toLowerCase() ? "same" : "conflict";
    }
    if (this.seen.size >= this.maxEntries) throw new Error("spent store full");
    this.seen.set(key, now + ttlSec * 1000);
    this.txFor.set(key, tx.toLowerCase());
    return "new";
  }

  async markSettled(nonce: string): Promise<boolean> {
    const key = nonce.toLowerCase();
    if (this.settled.has(key)) return false;
    this.settled.add(key);
    return true;
  }

  private sweep(now: number): void {
    if (this.seen.size === 0) return;
    for (const [k, until] of this.seen) {
      if (until <= now) {
        this.seen.delete(k);
        this.txFor.delete(k);
        this.settled.delete(k);
      }
    }
  }

  /** Test/ops visibility. */
  get size(): number {
    return this.seen.size;
  }
}
