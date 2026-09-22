# MultiZen Cloud Sync — Operator & Provisioning Documentation

Operator-facing documentation for the MultiZen Cloud Sync MVP: a
system that lets a browser profile move safely between Macs with a single active
writer, encrypted backups, and no silent state merges — **with no coordination
backend to deploy or run**.

Ownership leases and revisions are coordinated by **atomic conditional writes to
the same private object store** that holds the encrypted profile bytes. There is
**no Worker, no Durable Object, no application server, and no cloud compute** in
this design. The desktop uses [`@multizen/s3-coordinator`](../../packages/s3-coordinator)
(built on `@aws-sdk/client-s3` `3.1136.0`) against a private Cloudflare R2, AWS
S3, or capability-verified generic S3 endpoint. The **same per-device S3
credentials** authenticate both the Kopia data plane and the coordination
control plane.

> **Whole-library, automatic.** Cloud Sync coordinates the **entire profile
> library** with no manual lease buttons in the normal workflow. Once Cloud Sync
> is **ready** (global switch on, bucket + S3 key pair + encryption password set,
> and a successful capability probe), the desktop runs a single-flight
> **library bootstrap** — at startup and whenever readiness becomes true. The
> bootstrap restores every remote profile missing locally (never overwriting
> same-id local data), enables sync for the whole library, and uploads local
> changes; running profiles defer their upload to close. From then on: launching
> a synced profile **auto-acquires** its lease and restores/conflict-checks the
> latest revision, and closing the browser **publishes automatically and then
> releases** the lease. On failure the profile stays **dirty** and the lease is
> **kept** for an automatic retry (journaled + secret-redacted). Advanced retry
> tools (Acquire / Restore / Back up now / Release; connect a single profile by
> id) remain available as fallbacks, and **Sync all** re-runs the library
> bootstrap on demand.
>
> **Deleting a profile's backup.** Unchecking "Sync this profile" is a
> **destructive remote-disable**, not a local flag: after a strong typed
> confirmation the desktop writes a durable tombstone, deletes that profile's
> Kopia snapshot manifests, and only then disables local sync. The local profile
> and its data always stay on the device. This is an **immediate logical
> deletion**; physical reclamation of shared deduplicated chunks is **eventual**
> (Kopia maintenance GC). See [operations.md](./operations.md).

## Read in this order

| Doc | What it covers |
| --- | --- |
| [architecture.md](./architecture.md) | Storage-native lease/revision coordination, the single per-profile `state.json`, conditional-write invariants, trust boundaries. |
| [deployment.md](./deployment.md) | Storage provisioning: private R2/S3 bucket, separate per-device object read/write/list credentials scoped to the bucket/prefix, non-secret vs secret config split, in-app capability probe. |
| [security.md](./security.md) | Credential inventory, Keychain-backed vault, secret exclusions, rotation & revocation, generic S3 fields, diagnostics redaction. |
| [operations.md](./operations.md) | Automatic whole-library sync (startup + readiness bootstrap, single-flight), the normal lifecycle (auto-acquire on launch → conflict-checked restore → close backup+publish → auto-release), Sync all retry, the global Enable Cloud Sync switch, the destructive per-profile remote-disable (tombstone + snapshot-manifest delete) with strong typed confirmation and re-enable/revive, conflict-copy behavior, lease-loss / sleep / crash caveats, recovery/rollback, pinned Kopia licensing. |
| [acceptance.md](./acceptance.md) | Exact two-Mac acceptance checklist, failure matrix, and the explicit list of deferred features. |

## No backend to deploy

There is **no server-side compute** to provision. Coordination is pure
object-storage I/O:

- One persistent `state.json` per profile under the control prefix holds the
  lease, revision, and idempotency record. All transitions are conditional
  `PutObject` calls (`If-None-Match: *` for the one-time create, then `If-Match`
  ETag compare-and-swap for every update).
- Correctness rests entirely on the object store enforcing **strong consistency**
  and conditional-write preconditions — validated by an in-app forced capability
  probe before any writable operation runs.

The only externally provisioned resources are the **private bucket** and
**per-device S3 credentials**. See [deployment.md](./deployment.md).

## What is and is not verified in these docs

These documents are derived from the **code and configuration in this
repository** (`packages/s3-coordinator/**`, `packages/sync-core/**`,
`packages/kopia-adapter/**`, `apps/desktop/src/main/sync/**`,
`packages/settings-store/**`). State-object shapes, error codes, object keys,
conditional-write semantics, config fields, and Kopia argv are quoted from
source.

Live Cloudflare R2 / AWS S3 access and two-physical-Mac acceptance runs
**require operator-supplied credentials and hardware** and have **not** been
executed as part of authoring this documentation. Every command that touches a
real account or device is presented as a procedure to run, not as a result. All
examples use placeholder values and never contain real secrets. There is **no
cloud compute deployment step** in any of these procedures.
