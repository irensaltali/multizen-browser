# Architecture — Storage-Native Coordination

MultiZen Cloud Sync coordinates a single active writer per profile using
**nothing but atomic conditional writes to an object store**. There is **no
Worker, no Durable Object, no application server, and no cloud compute**: the
control plane (ownership leases + revision metadata) and the data plane
(encrypted profile bytes) live in the **same private bucket**, separated only by
key prefix. Correctness rests entirely on the store enforcing strong consistency
and conditional-write preconditions.

```
                         ONE PRIVATE OBJECT STORE (R2 / AWS S3 / generic S3)
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  CONTROL PLANE  <controlPrefix>/          DATA PLANE  <kopiaPrefix>/         │
  │  ├─ profiles/<id>/state.json  ← authoritative   └─ Kopia repository         │
  │  │     lease / leaseId / expiry / fencingToken       (encrypted, dedup)     │
  │  │     currentRevision / latestSnapshotId                                    │
  │  │     lastOperation (idempotency)                                          │
  │  ├─ revisions/<rev>-<op>.json ← immutable, best-effort history              │
  │  └─ capabilities/<uuid>.json  ← transient capability-probe objects          │
  └───────────────────────────────▲───────────────────────────────▲────────────┘
              conditional PUT      │                               │  Kopia S3
              (If-None-Match / If-Match), GET, HEAD                │  backend
                                   │                               │
  ┌────────────────────────────────┴───────────────────────────────┴───────────┐
  │  MultiZen desktop (Electron, macOS)                                          │
  │  ├─ SyncController          drives the sync workflow (auto backup on close)  │
  │  ├─ StorageCoordinator      builds @multizen/s3-coordinator (S3Coordinator)  │
  │  │      → @aws-sdk/client-s3 3.1136.0 conditional writes (control plane)     │
  │  ├─ KopiaAdapter            drives `kopia` → R2/S3 directly (data plane)     │
  │  ├─ CredentialVault         Keychain-backed encrypted secret store          │
  │  └─ local SQLite            per-profile sync state (revisions, dirty flag)   │
  └──────────────────────────────────────────────────────────────────────────────┘
```

Both planes are reached with the **same per-device S3 credentials**. There is no
second control-plane credential and no service token.

## Control plane — the per-profile state object

Source: `packages/s3-coordinator/` (used by
`apps/desktop/src/main/sync/StorageCoordinator.ts`).

There is exactly **one persistent state object per profile** at:

```
<controlPrefix>/profiles/<profileId>/state.json
```

It is created **once** and thereafter **only ever CAS-updated**. It is **never
deleted** — release clears the ownership fields but keeps the object so the
revision line and idempotency record survive
(`packages/s3-coordinator/src/state.ts`, `coordinator.ts::applyRelease`). The
document holds (`ProfileState` in `state.ts`):

- `currentRevision` — authoritative monotonic revision integer.
- `latestSnapshotId` — the Kopia snapshot the current revision points at.
- `ownerDeviceId`, `leaseId`, `leaseExpiresAt` — the single-writer lease.
- `fencingToken` — monotonic, incremented only on **ownership change**
  (acquire / takeover of a free-or-expired lease), stable across renewals.
- `lastOperation` — a bounded idempotency record of the most recent mutating
  call (`operationId`, kind, resulting revision/fencing/lease), enabling
  idempotent retries.

Every field decoded from storage is type/range/size-validated; malformed or
oversized state is rejected (`StoreErrorKind.Malformed`) rather than trusted, so
a corrupt or hostile object cannot drive the coordinator into an inconsistent
decision (`state.ts::decodeState`, `MAX_STATE_BYTES = 64 KiB`).

### State transitions are conditional writes

All coordination is a `read → validate → conditional write` loop over that one
object (`coordinator.ts`):

- **Initialization** — the state object is created with `If-None-Match: *`
  (`putCreate`). A lost create race resolves by reading the winner's object.
- **Every update** — acquire, renew, publish, release read the current object
  (capturing its opaque ETag), decide, then write back with `If-Match: <etag>`
  compare-and-swap (`putCompareAndSwap`).
- **Losing CAS retries from a fresh read.** A `412 PreconditionFailed` or `409`
  conflict is retryable: the coordinator re-reads, re-evaluates, and either
  commits or fails deterministically if it now observes another owner/takeover
  (`runCas`, `maxCasRetries` default 8). It never clobbers a newer owner.

### Immutable revision records (secondary)

On a successful publish the coordinator **best-effort** writes an immutable
history record at `<controlPrefix>/revisions/<revision>-<operationId>.json` with
`putImmutable` (`If-None-Match: *`). A failure here is surfaced as a non-fatal
`historyWarning` and **does not undo** the committed state CAS. **The `state.json`
object is authoritative**; history records are for audit/best-effort only
(`coordinator.ts::writeHistory`).

### Coordination invariants (from source)

- **60 s default lease, 15 s recommended renewal, 10 s clock-skew safety
  margin** (`S3CoordinatorConfig` defaults in `coordinator.ts`; `SYNC_DEFAULTS`
  in `packages/settings-store/src/index.ts`). All are operator-configurable.
- **Opaque, random lease ids** — a fresh `randomUUID()` lease id is minted on
  each grant/takeover.
- **Monotonic fencing tokens** — incremented on ownership change, stable across
  renewals; a stale token is rejected (`LeaseFenced`).
