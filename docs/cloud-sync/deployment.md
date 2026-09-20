# Deployment Guide

This guide deploys the control plane (Cloudflare Worker + Durable Object),
fronts it with Cloudflare Access Service Auth, and provisions the data plane
(R2 private bucket + least-privilege per-device S3 credentials).

> **Live deployment requires operator-supplied Cloudflare credentials.** The
> steps below are procedures to run against your own account. Nothing here has
> been executed against a live account while authoring this doc. All tokens,
> account ids, and secrets shown are placeholders.

## Prerequisites

- A Cloudflare account with Workers, Durable Objects, R2, and Access (Zero
  Trust) enabled.
- `wrangler` (pinned to `4.124.0` in
  `services/sync-backend/package.json`). The backend is a **standalone project,
  not a root workspace member for install** — install inside the directory.
- Node ≥ 20 (`engines` in `services/sync-backend/package.json`).

## 1. Install & sanity-check the backend

```sh
cd services/sync-backend
yarn install        # or: npm install — standalone, does not touch the root lock
yarn typecheck
yarn test           # Vitest via @cloudflare/vitest-pool-workers (workerd)
```

The test suite runs entirely in the workerd pool with a **test-only auth
bypass** that engages only when `TEST_AUTH_BYPASS="1"` **and**
`CF_ACCESS_JWT_ISSUER` is the sentinel `https://test.cloudflareaccess.com`
(`services/sync-backend/src/auth.ts::bypassEnabled`). Both are injected solely
by `vitest.config.ts`; the deployed `wrangler.jsonc` sets neither, so production
always runs full Access JWT verification.

## 2. Configure the Durable Object migration & vars

`services/sync-backend/wrangler.jsonc` already declares:

- the `PROFILE_COORDINATOR` Durable Object binding → class `ProfileCoordinator`,
- a `v1` migration with `new_sqlite_classes: ["ProfileCoordinator"]` (SQLite-backed DO),
- placeholder `vars`:

```jsonc
"vars": {
  "CF_ACCESS_JWT_ISSUER": "",       // set before deploy
  "CF_ACCESS_JWT_AUDIENCE": "",     // set before deploy
  "DEFAULT_LEASE_TTL_MS": "45000",
  "RECOMMENDED_RENEWAL_MS": "15000"
}
```

`CF_ACCESS_JWT_ISSUER` and `CF_ACCESS_JWT_AUDIENCE` **must** be set to real
values before deploy — `authenticate()` throws `INTERNAL` if either is empty
(`services/sync-backend/src/auth.ts`). You get these values in step 4 after
creating the Access application, so you may deploy once to obtain the Worker URL,
create the Access app, then set the vars and redeploy.

## 3. Deploy the Worker + Durable Object

From the repository root, the convenience script delegates to the backend
workspace:

```sh
yarn deploy:backend
# → yarn workspace @multizen/sync-backend deploy
# → wrangler deploy   (see services/sync-backend/package.json)
```

`wrangler deploy` applies the `v1` migration (creating the SQLite-backed DO
class) and publishes the Worker. Deployment is intentionally operator-driven;
the package does not auto-deploy.

Verify liveness (unauthenticated) once the route is live:

```sh
curl -s https://sync.example.com/health
# {"status":"ok","service":"multizen-sync-backend"}
```

## 4. Cloudflare Access — self-hosted app with a Service Auth policy

The `/v1/**` routes are protected by Cloudflare Access. Configure a **self-hosted
application** in Zero Trust that covers the Worker's hostname/path, then attach a
**Service Auth** policy.

1. **Add a self-hosted application** covering the Worker route, e.g.
   `sync.example.com/v1` (protect the whole host if the Worker only serves
   `/v1` and `/health`; `/health` returns before auth in the Worker, so it is
   safe either way).
2. **Create a Service Auth policy** on that application:
   - Action: **Service Auth** (not Allow — Service Auth issues the JWT for
     non-interactive service tokens and does not require an IdP login).
   - Include rule: **Service Token** → select the tokens you mint in step 5
     (one per Mac).
3. **Record the application AUD tag** — this is `CF_ACCESS_JWT_AUDIENCE`.
4. **Record the team issuer** — `https://<your-team>.cloudflareaccess.com` —
   this is `CF_ACCESS_JWT_ISSUER`. The Worker fetches JWKS from
   `<issuer>/cdn-cgi/access/certs` (`services/sync-backend/src/auth.ts`).
5. Set both as Worker vars and redeploy:

```sh
cd services/sync-backend
# Non-secret; may live in wrangler.jsonc vars or be set explicitly:
wrangler deploy \
  --var CF_ACCESS_JWT_ISSUER:"https://your-team.cloudflareaccess.com" \
  --var CF_ACCESS_JWT_AUDIENCE:"<application-AUD-tag>"
```

