# Security Guide

Covers the credential inventory, the Keychain-backed vault, secret exclusions,
rotation & revocation, generic S3 fields, and diagnostics redaction. There is
**no coordination backend, no service token, and no Cloudflare Access** — the
same per-device S3 credentials authenticate both the Kopia data plane and the
conditional-write control plane. All behavior below is enforced in source; file
references are given inline.

## Credential inventory

| Secret | Where it lives | How it is used | Never in |
| --- | --- | --- | --- |
| Kopia repository password | Keychain vault (`kopiaPassword`) | Injected as `KOPIA_PASSWORD` env for every Kopia call | argv, settings.json, object storage, logs |
| S3/R2 access key id | Keychain vault (`s3AccessKeyId`) | Injected as `AWS_ACCESS_KEY_ID` env for Kopia; passed to the SDK client config for the coordinator | argv, settings.json, logs |
| S3/R2 secret access key | Keychain vault (`s3SecretAccessKey`) | Injected as `AWS_SECRET_ACCESS_KEY` env for Kopia; passed to the SDK client config for the coordinator | argv, settings.json, logs |

Cloud Sync itself has only **three** secrets, and they are shared across both
planes. The same vault also holds gateway secrets that Cloud Sync never touches —
the device signing key, the per-repository sync salt, MCP project secrets and
bearer tokens, and (if enabled) the credential-backup passphrase. Those are listed
in [credential-backup.md](./credential-backup.md); the reserved `mcp-gateway:`
name prefix keeps the two sets from ever colliding. Source of truth for the three
Cloud Sync secrets: `SyncConfig` / `SYNC_DEFAULTS`
(`packages/settings-store/src/index.ts`), `SecretKind`
(`apps/desktop/src/main/sync/types.ts` — `"kopiaPassword" | "s3AccessKeyId" |
"s3SecretAccessKey"`), and `KopiaSecrets` (`packages/kopia-adapter/src/env.ts`).
The coordinator's S3 credentials are held **only** inside the SDK client config;
the effective-config fingerprint hashes credential material rather than storing
it (`apps/desktop/src/main/sync/StorageCoordinator.ts`).

## Keychain-backed vault

`SafeStorageCredentialVault` (`apps/desktop/src/main/sync/CredentialVault.ts`):

- Encrypts every value with Electron `safeStorage` — **Keychain-backed on
  macOS**, DPAPI on Windows, libsecret on Linux.
- Writes the vault file with `chmod 0600` and re-enforces the mode on every
  write.
- **Refuses to run if OS secure storage is unavailable** rather than silently
  storing plaintext.
- Exposes only `set` / `get` / `has` / `delete` / `names`. `names()` returns key
  names, never values.

The desktop config stores **credential reference names** (pointers to vault
entries: `kopiaPasswordRef`, `s3AccessKeyIdRef`, `s3SecretAccessKeyRef`), never
the values. Secrets are write-only from the UI: `sync:saveSecret` accepts a
value, `sync:deleteSecret` removes one, and there is **no IPC that reads a secret
back** (`apps/desktop/src/main/sync/registerSyncIpc.ts`).

## Secret exclusions — where secrets are guaranteed absent

### What syncs vs what never syncs

Whole-library Cloud Sync uploads **all browser profile data** (cookies, local
storage, IndexedDB, Chromium user-data-dir contents) plus a **sanitized profile
manifest** (name, notes, tags, fingerprint, proxy host/port/type, icon,
startUrl, searchProvider, proxyCountry, timestamps) and the profile's
extensions.

It **never** syncs:

- S3/R2 access key id + secret access key
- the Kopia encryption password
- the credential-backup passphrase (`mcp-gateway:credential-bundle-passphrase`)
- the gateway device signing key (`mcp-gateway:device-signing-key-pem`)
- the MCP **server's** app-level bearer token (distinct from the gateway's
  per-project tokens, which are eligible for the opt-in credential bundle below)
- the device id / device display name
- executable / config paths (Kopia binary path, Kopia config path)
- proxy passwords (the manifest carries host/port/type only — the user
  re-enters credentials on the receiving device)
- activity logs
- `settings.json` wholesale — see the shared/device-local split below

#### Two exclusions that are narrower than they used to be

Both of the following were once blanket "never" statements. They are not any
more, and stating the old version would be wrong:

**The OS keychain is no longer categorically excluded.** It is excluded *by
default*, and an explicitly allow-listed subset — MCP project secrets
(`mcp-gateway:project-secret:<projectId>:<NAME>`) and project bearer tokens
(`mcp-gateway:project-token:<projectId>`) — is admitted **only** when the
operator switches on credential backup and supplies a second passphrase. The
allow-list is default-deny and is enforced at three independent points: when a
bundle is sealed, when one is opened, and at the vault write boundary. The
exclusions above are enforced in the same places, so a bug in one layer cannot
admit a bucket credential or the signing key. See
[credential-backup.md](./credential-backup.md) for the format and threat model.

**App settings partially sync.** A named subset travels as a shared document:
`theme`, `mcpHttpEnabled`, `autoUpdate`, `engineAutoUpdate`. Everything else is
device-local by an allow-list (`SHARED_SETTINGS_KEYS` in
`packages/settings-store/src/shared.ts`), so a field added to `AppSettings` later
cannot start travelling by accident. The deliberately device-local fields are
`browserEngine` (a platform-specific binary), `mcpHttpPort` (a local listener
that can collide), and the entire `sync` block (device identity the trust/lease
systems depend on, plus the bucket coordinates and credential reference names —
which cannot travel inside the bucket they describe). A remote document that
omits a field leaves the local value untouched, so an older peer publishing a
smaller document cannot blank a setting it never knew about.


- **Not on argv.** Kopia secrets flow only through the child environment
  (`KOPIA_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`); the command builders deliberately do **not** emit
  `--password` / `--access-key` / `--secret-access-key`
  (`packages/kopia-adapter/src/commands.ts`, `env.ts`).
