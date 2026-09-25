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

- Endpoint URL: `https://<accountid>.r2.cloudflarestorage.com` — used as the
  coordinator endpoint; Kopia receives its host without the scheme.
- **Enter the endpoint *origin* only — no bucket path.** Cloudflare's dashboard
  sometimes shows an "S3 API" URL that already includes the bucket, e.g.
  `https://<accountid>.r2.cloudflarestorage.com/<bucket>`. The desktop
  **normalizes any endpoint to its origin** (scheme added if missing;
  path/query/fragment/userinfo removed) using the single
  `@multizen/s3-coordinator` `normalizeEndpoint` rule, and stores + uses that
  origin for the coordinator and diagnostics, then derives a bare host for
  Kopia's `--endpoint`. Kopia rejects a URL there with *"Endpoint url cannot
  have fully qualified paths"*, while the S3 connection test accepts the origin.
  Existing profiles that were saved with a path are fixed
  automatically on next use — no need to re-enter the endpoint. Put the bucket
  name in the **Bucket** field, not the endpoint. A malformed or non-`http(s)`
  endpoint is rejected with an actionable invalid-input error rather than being
  silently coerced.
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

## 4. Save credentials and start automatic library sync

In **Settings → Cloud Sync** on each Mac:

1. Fill in the non-secret S3 fields (endpoint, region, bucket, backup-data
   prefix, control prefix, path-style, timings, device name). In the product UI
   the repository object prefix (`s3Prefix`) is labeled **Backup data prefix**.
2. Save the S3 access key id, S3 secret access key, and encryption password.
   Once the final value is present, MultiZen automatically probes reachability
   and conditional-write support, then discovers/restores the whole remote
   profile library. No Sync IDs or separate test click are required.
3. **Test S3 connection** (`sync:testCoordination`) remains available as optional
   diagnostics. It tests storage only, so the encryption password is not
   required for that button and is not validated by a successful result.

## 5. Capability gate for generic S3 endpoints

R2 and AWS S3 are known-good. Any **other** S3-compatible endpoint is only
usable once the conditional-write capability probe succeeds. Automatic setup
runs this probe; **Test S3 connection** repeats it for diagnostics/retry. The
coordinator refuses writable operations until it passes
(`coordinator.ts::ensureWritable`). The probe validates four invariants against
a unique throwaway object under `<controlPrefix>/capabilities/`:

1. create succeeds, 2. duplicate create precondition-fails,
3. CAS succeeds, 4. stale-etag CAS precondition-fails.

If any invariant fails, the test reports the failing check
(`create` / `duplicate-create-precondition` / `cas` /
`stale-cas-precondition` / `unreachable`) and sync stays blocked for that store.
This is the safeguard that keeps a store which silently ignores `If-Match` /
`If-None-Match` from ever coordinating a lease.

## 6. Encrypted storage is created automatically on first backup

There is **no manual "initialize repository" step**. The first time any device
runs **Backup & Publish**, MultiZen automatically sets up the encrypted storage
via `KopiaAdapter.ensureRepository`: it connects if the repository already
exists and creates it **only** when the pinned Kopia 0.23.1 `repository not
initialized in the provided storage` condition is detected. Auth, network,
corruption, and wrong-password errors never trigger creation, and a concurrent
creation race is resolved with one safe reconnect. Restore and Connect Existing
only ever connect — they never create an empty repository. See
[operations.md](./operations.md#automatic-encrypted-storage-setup-create-on-first-backup-connect-thereafter).

## 7. Connect a second Mac

On Mac B, fill in the **same** non-secret storage config (including the same
backup-data prefix), save that Mac's **own** separate S3 credentials, and enter
the **same encryption password** (the shared encryption root). Then use
**Connect Existing** for a profile, or enable + Acquire + Restore. No manual
initialization and no repository re-creation — Mac B connects to the repository
that Mac A's first backup created.

## 8. What acceptance still requires

Live R2 / AWS / generic-S3 read/write and the two-physical-Mac end-to-end round
trip **require operator-supplied credentials and hardware**. There is, again,
**no cloud compute to provision** — only the bucket and per-device credentials
above. For the full two-Mac procedure and pass/fail criteria, see
[acceptance.md](./acceptance.md).