> The Worker binds the service token's `common_name` (client id) and `sub` into
> the request identity and records it as the lease owner
> (`services/sync-backend/src/auth.ts`). This is how the backend attributes each
> write to a specific Mac.

## 5. One service token per Mac

Create a **separate Cloudflare Access service token for each Mac** and add each
to the Service Auth policy's include list. One token per device gives you:

- per-device attribution in lease ownership (`common_name`), and
- the ability to **revoke a single Mac** without disturbing the others.

For each token, Cloudflare shows a **Client ID** and **Client Secret** once:

- **Client ID** → non-secret; goes into the desktop app's sync config
  (`accessClientId`, sent as `CF-Access-Client-Id`).
- **Client Secret** → secret; stored **only** in the desktop Keychain vault
  under `accessClientSecret` (sent as `CF-Access-Client-Secret`). Never put it in
  `settings.json`. See [security.md](./security.md).

Sanitized end-to-end check of an authenticated route (placeholders only):

```sh
curl -s https://sync.example.com/v1/profiles/demo-profile \
  -H "CF-Access-Client-Id: 0123456789abcdef.access" \
  -H "CF-Access-Client-Secret: <service-token-secret>"
# 200 → {"state":{...}}  or  404 NOT_FOUND when no revision exists yet
```

## 6. R2 private bucket (data plane)

1. Create an R2 bucket, e.g. `multizen-sync`. Keep it **private** — no public
   access, no public bucket URL. The bucket holds only the encrypted Kopia
   repository.
2. Note the S3-compatible endpoint host for your account:
   `https://<accountid>.r2.cloudflarestorage.com`. Kopia's S3 backend uses this
   as `--endpoint` (`packages/kopia-adapter/src/commands.ts`).
3. R2 typically uses region `auto` — the desktop default is `auto`
   (`SYNC_DEFAULTS.s3Region` in `packages/settings-store/src/index.ts`).

## 7. Least-privilege per-device S3 API credentials

Mint a **separate R2 S3 API token per Mac**, scoped to the sync bucket only:

- Grant **Object Read & Write** on the single sync bucket (Kopia needs read +
  write + list within the repository prefix). Do **not** grant account-wide or
  admin scope.
- Each token yields an **Access Key ID** and **Secret Access Key**.
- On the desktop these are stored in the Keychain vault under `s3AccessKeyId`
  and `s3SecretAccessKey`, and injected into Kopia via the child environment as
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — never on argv
  (`packages/kopia-adapter/src/env.ts`).

Per-device S3 credentials mean a lost/compromised Mac can be cut off by deleting
just its token, without re-keying the fleet.

## 8. Desktop sync configuration (non-secret vs secret split)

Non-secret config is stored in `settings.json` under `sync`
(`packages/settings-store/src/index.ts::SyncConfig`) and is editable from the
app / IPC (`apps/desktop/src/main/sync/registerSyncIpc.ts`):

| Field | Example | Notes |
| --- | --- | --- |
| `workerUrl` | `https://sync.example.com` | Coordination backend base URL |
| `accessClientId` | `0123…​.access` | Service-token **client id** (public half) |
| `s3Endpoint` | `<accountid>.r2.cloudflarestorage.com` | R2 (or generic S3) endpoint host |
| `s3Region` | `auto` | R2 default; a real region for AWS S3 |
| `s3Bucket` | `multizen-sync` | Private bucket holding the Kopia repo |
| `s3Prefix` | `repo/` | Object key prefix inside the bucket |
| `deviceId` | `device_<hex>` | Minted once per install; never hardware-derived |
| `deviceDisplayName` | `Mac Studio` | Used in conflict-copy names + diagnostics |

Secrets are stored **only** in the Keychain vault and set via the
`sync:saveSecret` IPC (`SecretKind`): `kopiaPassword`, `s3AccessKeyId`,
`s3SecretAccessKey`, `accessClientSecret`. They are write-only from the UI —
never read back (`apps/desktop/src/main/sync/SyncController.ts`).

## 9. Post-deploy smoke checks

- `GET /health` → `{"status":"ok",...}` (no auth).
- `GET /v1/profiles/<id>` with a valid service token → `200` with `state`, or
  `404 NOT_FOUND` when no revision exists (the desktop treats this as revision 0,
  `SyncController.fetchRemoteRevision`).
- `GET /v1/profiles/<id>` with a bad/missing token → `401 UNAUTHORIZED`.
- Backend health from the desktop: the app's `sync:checkBackend` IPC probes
  `/health` and caches the result for diagnostics.

For the full two-Mac end-to-end procedure and its pass/fail criteria, see
[acceptance.md](./acceptance.md).
