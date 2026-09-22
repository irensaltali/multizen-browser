/**
 * Capability probe.
 *
 * Before the coordinator will perform any writable operation, it must PROVE
 * that the configured store actually enforces the conditional-write semantics
 * the whole design depends on. A store that silently ignores `If-None-Match`
 * or `If-Match` (some misconfigured gateways / older R2 setups) would let two
 * devices both "win" a lease — a correctness catastrophe. So we refuse to
 * coordinate against a store that does not pass this probe.
 *
 * The probe writes to a UNIQUE key under `<controlPrefix>/capabilities/<uuid>`
 * and checks four invariants, then cleans up best-effort:
 *   1. create (`If-None-Match: *`) on an absent key SUCCEEDS,
 *   2. a duplicate create on the same key PRECONDITION-FAILS,
 *   3. CAS (`If-Match: <current etag>`) SUCCEEDS,
 *   4. CAS with a STALE etag PRECONDITION-FAILS.
 */

import { randomUUID } from "node:crypto";
import { capabilityKey } from "./state.js";
import {
  StoreError,
  StoreErrorKind,
  isStoreErrorOfKind,
  type ConditionalObjectStore,
} from "./store.js";

export interface CapabilityProbeResult {
  ok: boolean;
  /** Which invariant failed, when `ok` is false. */
  failedCheck?:
    | "create"
    | "duplicate-create-precondition"
    | "cas"
    | "stale-cas-precondition"
    | "unreachable";
  message?: string;
}

const enc = new TextEncoder();

/**
 * Run the capability probe once. Never throws for a *capability* failure —
 * returns `{ ok:false, failedCheck }`. Only truly unexpected internal errors
 * propagate. Cleans up the probe object best-effort.
 */
export async function runCapabilityProbe(
  store: ConditionalObjectStore,
  controlPrefix: string,
): Promise<CapabilityProbeResult> {
  const key = capabilityKey(controlPrefix, `probe-${randomUUID()}`);
  const v1 = enc.encode(JSON.stringify({ probe: 1, at: Date.now() }));
  const v2 = enc.encode(JSON.stringify({ probe: 2, at: Date.now() }));
  const v3 = enc.encode(JSON.stringify({ probe: 3, at: Date.now() }));

  try {
    // 1. create succeeds
    let etag: string;
    try {
      const r = await store.putCreate(key, v1);
      etag = r.etag;
    } catch (err) {
      if (isStoreErrorOfKind(err, StoreErrorKind.Unreachable, StoreErrorKind.AuthFailed)) {
        return { ok: false, failedCheck: "unreachable", message: describe(err) };
      }
      return { ok: false, failedCheck: "create", message: describe(err) };
    }

    // 2. duplicate create must precondition-fail
    try {
      await store.putCreate(key, v2);
      return {
        ok: false,
        failedCheck: "duplicate-create-precondition",
        message: "duplicate create unexpectedly succeeded — store ignores If-None-Match",
      };
    } catch (err) {
      if (!isStoreErrorOfKind(err, StoreErrorKind.PreconditionFailed, StoreErrorKind.Conflict)) {
        return { ok: false, failedCheck: "duplicate-create-precondition", message: describe(err) };
      }
    }

    // If the current etag is empty (some PUT responses omit ETag), read it.
    if (!etag) {
      const got = await store.get(key);
      etag = got.etag;
    }

    // 3. CAS with the current etag succeeds
    let etag2: string;
    try {
      const r = await store.putCompareAndSwap(key, v2, etag);
      etag2 = r.etag || (await store.get(key)).etag;
    } catch (err) {
      return { ok: false, failedCheck: "cas", message: describe(err) };
    }

    // 4. CAS with a STALE etag must precondition-fail
    try {
      await store.putCompareAndSwap(key, v3, etag);
      return {
        ok: false,
        failedCheck: "stale-cas-precondition",
        message: "stale-etag CAS unexpectedly succeeded — store ignores If-Match",
      };
    } catch (err) {
      if (!isStoreErrorOfKind(err, StoreErrorKind.PreconditionFailed, StoreErrorKind.Conflict)) {
        return { ok: false, failedCheck: "stale-cas-precondition", message: describe(err) };
      }
    }

    void etag2;
    return { ok: true };
  } finally {
    // best-effort cleanup — capability objects are the only thing we delete.
    await store.delete(key).catch(() => undefined);
  }
}

function describe(err: unknown): string {
  if (err instanceof StoreError) return `${err.kind}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
