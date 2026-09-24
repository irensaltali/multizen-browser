/**
 * Narrow, structural conditional-object-store contract used by the project-config
 * synchronizer.
 *
 * The gateway must not take a hard dependency on `@multizen/s3-coordinator`'s
 * concrete classes for its *core* logic: that package depends on the AWS SDK and
 * `@multizen/sync-core`, and pulling it into the pure gateway core would create a
 * heavy, cyclic-prone edge. Instead we declare here the *minimum* structural
 * surface the synchronizer needs. Any object that satisfies this shape works —
 * including `@multizen/s3-coordinator`'s `InMemoryConditionalObjectStore` and
 * `S3ConditionalObjectStore`, whose real interface is a superset of this one.
 *
 * The methods and their failure model mirror the coordinator's
 * `ConditionalObjectStore` exactly (conditional create, compare-and-swap,
 * write-once immutable, prefix listing with continuation) so a coordinator store
 * is assignable to this interface with no adapter.
 *
 * Failures are surfaced as objects carrying a `kind` string. We match on `kind`
 * defensively (see {@link isStoreErrorKind}) without importing the coordinator's
 * `StoreError` class, so a store from any package — or a hand-rolled test double —
 * interoperates.
 */

/** Normalized failure classes, structurally identical to the coordinator's. */
export type SyncStoreErrorKind =
  | "NotFound"
  | "PreconditionFailed"
  | "Conflict"
  | "AuthFailed"
  | "Unreachable"
  | "Malformed";

/** Result of a successful GET. `etag` is opaque; echo it back into a CAS. */
export interface SyncGetResult {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly etag: string;
  readonly serverDateMs: number | null;
}

/** Result of any conditional PUT: the new opaque ETag + observed clock. */
export interface SyncPutResult {
  readonly etag: string;
  readonly serverDateMs: number | null;
}

/** Options for one listing page. */
export interface SyncListOptions {
  readonly continuationToken?: string;
  readonly maxKeys?: number;
}

/** One page of a prefix listing (absolute keys). */
export interface SyncListPage {
  readonly keys: string[];
  readonly nextContinuationToken: string | null;
}

/**
 * The minimal structural store the synchronizer requires. This is intentionally
 * a *structural* subset of the coordinator's `ConditionalObjectStore`, so any
 * coordinator store is assignable without an adapter.
 */
export interface SyncObjectStore {
  get(key: string): Promise<SyncGetResult>;
  putCreate(key: string, body: Uint8Array): Promise<SyncPutResult>;
  putCompareAndSwap(key: string, body: Uint8Array, etag: string): Promise<SyncPutResult>;
  putImmutable(key: string, body: Uint8Array): Promise<SyncPutResult>;
  list(prefix: string, options?: SyncListOptions): Promise<SyncListPage>;
}

/**
 * Best-effort classification of a thrown store failure by its `kind`. We never
 * import a concrete error class; we read the `kind` field structurally so any
 * store implementation interoperates. Returns null when the value is not a
 * recognizable store error.
 */
export function storeErrorKind(value: unknown): SyncStoreErrorKind | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (
    kind === "NotFound" ||
    kind === "PreconditionFailed" ||
    kind === "Conflict" ||
    kind === "AuthFailed" ||
    kind === "Unreachable" ||
    kind === "Malformed"
  ) {
    return kind;
  }
  return null;
}

/** True when `value` is a store error of one of the given kinds. */
export function isStoreErrorKind(value: unknown, ...kinds: SyncStoreErrorKind[]): boolean {
  const k = storeErrorKind(value);
  return k !== null && kinds.includes(k);
}
