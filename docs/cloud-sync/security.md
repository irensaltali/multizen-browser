# Security Guide

Covers the credential inventory, the Keychain-backed vault, secret exclusions,
rotation & revocation, generic S3 fields, and diagnostics redaction. All
behavior below is enforced in source; file references are given inline.

## Credential inventory

| Secret | Where it lives | How it is used | Never in |
| --- | --- | --- | --- |
| Kopia repository password | Keychain vault (`kopiaPassword`) | Injected as `KOPIA_PASSWORD` env for every Kopia call | argv, settings.json, object storage, logs |
| S3/R2 access key id | Keychain vault (`s3AccessKeyId`) | Injected as `AWS_ACCESS_KEY_ID` env | argv, settings.json, logs |
| S3/R2 secret access key | Keychain vault (`s3SecretAccessKey`) | Injected as `AWS_SECRET_ACCESS_KEY` env | argv, settings.json, logs |
| Access service-token **secret** | Keychain vault (`accessClientSecret`) | Sent as `CF-Access-Client-Secret` header | settings.json, logs |
| Access service-token **client id** | `settings.json` (`accessClientId`) | Sent as `CF-Access-Client-Id` header | — (public half) |

Source of truth: `SyncConfig` and `SYNC_DEFAULTS`
(`packages/settings-store/src/index.ts`), `SecretKind`
(`apps/desktop/src/main/sync/types.ts`), and `KopiaSecrets`
(`packages/kopia-adapter/src/env.ts`).

## Keychain-backed vault

`SafeStorageCredentialVault` (`apps/desktop/src/main/sync/CredentialVault.ts`):

- Encrypts every value with Electron `safeStorage` — **Keychain-backed on
  macOS**, DPAPI on Windows, libsecret on Linux.
- Writes the vault file with `chmod 0600` and re-enforces the mode on every
  write.
- **Refuses to run if OS secure storage is unavailable** rather than silently
  storing plaintext (constructor throws unless an explicit plaintext-fallback is
  requested, which the desktop does not do).
- Exposes only `set` / `get` / `has` / `delete` / `names`. `names()` returns
  key names, never values.

The desktop config stores **credential *reference names*** (pointers to vault
entries), never the values (`SyncConfig.*Ref` fields). Secrets are write-only
from the UI: the `sync:saveSecret` IPC accepts a value, `sync:deleteSecret`
removes one, and there is **no IPC that reads a secret back**
(`apps/desktop/src/main/sync/registerSyncIpc.ts`).

## Secret exclusions — where secrets are guaranteed absent

- **Not on argv.** Kopia secrets flow only through the child environment
  (`KOPIA_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`); the command builders deliberately do **not** emit
  `--password` / `--access-key` / `--secret-access-key`
  (`packages/kopia-adapter/src/commands.ts`,
  `packages/kopia-adapter/src/env.ts`).
- **Not in the config file.** Kopia is always invoked with
  `--no-persist-credentials`, preventing the pinned 0.23.1 CLI from
  intentionally persisting repository credentials. That version has no
  `use-keyring` global flag; MultiZen relies exclusively on its own
  Keychain-backed vault and never requests a second Kopia credential store
  (`commands.ts::globalArgs`).
- **Not in the coordination backend.** The Worker has no R2 binding and never
  receives storage credentials or profile bytes
  (`services/sync-backend/src/env.ts`).
- **Not in the profile snapshot.** The sanitized manifest written into each
  snapshot (`.multizen-sync/profile-manifest.json`) intentionally omits proxy
  credentials and machine-local absolute paths; on `connectExisting` the user
  re-enters proxy credentials (`SyncController.writeManifest`,
  `manifestProxyToConfig`).
- **Not in logs / diagnostics / journal.** See redaction below.

## Diagnostics & log redaction

- Kopia's captured stdout/stderr is scrubbed of secret values before being
  surfaced or stored: `NodeProcessRunner` redacts using `secretValues(secrets)`
  (`packages/kopia-adapter/src/process-runner.ts`,
  `packages/kopia-adapter/src/env.ts`).
- The `SyncController` redacts every operation message and error via
  `redact` / `redactError` against the current known secret values before
  emitting progress events or recording sync-operation rows
  (`apps/desktop/src/main/sync/redaction.ts`,
  `apps/desktop/src/main/sync/SyncController.ts`).
