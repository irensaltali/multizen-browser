/**
 * In-memory {@link ConditionalObjectStore} with strong consistency.
 *
 * Purpose: deterministic tests of the coordinator's CAS/lease/revision logic
 * without a network or the AWS SDK. It faithfully models the ONLY guarantees
 * the coordinator relies on:
 *
 *   - read-after-write / read-after-CAS consistency,
 *   - atomic conditional create (`If-None-Match: *`),
 *   - atomic compare-and-swap (`If-Match: <etag>`),
 *   - a monotonic, opaque, synthetic ETag per object version,
 *   - a controllable synthetic server clock (for skew/expiry tests).
 *
 * It adds two testing affordances:
 *   - fault injection: force the next N operations (or a matching key) to fail
 *     with a chosen {@link StoreErrorKind}, to exercise retry/normalization.
 *   - operation barriers: `gate(key)` pauses an in-flight op until released, so
 *     two coordinator calls can be interleaved into a deterministic race.
 */

import {
  StoreError,
  StoreErrorKind,
  MAX_LIST_PAGE_SIZE,
  type ConditionalObjectStore,
  type GetResult,
  type HeadResult,
  type PutResult,
  type ListOptions,
  type ListPage,
} from "./store.js";

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
}

/** A one-shot fault the store will raise on the next matching operation. */
interface InjectedFault {
  op: "get" | "put" | "head" | "delete" | "list" | "any";
  keyMatch?: (key: string) => boolean;
  kind: StoreErrorKind;
  message?: string;
  /** How many times to apply (default 1). */
  times: number;
}

/** A barrier that pauses an operation on `key` until `release` is called. */
interface Barrier {
  op: "get" | "put" | "head" | "delete" | "list" | "any";
  keyMatch: (key: string) => boolean;
  promise: Promise<void>;
  release: () => void;
  /** Fires when a paused op reaches the barrier. */
  reached: Promise<void>;
  markReached: () => void;
  once: boolean;
  used: boolean;
}

export interface InMemoryStoreOptions {
  /** Initial synthetic server clock (epoch ms). Defaults to Date.now(). */
  nowMs?: number;
  /** When true, GET/HEAD/PUT results report a server date; else null. */
  exposeServerDate?: boolean;
}

