# Storage Provisioning & Configuration Guide

This guide provisions the **only** externally managed resources Cloud Sync
needs: a **private object-storage bucket** and **per-device S3 API credentials**.
There is **no coordination backend to deploy** — no Worker, no Durable Object,
no application server, no cloud compute. Coordination happens entirely through
atomic conditional writes to the same bucket that holds the encrypted profile
bytes (see [architecture.md](./architecture.md)).

> **Live provisioning requires operator-supplied storage credentials.** The
> steps below are procedures to run against your own R2/AWS/S3 account. Nothing
> here has been executed against a live account while authoring this doc. All
> account ids, bucket names, keys, and secrets shown are placeholders. There is
> **no cloud compute deployment step**.

## Prerequisites

- A private object store that provides **strong read-after-write consistency**
  and honors `PutObject` `If-Match` / `If-None-Match` preconditions. **Cloudflare
  R2 and AWS S3 both qualify.** A generic S3-compatible endpoint is supported
  **only** if it passes the in-app capability probe (step 5).
- The MultiZen desktop app installed on each Mac (the coordinator ships inside
  the app via [`@multizen/s3-coordinator`](../../packages/s3-coordinator), built
  on `@aws-sdk/client-s3` `3.1136.0`). Nothing extra to install or run.

## 1. Create a private bucket

Create one bucket, e.g. `multizen-sync`. Keep it **private**:

- **No public access, no public bucket URL, no CDN/cache in front of it.** The
  control-plane objects are read-modify-write coordination state; a cache would
  break consistency, and there is nothing here meant to be served publicly.
- The bucket holds **both** planes, separated by key prefix:
  - the Kopia repository under the **Kopia prefix** (`s3Prefix`), and
  - the coordination control state under the **control prefix** (`controlPrefix`,
    default `multizen-control`).
  These prefixes **must stay separate** — the app rejects a control prefix that
  equals or nests inside the Kopia prefix (`StorageCoordinator.ts::assertSafeControlPrefix`).

### R2 specifics

- Endpoint host: `https://<accountid>.r2.cloudflarestorage.com` — used as the
  S3 `--endpoint` for Kopia and as the coordinator's endpoint.
- Region is typically `auto` (the desktop default).
- R2 commonly needs **path-style addressing** — set `s3ForcePathStyle` if your
  endpoint requires it.

### AWS S3 specifics

- You may omit a custom endpoint (default AWS resolution) or set
  `s3.amazonaws.com`.
- Use a **real region**, e.g. `us-east-1`.

## 2. Mint separate per-device S3 credentials

Create a **separate S3 API credential per Mac**, scoped to the sync bucket only:

- Grant **object read + write + list** on the single sync bucket (Kopia needs
  read/write/list within the repository prefix; the coordinator needs
  get/put/head — and conditional put — within the control prefix). Do **not**
  grant account-wide or admin scope. Scope to the bucket (and, where the provider
  supports it, to the `controlPrefix` and `s3Prefix` key prefixes).
- Each credential yields an **Access Key ID** and **Secret Access Key**.
- The **same per-device credential authenticates both planes** — there is no
  separate control-plane credential or service token.

Per-device credentials mean a lost/compromised Mac can be cut off by deleting
just its credential, without re-keying the fleet (see
[security.md](./security.md#rotation--revocation)).

## 3. Desktop sync configuration (non-secret vs secret split)

Non-secret config is stored in `settings.json` under `sync`
(`SyncConfig` / `SYNC_DEFAULTS` in `packages/settings-store/src/index.ts`) and is
editable from the app (**Settings → Cloud Sync**) / the `sync:updateConfig` IPC:

| Field | Example | Notes |
| --- | --- | --- |
| `s3Endpoint` | `<accountid>.r2.cloudflarestorage.com` | R2 (or generic S3) endpoint host; empty for AWS default |
| `s3Region` | `auto` | R2 default; a real region for AWS S3 |
| `s3Bucket` | `multizen-sync` | Private bucket holding **both** the Kopia repo and control state |
| `s3Prefix` | `repo/` | Object key prefix for the **Kopia repository** |
| `controlPrefix` | `multizen-control` | Object key prefix for the **coordination control plane**; MUST differ from `s3Prefix` |
| `s3ForcePathStyle` | `false` | Path-style S3 addressing (R2 / MinIO) |
| `leaseTtlMs` | `60000` | Lease time-to-live |
| `renewalMs` | `15000` | Recommended lease renewal interval |
| `clockSkewSafetyMs` | `10000` | Margin before an expired lease may be taken over |
| `deviceId` | `device_<hex>` | Minted once per install; never hardware-derived |
| `deviceDisplayName` | `Mac Studio` | Used in conflict-copy names + diagnostics |

Secrets are stored **only** in the Keychain-backed vault and set via the
`sync:saveSecret` IPC (`SecretKind`): `kopiaPassword`, `s3AccessKeyId`,
`s3SecretAccessKey`. They are write-only from the UI — never read back
(`apps/desktop/src/main/sync/registerSyncIpc.ts`,
`apps/desktop/src/main/sync/CredentialVault.ts`). There is **no service-token
secret** in this design.

## 4. Save credentials and test storage coordination

In **Settings → Cloud Sync** on each Mac:

1. Fill in the non-secret S3 fields (endpoint, region, bucket, Kopia prefix,
   control prefix, path-style, timings, device name).
2. Save the three secrets to the vault: the S3 access key id, S3 secret access
   key, and the Kopia repository password.
3. Run **Test storage coordination** (`sync:testCoordination`). This probes
   store reachability **and** runs a **forced conditional-write capability
   probe**. It passes only when the store is reachable/authorized **and**
   conditional writes are supported (`StorageTestResult.conditionalWritesSupported`
   is true).

## 5. Capability gate for generic S3 endpoints

R2 and AWS S3 are known-good. Any **other** S3-compatible endpoint is only
usable once **Test storage coordination** succeeds — the coordinator refuses to
perform any writable operation until the probe passes
(`coordinator.ts::ensureWritable`). The probe validates four invariants against
a unique throwaway object under `<controlPrefix>/capabilities/`:

1. create succeeds, 2. duplicate create precondition-fails,
3. CAS succeeds, 4. stale-etag CAS precondition-fails.

If any invariant fails, the test reports the failing check
(`create` / `duplicate-create-precondition` / `cas` /
`stale-cas-precondition` / `unreachable`) and sync stays blocked for that store.
This is the safeguard that keeps a store which silently ignores `If-Match` /
`If-None-Match` from ever coordinating a lease.

## 6. Initialize the Kopia repository — exactly once, on Mac A

The Kopia repository is created **once** on the primary Mac and connected to
from every other Mac. In **Settings → Cloud Sync** use **First-run: initialize
repository** (`sync:initializeRepository`) exactly once on Mac A. Do **not**
initialize again on Mac B — Backup, Restore, and Connect Existing connect to the
existing repository automatically. See
[operations.md](./operations.md#kopia-repository-initialize-on-first-mac-vs-connect-on-second).

## 7. Connect a second Mac

On Mac B, fill in the **same** non-secret storage config, save that Mac's
**own** separate S3 credentials, and enter the **same Kopia repository
password** (the shared encryption root). Then use **Connect Existing** for a
profile, or enable + Acquire + Restore. No repository re-creation.

## 8. What acceptance still requires

Live R2 / AWS / generic-S3 read/write and the two-physical-Mac end-to-end round
trip **require operator-supplied credentials and hardware**. There is, again,
**no cloud compute to provision** — only the bucket and per-device credentials
above. For the full two-Mac procedure and pass/fail criteria, see
[acceptance.md](./acceptance.md).
