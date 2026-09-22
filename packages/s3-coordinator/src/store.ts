/**
 * Provider-neutral conditional object store.
 *
 * This is the storage seam the coordinator writes through. It exposes ONLY the
 * strongly-consistent, precondition-based primitives that both Cloudflare R2
 * and AWS S3 guarantee:
 *
 *   - conditional create  (`If-None-Match: *`)  — succeeds iff the key is absent
 *   - compare-and-swap    (`If-Match: <etag>`)  — succeeds iff the current
 *                                                 object's ETag matches
 *   - immutable create    (`If-None-Match: *`)  — same primitive as create, used
 *                                                 for write-once history records
 *
 * These map directly onto S3/R2 conditional PUT semantics and are the entire
 * basis for the lease/revision coordinator: there is no server-side compute,
 * only atomic conditional object writes.
 *
 * Every failure is normalized into a small, deterministic set of
 * {@link StoreErrorKind}s so the coordinator can branch on `kind`, never on a
 * provider's prose or HTTP status directly.
 */

/** Normalized failure classes for conditional object operations. */
export enum StoreErrorKind {
  /** The requested key does not exist (GET/HEAD 404, or CAS on a missing key). */
  NotFound = "NotFound",
  /**
   * A precondition failed (HTTP 412). For `putCreate`/`putImmutable` this means
   * the key already exists; for `putCompareAndSwap` it means the current ETag
   * does not match the supplied one.
   */
  PreconditionFailed = "PreconditionFailed",
  /**
   * A concurrent-modification conflict (HTTP 409). Some providers surface a
   * losing conditional write as 409 rather than 412; the coordinator treats it
   * as retryable from a fresh read.
   */
  Conflict = "Conflict",
  /** Credentials were rejected or insufficient (HTTP 401/403). */
  AuthFailed = "AuthFailed",
  /** The store could not be reached (DNS, TCP, TLS, timeout, 5xx). */
  Unreachable = "Unreachable",
  /** A response was malformed or violated an invariant we depend on. */
  Malformed = "Malformed",
}

/** A normalized, serializable store error. Never carries credentials. */
export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  /** Underlying provider status code, when known (non-secret). */
  readonly httpStatus: number | undefined;

  constructor(kind: StoreErrorKind, message: string, httpStatus?: number) {
    super(message);
    this.name = "StoreError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

export function isStoreError(value: unknown): value is StoreError {
  return value instanceof StoreError;
}

/** True when `value` is a StoreError of one of the given kinds. */
export function isStoreErrorOfKind(value: unknown, ...kinds: StoreErrorKind[]): boolean {
  return isStoreError(value) && kinds.includes(value.kind);
}

/**
 * The result of a successful GET. `etag` is an OPAQUE token — callers must not
 * parse it, only echo it back into a later `putCompareAndSwap`. `serverDateMs`
 * is the store's `Date` response header in epoch ms when available, else null;
 * the coordinator uses it to reason about lease expiry with a clock-skew
 * margin and falls back to local time (conservatively) when null.
 */
export interface GetResult {
  bytes: Uint8Array;
  text: string;
  etag: string;
  serverDateMs: number | null;
}

/** The result of a successful HEAD. */
export interface HeadResult {
  etag: string;
  serverDateMs: number | null;
}

/** The result of any conditional PUT: the new opaque ETag + observed clock. */
export interface PutResult {
  etag: string;
  serverDateMs: number | null;
}

/** Options for a single {@link ConditionalObjectStore.list} page. */
export interface ListOptions {
  /**
   * Opaque continuation token from a previous page's
   * {@link ListPage.nextContinuationToken}. Omit to start from the beginning.
   */
  continuationToken?: string;
  /**
   * Per-page cap on the number of keys to return. Implementations MUST clamp
   * this to a sane maximum (see {@link MAX_LIST_PAGE_SIZE}) so a single call
   * can never request an unbounded page.
   */
  maxKeys?: number;
}

/** Hard per-page cap the store enforces regardless of the requested `maxKeys`. */
export const MAX_LIST_PAGE_SIZE = 1000;

/**
 * One page of a prefix listing. `keys` are full object keys (prefix-relative
 * listing is NOT used — callers get absolute keys and parse them). When
 * `nextContinuationToken` is a non-empty string the listing is truncated and
 * the caller must issue another page with it; when null/undefined the listing
 * is exhausted.
 */
export interface ListPage {
  keys: string[];
  nextContinuationToken: string | null;
}

/**
 * Provider-neutral, strongly-consistent conditional object store.
 *
 * Implementations MUST guarantee read-after-write and read-after-conditional
 * -write consistency (S3 and R2 both do). All methods either resolve on
 * success or reject with a {@link StoreError}.
 */
export interface ConditionalObjectStore {
  /**
   * Fetch an object. Rejects with `NotFound` when the key is absent. Returns
   * the object bytes/text, its opaque ETag, and the server clock if exposed.
   */
  get(key: string): Promise<GetResult>;

  /**
   * Create an object only if it does not already exist (`If-None-Match: *`).
   * Rejects with `PreconditionFailed` when the key already exists.
   */
  putCreate(key: string, body: Uint8Array): Promise<PutResult>;

  /**
   * Overwrite an object only if its current ETag matches `etag`
   * (`If-Match: <etag>`). Rejects with `PreconditionFailed` on a mismatch and
   * `NotFound` if the object has since been deleted.
   */
  putCompareAndSwap(key: string, body: Uint8Array, etag: string): Promise<PutResult>;

  /**
   * Write a write-once object (`If-None-Match: *`). Semantically identical to
   * {@link putCreate} but named to document intent for immutable records
   * (history/revision files). Rejects with `PreconditionFailed` if present.
   */
  putImmutable(key: string, body: Uint8Array): Promise<PutResult>;

  /** HEAD an object. Rejects with `NotFound` when absent. */
  head(key: string): Promise<HeadResult>;

  /**
   * List one page of object keys under `prefix`. Returns absolute keys plus a
   * continuation token when the listing is truncated. Rejects with a
   * {@link StoreError} on transport/auth failure or a malformed response. Never
   * used for mutation — only whole-library discovery.
   */
  list(prefix: string, options?: ListOptions): Promise<ListPage>;

  /**
   * Liveness / reachability probe against the backing bucket. Resolves `true`
   * when the store is reachable and authorized, `false` otherwise. Never
   * throws.
   */
  health(): Promise<boolean>;

  /**
   * Best-effort delete. Used ONLY to clean up unique capability-probe objects;
   * the coordinator never deletes profile state or history. Implementations
   * should swallow `NotFound` and resolve regardless of transient failures.
   */
  delete(key: string): Promise<void>;

  /**
   * STRICT delete. Unlike {@link delete} this surfaces failures as
   * {@link StoreError} so callers can react (retry, warn). `NotFound` is
   * treated as success (idempotent). Used for optional cleanup of a profile's
   * immutable revision-history objects AFTER a tombstone — never for the state
   * document or the tombstone itself.
   */
  deleteStrict(key: string): Promise<void>;
}