- Redaction replaces longer secrets first (so a secret that is a substring of
  another is not left partially exposed) and ignores strings shorter than 4
  chars so redaction can't collapse an entire message to markers.
- The diagnostics snapshot (`sync:diagnostics`) reports **presence booleans**
  for each secret (`secretsPresent.{kopiaPassword,s3AccessKeyId,…}`), the
  device id / display name, the resolved (non-secret) Kopia binary path, and the
  last backend health result — **never any secret value**
  (`apps/desktop/src/main/sync/types.ts::SyncDiagnostics`).

## Generic S3 fields

The data-plane target is S3-compatible, so the same fields serve Cloudflare R2,
AWS S3, or any generic S3 endpoint (`S3Repository` in
`packages/kopia-adapter/src/commands.ts`, surfaced as `SyncConfig`):

| Field | Cloudflare R2 | AWS S3 | Generic S3 |
| --- | --- | --- | --- |
| `s3Endpoint` (`--endpoint`) | `<accountid>.r2.cloudflarestorage.com` | omit (or `s3.amazonaws.com`) | provider host |
| `s3Region` (`--region`) | `auto` | real region, e.g. `us-east-1` | provider region |
| `s3Bucket` (`--bucket`) | bucket name | bucket name | bucket name |
| `s3Prefix` (`--prefix`) | key prefix | key prefix | key prefix |
| Access key / secret | R2 S3 API token | IAM access key | provider key pair |

Credentials are intentionally **absent** from the repository target shape and
flow through the environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, plus
optional `AWS_SESSION_TOKEN` for STS).

## Rotation & revocation

The two-plane split lets you rotate or revoke each plane independently, per
device.

### Cloudflare Access service token (control plane, per Mac)

- **Rotate:** create a new service token in Zero Trust, add it to the Service
  Auth policy, update `accessClientId` (settings) and `accessClientSecret`
  (vault) on that Mac via `sync:saveSecret`, then delete the old token.
- **Revoke a single Mac:** delete that Mac's service token in Cloudflare. The
  Worker will return `401 UNAUTHORIZED` for that device's calls; other Macs are
  unaffected because each has its own token.
- The desktop distinguishes an auth failure from a network failure: `401/403`
  map to `BackendAuthFailed` so the UI points the user at their Access client
  id/secret rather than at networking
  (`apps/desktop/src/main/sync/CoordinationClient.ts`).

### R2 / S3 API credentials (data plane, per Mac)

- **Rotate:** mint a new bucket-scoped S3 API token, update `s3AccessKeyId` /
  `s3SecretAccessKey` in the vault, then delete the old token in Cloudflare/IAM.
- **Revoke a single Mac:** delete that Mac's S3 API token. That device can no
  longer read or write the Kopia repository; others keep working.

### Kopia repository password (data plane, shared)

- The Kopia repository password is **shared across all Macs that connect to the
  same repository** — it is the encryption root, and only holders of the
  password can decrypt snapshots. See
  [operations.md](./operations.md#shared-repository-password-provisioning) for
  provisioning.
- **Rotating the repository password is a heavy operation** for the MVP: Kopia
  ties the password to the repository. Treat rotation as a repository migration
  (stand up a new repository, re-establish it on the first Mac, reconnect the
  others) rather than an in-place field change. There is no in-app password
  rotation flow in this MVP — this is a documented [deferred
  feature](./acceptance.md#deferred-features).

### Lost or decommissioned device

1. Delete the device's **Access service token** (cuts control-plane access).
2. Delete the device's **R2/S3 API token** (cuts data-plane access).
3. If the device may still hold the Kopia repository password and is a real
   loss (theft), plan a repository password migration as above, since the
   password decrypts all snapshots.

## Threat-model notes

- Compromising the coordination backend cannot leak profile contents — it never
  holds storage credentials or bytes.
- Compromising one device's S3 credential exposes only encrypted repository
  bytes; without the Kopia password they cannot be decrypted.
- Fencing tokens prevent a stale owner (e.g. a Mac that lost then regained
  connectivity) from publishing over a newer revision
  (`packages/sync-core/src/decisions.ts::isFencingTokenValid`).
