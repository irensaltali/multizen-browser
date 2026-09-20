# Architecture — Control Plane vs Data Plane

MultiZen Cloud Sync is deliberately split into two independent planes. The
separation is the central security and reliability property of the system: the
coordination backend is **never** in the path of profile bytes, and the object
store **never** participates in ownership decisions.

```
                        CONTROL PLANE                         DATA PLANE
             (ownership + revision metadata)          (encrypted profile bytes)

  ┌──────────────────────────────────────────┐   ┌──────────────────────────────┐
  │  Cloudflare Worker  (multizen-sync-backend)│   │  Cloudflare R2 (or S3)         │
  │  ├─ GET  /health                           │   │  private bucket                │
  │  ├─ GET  /v1/profiles/:id                  │   │  └─ Kopia repository           │
  │  ├─ POST /v1/profiles/:id/acquire          │   │     (encrypted, deduplicated)  │
  │  ├─ POST /v1/profiles/:id/renew            │   └───────────────▲────────────────┘
  │  ├─ POST /v1/profiles/:id/publish          │                   │
  │  └─ POST /v1/profiles/:id/release          │                   │ S3 API
  │                                            │                   │ (per-device
  │  ProfileCoordinator Durable Object         │                   │  credentials)
  │  (one per profileId, SQLite-backed)        │                   │
  │  ├─ currentRevision (authoritative)        │                   │
  │  ├─ ownerDeviceId + lease + fencingToken   │                   │
  │  └─ immutable revision rows                │                   │
  └───────────────▲────────────────────────────┘                  │
                  │ Cloudflare Access JWT                          │
                  │ (service token per Mac)                        │
  ┌───────────────┴────────────────────────────────────────────────┴───────────┐
  │  MultiZen desktop (Electron, macOS)                                          │
  │  ├─ SyncController         drives the manual workflow                        │
  │  ├─ CoordinationClient     talks to the Worker (control plane)               │
  │  ├─ KopiaAdapter           drives `kopia` → R2/S3 directly (data plane)      │
  │  ├─ CredentialVault        Keychain-backed encrypted secret store           │
  │  └─ local SQLite           per-profile sync state (revisions, dirty flag)   │
  └──────────────────────────────────────────────────────────────────────────────┘
```

## Control plane — coordination backend

Source: `services/sync-backend/`.

- A Cloudflare **Worker** plus **one SQLite-backed `ProfileCoordinator`
  Durable Object per `profileId`**. `idFromName(profileId)` maps every profile
  to exactly one DO instance, so all coordination for a profile is serialized on
  one object regardless of which edge served the request
  (`services/sync-backend/src/worker.ts`).
- The backend is **authoritative for ownership leases and revision metadata
  only**. It has **no R2 binding** — this is enforced by omission in
  `services/sync-backend/src/env.ts`, which documents: *"No R2 binding is
  declared here by design … Object storage (Kopia repository in R2/S3) is
  handled out-of-band by the desktop client and is intentionally not reachable
  from this Worker."*
- Endpoints (`services/sync-backend/src/worker.ts`):

  | Method | Path | Auth | Purpose |
  | --- | --- | --- | --- |
  | GET | `/health` | none | Liveness probe |
  | GET | `/v1/profiles/:id` | Access | Current coordination state |
  | POST | `/v1/profiles/:id/acquire` | Access | Acquire single-writer lease |
  | POST | `/v1/profiles/:id/renew` | Access | Extend the lease |
  | POST | `/v1/profiles/:id/publish` | Access | Publish a new immutable revision (CAS) |
  | POST | `/v1/profiles/:id/release` | Access | Release the lease |

### Coordination invariants (from source)

- **45 s default lease, 15 s recommended renewal**, both returned in every
  lease response; `leaseTtlMs` is overridable per request and via
  `DEFAULT_LEASE_TTL_MS` (`wrangler.jsonc`).
- **Opaque lease ids, stored hashed** — the client receives a random 256-bit
  token; only its SHA-256 hash is persisted (`services/sync-backend`).
- **Monotonic fencing tokens** — incremented only on *ownership change*
  (acquire / takeover of an expired lease), stable across renewals
  (`packages/sync-core/src/decisions.ts::evaluateLease`).
- **Expected-revision CAS** — `publish` succeeds only when `expectedRevision`
  equals the authoritative `currentRevision`, else `REVISION_CONFLICT`.
- **Operation-id idempotency** — every mutating call caches its result by
  `operationId`; retries replay the stored response with no side effects.
- **Deterministic error codes** — `services/sync-backend/src/errors.ts` maps
  each code to a stable HTTP status (`LEASE_HELD` 409, `REVISION_CONFLICT` 409,
  `VALIDATION_FAILED` 422, `UNAUTHORIZED` 401, `FENCING_TOKEN_INVALID` 409, …).

## Data plane — object storage

- The encrypted profile bytes live in a **Kopia repository inside a private R2
  bucket** (or any S3-compatible endpoint).
- The desktop app talks to R2/S3 **directly** via the bundled `kopia` binary —
  there is no proxy through the Worker. This is the "direct desktop-to-R2 data
  flow": snapshots, deduplication, encryption, compression, and restore are all
  performed client-side by Kopia (`packages/kopia-adapter/`).
- Kopia's repository encryption means R2/S3 stores only ciphertext. The
  repository password is the root of that encryption and lives in the OS
  Keychain, never in object storage or the control plane.

## Desktop client

Source: `apps/desktop/src/main/sync/`.

- **`SyncController`** orchestrates the manual workflow, holds an in-memory
  lease per profile with an auto-renew timer, gates launches, and marks
  profiles dirty. It **never merges** Chromium state.
- **`CoordinationClient`** is a thin HTTP client that mirrors the Worker
  contract exactly and authenticates with a Cloudflare Access **service token**
  via `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
- **`KopiaAdapter`** builds shell-free argv and injects secrets via the child
  process environment only (never argv).
- **`CredentialVault`** stores secrets encrypted at rest via Electron
  `safeStorage` (Keychain-backed on macOS), `chmod 0600`.
- **Local SQLite** (`profile-manager`) holds per-profile sync state:
  `localRevision`, `baseRevision`, `remoteRevision`, `dirty`,
  `latestSnapshotId`, `lastSyncedAt`.

## Revision & lease model

Each successful publish creates a new **immutable revision** (monotonic
integer). The desktop tracks three revisions per profile:

- `localRevision` — what this device has materialized on disk.
- `baseRevision` — the revision this device's edits branched from (the CAS
  anchor on publish).
- `remoteRevision` — best-known authoritative revision from the backend.

The pure decision logic in `packages/sync-core/src/decisions.ts` classifies
every open/close using three-way (base/local/remote) reasoning and **never
merges**: a true divergence is always reported as a conflict, and the resolution
is to keep both copies.

## Trust boundaries

1. **Desktop ↔ Worker** — Cloudflare Access JWT (service token). The Worker
   verifies the JWT against the team JWKS, pinning issuer and audience.
2. **Desktop ↔ R2/S3** — per-device S3 API credentials scoped to the sync
   bucket, plus the Kopia repository password (repository-level encryption).
3. **Worker ↔ R2** — *none by design.* The control plane cannot read or write
   profile bytes.

The consequence: compromising the coordination backend cannot leak profile
contents (it never sees them), and compromising a single device's S3 credential
can be revoked without rotating the whole fleet (see
[security.md](./security.md#rotation--revocation)).