export class InMemoryConditionalObjectStore implements ConditionalObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  private etagCounter = 0;
  private clockMs: number;
  private readonly exposeServerDate: boolean;
  private readonly faults: InjectedFault[] = [];
  private readonly barriers: Barrier[] = [];
  private healthy = true;

  constructor(opts: InMemoryStoreOptions = {}) {
    this.clockMs = opts.nowMs ?? Date.now();
    this.exposeServerDate = opts.exposeServerDate ?? true;
  }

  // ── clock control ─────────────────────────────────────────────────────────
  /** Current synthetic server clock. */
  now(): number {
    return this.clockMs;
  }
  /** Advance the synthetic server clock. */
  advance(ms: number): void {
    this.clockMs += ms;
  }
  /** Set the synthetic server clock to an absolute epoch-ms value. */
  setNow(ms: number): void {
    this.clockMs = ms;
  }

  // ── fault injection ─────────────────────────────────────────────────────
  injectFault(fault: Omit<InjectedFault, "times"> & { times?: number }): void {
    this.faults.push({ ...fault, times: fault.times ?? 1 });
  }
  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }
  clearFaults(): void {
    this.faults.length = 0;
  }

  // ── operation barriers (for deterministic races) ─────────────────────────
  /**
   * Install a barrier: the next matching operation will pause when it reaches
   * the store and resume only when the returned `release()` is called. Await
   * `reached` to know the op is parked. `once` (default true) removes the
   * barrier after a single use.
   */
  gate(
    op: Barrier["op"],
    keyMatch: (key: string) => boolean,
    once = true,
  ): { release: () => void; reached: Promise<void> } {
    let release!: () => void;
    let markReached!: () => void;
    const promise = new Promise<void>((res) => {
      release = res;
    });
    const reached = new Promise<void>((res) => {
      markReached = res;
    });
    this.barriers.push({ op, keyMatch, promise, release, reached, markReached, once, used: false });
    return { release, reached };
  }

  private async maybeBarrier(op: Barrier["op"], key: string): Promise<void> {
    const b = this.barriers.find(
      (x) => !x.used && (x.op === op || x.op === "any") && x.keyMatch(key),
    );
    if (!b) return;
    b.used = true;
    b.markReached();
    await b.promise;
    if (b.once) {
      const idx = this.barriers.indexOf(b);
      if (idx >= 0) this.barriers.splice(idx, 1);
    }
  }

  private maybeFault(op: InjectedFault["op"], key: string): void {
    const idx = this.faults.findIndex(
      (f) =>
        (f.op === op || f.op === "any") && (f.keyMatch ? f.keyMatch(key) : true) && f.times > 0,
    );
    if (idx < 0) return;
    const fault = this.faults[idx]!;
    fault.times -= 1;
    if (fault.times <= 0) this.faults.splice(idx, 1);
    throw new StoreError(fault.kind, fault.message ?? `injected ${fault.kind}`, undefined);
  }

  private serverDate(): number | null {
    return this.exposeServerDate ? this.clockMs : null;
  }

  private nextEtag(): string {
    this.etagCounter += 1;
    // Opaque, quoted token — mirrors S3/R2 ETag quoting so callers that echo it
    // back are exercised against the same shape.
    return `"mem-${this.etagCounter}"`;
  }

  // ── ConditionalObjectStore ────────────────────────────────────────────────
  async get(key: string): Promise<GetResult> {
    await this.maybeBarrier("get", key);
    this.maybeFault("get", key);
    const obj = this.objects.get(key);
    if (!obj) throw new StoreError(StoreErrorKind.NotFound, `not found: ${key}`, 404);
    return {
      bytes: obj.bytes,
      text: new TextDecoder().decode(obj.bytes),
      etag: obj.etag,
      serverDateMs: this.serverDate(),
    };
  }

  async head(key: string): Promise<HeadResult> {
    await this.maybeBarrier("head", key);
    this.maybeFault("head", key);
    const obj = this.objects.get(key);
    if (!obj) throw new StoreError(StoreErrorKind.NotFound, `not found: ${key}`, 404);
    return { etag: obj.etag, serverDateMs: this.serverDate() };
  }

  async putCreate(key: string, body: Uint8Array): Promise<PutResult> {
    await this.maybeBarrier("put", key);
    this.maybeFault("put", key);
    if (this.objects.has(key)) {
      throw new StoreError(StoreErrorKind.PreconditionFailed, `already exists: ${key}`, 412);
    }
    const etag = this.nextEtag();
    this.objects.set(key, { bytes: body.slice(), etag });
    return { etag, serverDateMs: this.serverDate() };
  }

  async putImmutable(key: string, body: Uint8Array): Promise<PutResult> {
    return this.putCreate(key, body);
  }

  async putCompareAndSwap(key: string, body: Uint8Array, etag: string): Promise<PutResult> {
    await this.maybeBarrier("put", key);
    this.maybeFault("put", key);
    const obj = this.objects.get(key);
    if (!obj) throw new StoreError(StoreErrorKind.NotFound, `not found: ${key}`, 404);
    if (obj.etag !== etag) {
      throw new StoreError(StoreErrorKind.PreconditionFailed, `etag mismatch: ${key}`, 412);
    }
    const newEtag = this.nextEtag();
    this.objects.set(key, { bytes: body.slice(), etag: newEtag });
    return { etag: newEtag, serverDateMs: this.serverDate() };
  }

  async delete(key: string): Promise<void> {
    await this.maybeBarrier("delete", key);
    try {
      this.maybeFault("delete", key);
    } catch {
      // best-effort: swallow injected delete faults
      return;
    }
    this.objects.delete(key);
  }

  async deleteStrict(key: string): Promise<void> {
    await this.maybeBarrier("delete", key);
    this.maybeFault("delete", key); // strict: injected faults propagate
    // Idempotent: deleting an absent key is a no-op success.
    this.objects.delete(key);
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListPage> {
    await this.maybeBarrier("list", prefix);
    this.maybeFault("list", prefix);
    const requested = options.maxKeys;
    const maxKeys =
      typeof requested === "number" && Number.isInteger(requested) && requested > 0
        ? Math.min(requested, MAX_LIST_PAGE_SIZE)
        : MAX_LIST_PAGE_SIZE;
    // Deterministic order (lexical) so pagination is stable across calls.
    const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    let startIndex = 0;
    if (options.continuationToken !== undefined) {
      const decoded = this.decodeToken(options.continuationToken);
      // Resume strictly after the last key we returned.
      startIndex = all.findIndex((k) => k > decoded);
      if (startIndex < 0) startIndex = all.length;
    }
    const page = all.slice(startIndex, startIndex + maxKeys);
    const consumed = startIndex + page.length;
    const truncated = consumed < all.length;
    const nextContinuationToken =
      truncated && page.length > 0 ? this.encodeToken(page[page.length - 1]!) : null;
    return { keys: page, nextContinuationToken };
  }

  private encodeToken(key: string): string {
    return Buffer.from(key, "utf-8").toString("base64");
  }
  private decodeToken(token: string): string {
    return Buffer.from(token, "base64").toString("utf-8");
  }

  async health(): Promise<boolean> {
    return this.healthy;
  }

  // ── test inspection helpers ────────────────────────────────────────────────
  has(key: string): boolean {
    return this.objects.has(key);
  }
  rawText(key: string): string | undefined {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.bytes) : undefined;
  }
  keys(): string[] {
    return [...this.objects.keys()];
  }
}