- **Not in the config file.** Every Kopia invocation carries
  `--no-persist-credentials` so the pinned 0.23.1 CLI never writes repository
  credentials into its config file (Kopia defaults `persist-credentials` to
  true; MultiZen always negates it). This is the **only** credential-hardening
  flag emitted. Kopia 0.23.1 does not expose the newer `use-keyring` or
  `auto-maintenance` global flags, so the adapter does not emit them — it does
  **not** programmatically disable auto-maintenance; retention/maintenance
  remain operator-controlled (`commands.ts::globalArgs`, and see
  [operations.md](./operations.md#orphan-snapshots)).
- **Not in a coordination backend.** There is no backend to hold secrets — the
  coordinator runs in-process in the desktop and stores its credentials only in
  the SDK client config.
- **Not in the profile snapshot.** The sanitized manifest written into each
  snapshot (`.multizen-sync/profile-manifest.json`) omits proxy credentials and
  machine-local absolute paths; on `connectExisting` the user re-enters proxy
  credentials (`SyncController.writeManifest`, `manifestProxyToConfig`).
- **Not in logs / diagnostics / journal / argv.** See redaction below.

## Diagnostics & log redaction

- Kopia's captured stdout/stderr is scrubbed of secret values before being
  surfaced or stored: `NodeProcessRunner` redacts using `secretValues(secrets)`
  (`packages/kopia-adapter/src/process-runner.ts`, `env.ts`).
- The `SyncController` redacts every operation message and error via
  `redact` / `redactError` against the current known secret values before
  emitting progress events or recording sync-operation rows
  (`apps/desktop/src/main/sync/redaction.ts`, `SyncController.ts`).
- Redaction replaces longer secrets first (so a secret that is a substring of
  another is not left partially exposed) and ignores strings shorter than 4
  chars so redaction can't collapse an entire message to markers.
- The diagnostics snapshot (`sync:diagnostics`) reports **presence booleans**
  for each secret (`secretsPresent.{kopiaPassword,s3AccessKeyId,s3SecretAccessKey}`),
  store health, the last conditional-write capability probe result, the bucket +
  control prefix, the device id / display name, and the resolved (non-secret)
  Kopia binary path — **never any secret value, and never SDK/client credentials**
  (`apps/desktop/src/main/sync/types.ts::SyncDiagnostics` /
  `SyncDiagnosticsExport`).

## Generic S3 fields

The target is S3-compatible, so the same fields serve Cloudflare R2, AWS S3, or
any generic S3 endpoint that passes the capability probe (`S3Repository` in
`packages/kopia-adapter/src/commands.ts` and `S3StoreConfig` in
`packages/s3-coordinator/src/s3Store.ts`, surfaced as `SyncConfig`):

| Field | Cloudflare R2 | AWS S3 | Generic S3 |
| --- | --- | --- | --- |
| `s3Endpoint` | `<accountid>.r2.cloudflarestorage.com` | omit (or `s3.amazonaws.com`) | provider host |
| `s3Region` | `auto` | real region, e.g. `us-east-1` | provider region |
| `s3Bucket` | bucket name | bucket name | bucket name |
| `s3Prefix` (Kopia) | key prefix | key prefix | key prefix |
| `controlPrefix` | control key prefix | control key prefix | control key prefix |
| `s3ForcePathStyle` | often `true` | `false` | provider-dependent |
| Access key / secret | R2 S3 API token | IAM access key | provider key pair |

Credentials are intentionally **absent** from the repository target shape and
from the coordinator's serializable config; they flow through the Kopia
environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, plus optional
`AWS_SESSION_TOKEN`) and through the SDK client config for the coordinator.

## Rotation & revocation

Because the **same per-device S3 credential** authenticates both planes, rotating
or revoking it affects both — this is the central security tradeoff of the
backend-free design (see [threat-model notes](#threat-model-notes)).

### S3 / R2 API credential (per Mac, both planes)

- **Rotate:** mint a new bucket-scoped S3 credential for that Mac, update
  `s3AccessKeyId` / `s3SecretAccessKey` in the vault, then delete the old
  credential in R2/IAM. The coordinator rebuilds its client on the next call
  because the effective-config fingerprint changed.
- **Revoke a single Mac:** delete that Mac's S3 credential. That device can no
  longer read/write the Kopia repository **or** the coordination control state;
  other Macs keep working because each has its own credential.
- The desktop distinguishes auth failure from unreachability: `401/403` normalize
  to `StorageAuthFailed` (so the UI points at the S3 credentials), network/DNS/
  TLS/5xx to `StorageUnreachable` (`packages/s3-coordinator/src/s3Store.ts::normalizeError`,
  `coordinator.ts::wrap`).

### Kopia repository password (data plane, shared)

- The Kopia repository password — surfaced in the product UI as the
  **Encryption password** — is **shared across all Macs that connect to the
  same repository**; it is the encryption root; only holders can decrypt
  snapshots. See
  [operations.md](./operations.md#shared-encryption-password-provisioning).
- **Rotating the repository password is a heavy operation** for the MVP: treat
  it as a repository migration (stand up a new repository, re-establish it on the
  first Mac, reconnect the others). There is no in-app password rotation flow —
  a documented [deferred feature](./acceptance.md#deferred-features).

### Lost or decommissioned device

1. Delete the device's **S3 API credential** (cuts both data-plane and
   control-plane access in one step).
2. If the device may still hold the Kopia repository password and is a real loss
   (theft), plan a repository password migration as above, since the password
   decrypts all snapshots.

## Threat-model notes

- **Kopia encrypts profile bytes.** A leaked S3 credential exposes only
  ciphertext of the data plane; without the Kopia password the snapshots cannot
  be decrypted.
- **The same credential can alter control state.** Because the control plane is
  just objects in the bucket, a holder of the S3 credential can also read and
  write the lease/revision `state.json`. **Confidentiality of profile contents**
  rests on the Kopia password; **availability and control integrity** rest on
  guarding the bucket credentials. This is the deliberate tradeoff of having no
  separate coordination backend.
- **Per-device revocation** limits blast radius: deleting one Mac's credential
  cuts that device off from both planes without re-keying the fleet.
- **Bucket lifecycle rules must exclude control state and active revisions.**
  The persistent `state.json` per profile is **never deleted** by the app and is
  authoritative; immutable revision records for still-active revisions must
  likewise survive. Do **not** configure bucket lifecycle expiration/deletion
  that would remove `<controlPrefix>/profiles/**/state.json` or in-use
  `<controlPrefix>/revisions/**` objects. (Only the transient
  `<controlPrefix>/capabilities/**` probe objects are safe to expire; the app
  best-effort deletes them itself.)
- **Fencing tokens prevent stale-owner overwrites.** A device whose clock or
  connectivity recovered after another device took over presents a stale fencing
  token and is rejected (`LeaseFenced`), and expected-revision CAS rejects a
  mismatched revision (`PublishRejected`)
  (`packages/s3-coordinator/src/coordinator.ts::requireOwner` / `applyPublish`).
- **No secrets in manifests, logs, diagnostics, or argv** — enforced as above.