- **Expected-revision CAS** — `publish` succeeds only when `expectedRevision`
  equals the authoritative `currentRevision`, else `PublishRejected`.
- **Operation-id idempotency** — every mutating call records its `operationId`
  in `lastOperation`; a replay of the same id reconstructs the accepted result
  with no second increment.
- **Server clock when available** — lease expiry is evaluated against the
  store's `Date` response header when the store exposes it, captured per-request
  by a request-scoped middleware; otherwise the coordinator falls back to local
  time and applies the same clock-skew margin conservatively (`s3Store.ts`,
  `coordinator.ts::effectiveNow` / `takeoverAllowed`).
- **Deterministic error codes** — store failures normalize to
  `StoreErrorKind` (`NotFound`, `PreconditionFailed`, `Conflict`, `AuthFailed`,
  `Unreachable`, `Malformed`) and map to `SyncErrorCode`
  (`StorageUnreachable`, `StorageAuthFailed`, `LeaseHeldByOther`, `LeaseFenced`,
  `LeaseExpired`, `PublishRejected`, `RevisionNotFound`, …) in
  `coordinator.ts::wrap` and `packages/sync-core/src/errors.ts`.

## Mandatory store guarantees + capability probe

The whole design depends on the store guaranteeing **read-after-write strong
consistency** and honoring `PutObject` `If-Match` / `If-None-Match`
preconditions. Both **Cloudflare R2 and AWS S3** provide this.

A **generic S3 endpoint is enabled only after an in-app forced capability
probe** proves the store enforces conditional writes (`capability.ts`,
`coordinator.ts::ensureWritable`). Before any writable operation the coordinator
runs (and caches) a probe that writes to a unique
`<controlPrefix>/capabilities/<uuid>` object and checks four invariants:

1. create (`If-None-Match: *`) on an absent key **succeeds**,
2. a duplicate create **precondition-fails** (store honors `If-None-Match`),
3. CAS (`If-Match: <current etag>`) **succeeds**,
4. CAS with a **stale** etag **precondition-fails** (store honors `If-Match`).

A store that silently ignores these preconditions would let two devices both
"win" a lease — a correctness catastrophe — so the coordinator **refuses to
coordinate** against a store that fails the probe (`StorageUnreachable` with the
failing check named). The probe object is cleaned up best-effort; it is the only
object the coordinator ever deletes.

## Data plane — object storage

- Encrypted profile bytes live in a **Kopia repository inside the same private
  bucket**, under the **separate** Kopia object prefix.
- The desktop talks to R2/S3 **directly** via the bundled `kopia` binary:
  snapshots, deduplication, encryption, compression, and restore are all
  client-side (`packages/kopia-adapter/`).
- Kopia repository encryption means the store holds only ciphertext. The
  repository password is the root of that encryption and lives in the OS
  Keychain, never in object storage.

## Desktop client

Source: `apps/desktop/src/main/sync/`.

- **`SyncController`** orchestrates the sync workflow, holds an in-memory
  lease per profile with an auto-renew timer, gates launches, marks profiles
  dirty, and **automatically backs up and publishes after the browser closes**
  (`onBrowserClosed`) when the profile is dirty and this device holds an
  unexpired lease. It **never merges** Chromium state.
- **`StorageCoordinator`** builds and caches one `S3Coordinator`
  (`@multizen/s3-coordinator`) per effective config + credential version, wiring
  an `S3ConditionalObjectStore` over `@aws-sdk/client-s3` `3.1136.0`. Credentials
  live only inside the SDK client config; the effective-config fingerprint hashes
  credential material rather than storing it.
- **`KopiaAdapter`** builds shell-free argv and injects secrets via the child
  process environment only (never argv).
- **`CredentialVault`** stores secrets encrypted at rest via Electron
  `safeStorage` (Keychain-backed on macOS), `chmod 0600`.
- **Local SQLite** (`profile-manager`) holds per-profile sync state:
  `localRevision`, `baseRevision`, `remoteRevision`, `dirty`,
  `latestSnapshotId`, `lastSyncedAt`.

## Revision & lease model

Each successful publish creates a new revision (monotonic integer) recorded in
the authoritative `state.json`. The desktop tracks three revisions per profile:

- `localRevision` — what this device has materialized on disk.
- `baseRevision` — the revision this device's edits branched from (the CAS
  anchor on publish).
- `remoteRevision` — best-known authoritative revision read from `state.json`.

The pure decision logic in `packages/sync-core/src/decisions.ts` classifies
every open/close using three-way (base/local/remote) reasoning and **never
merges**: a true divergence is always reported as a conflict, and the resolution
is to keep both copies.

## Trust boundaries

1. **Desktop ↔ object store** — per-device S3 API credentials scoped to the
   sync bucket/prefix. The **same** credentials authenticate both the
   conditional-write control plane and the Kopia data plane.
2. **Data-at-rest** — the Kopia repository password (repository-level
   encryption) protects profile bytes independently of the storage credentials.

The consequence: profile **contents** stay encrypted under the Kopia password,
so a leaked storage credential exposes only ciphertext of the data plane.
However, because the same credential can write the control plane, it can also
alter lease/revision state — availability and control integrity depend on
guarding the bucket credentials. Per-device credentials mean a lost/compromised
Mac can be revoked without re-keying the fleet (see
[security.md](./security.md#rotation--revocation)).
