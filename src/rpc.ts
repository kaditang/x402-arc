/**
 * Minimal JSON-RPC client for Arc, with the amplification controls a public paid endpoint needs.
 *
 * Verification is triggered by a caller-supplied transaction hash, so an unauthenticated stranger can
 * make us call an upstream RPC by sending nonsense. Three guards:
 *   · single-flight   — N concurrent requests for the same hash cause ONE upstream call
 *   · caching         — a final receipt is immutable, so it caches well; misses cache briefly too,
 *                       which is what actually blunts a flood of invented hashes
 *   · a token bucket  — a hard ceiling on upstream calls per minute, whatever the traffic
 *
 * No dependencies: global fetch and an AbortSignal timeout.
 */
import type { RpcReceipt } from "./receipt.js";

export type RpcOptions = {
  url: string;
  timeoutMs?: number;
  /** Upstream calls allowed per minute (token bucket). */
  maxCallsPerMin?: number;
  /** How long a found receipt is cached. Final receipts are immutable, so this can be generous. */
  receiptTtlMs?: number;
  /** How long "not found" is cached — the guard against invented hashes. */
  missTtlMs?: number;
  fetchImpl?: typeof fetch;
};

export class RpcBudgetExceeded extends Error {
  constructor() {
    super("Arc RPC budget exceeded");
    this.name = "RpcBudgetExceeded";
  }
}

type CacheEntry<T> = { value: T; until: number };

export class ArcRpc {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxCallsPerMin: number;
  private readonly receiptTtlMs: number;
  private readonly missTtlMs: number;
  private readonly doFetch: typeof fetch;

  private tokens: number;
  private windowStart = Date.now();
  private readonly receipts = new Map<string, CacheEntry<RpcReceipt | null>>();
  private readonly inflight = new Map<string, Promise<RpcReceipt | null>>();

  constructor(opts: RpcOptions) {
    this.url = opts.url;
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.maxCallsPerMin = opts.maxCallsPerMin ?? 120;
    this.receiptTtlMs = opts.receiptTtlMs ?? 5 * 60_000;
    this.missTtlMs = opts.missTtlMs ?? 10_000;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.tokens = this.maxCallsPerMin;
  }

  private spendToken(): void {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.tokens = this.maxCallsPerMin;
    }
    if (this.tokens <= 0) throw new RpcBudgetExceeded();
    this.tokens--;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    this.spendToken();
    const res = await this.doFetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "x402-arc" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Arc RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`Arc RPC ${method}: ${body.error.message ?? "error"}`);
    return body.result as T;
  }

  /** Receipt by hash, single-flighted and cached (including misses). */
  async getReceipt(txHash: string): Promise<RpcReceipt | null> {
    const key = txHash.toLowerCase();
    const now = Date.now();
    const hit = this.receipts.get(key);
    if (hit && hit.until > now) return hit.value;

    const running = this.inflight.get(key);
    if (running) return running;

    const p = (async () => {
      try {
        const r = await this.call<RpcReceipt | null>("eth_getTransactionReceipt", [key]);
        this.receipts.set(key, { value: r ?? null, until: Date.now() + (r ? this.receiptTtlMs : this.missTtlMs) });
        return r ?? null;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  async getTipBlockNumber(): Promise<number> {
    const hex = await this.call<string>("eth_blockNumber", []);
    return Number(BigInt(hex));
  }

  async getBlockTimestampSec(blockNumberHex: string): Promise<number> {
    const block = await this.call<{ timestamp: string } | null>("eth_getBlockByNumber", [blockNumberHex, false]);
    if (!block?.timestamp) throw new Error("Arc RPC: block has no timestamp");
    return Number(BigInt(block.timestamp));
  }
}
