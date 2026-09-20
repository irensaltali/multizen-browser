# @multizen/sync-backend

Cloudflare coordination backend for MultiZen Cloud Sync (Milestone 4 of the
product plan). A Worker plus one **SQLite-backed** `ProfileCoordinator` Durable
Object per browser profile. It is authoritative for **ownership leases** and
**revision metadata** only — there is intentionally **no R2 binding**; encrypted
profile bytes live in the client's Kopia repository.

This is a standalone project (not a root yarn workspace member). Install and run
it from within `services/sync-backend`.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness probe |
| GET | `/v1/profiles/:id` | Access | Current coordination state |
| POST | `/v1/profiles/:id/acquire` | Access | Acquire the single-writer lease |
| POST | `/v1/profiles/:id/renew` | Access | Extend the lease |
| POST | `/v1/profiles/:id/publish` | Access | Publish a new immutable revision (CAS) |
| POST | `/v1/profiles/:id/release` | Access | Release the lease |

### Request bodies

- `acquire`: `{ deviceId, operationId, leaseTtlMs? }`
- `renew`: `{ deviceId, leaseId, operationId, leaseTtlMs? }`
- `publish`: `{ deviceId, leaseId, operationId, expectedRevision, latestSnapshotId }`
- `release`: `{ deviceId, leaseId, operationId }`

### Responses

`acquire`/`renew` return:

```json
{
  "state": { "profileId": "...", "currentRevision": 0, "ownerDeviceId": "device_a", "fencingToken": 1, "...": "..." },
  "lease": { "leaseId": "<opaque>", "fencingToken": 1, "leaseExpiresAt": 0, "leaseTtlMs": 45000, "recommendedRenewalMs": 15000 }
}
```

## Coordination invariants

- **Deterministic DO routing** — `idFromName(profileId)` maps each profile to a
  single Durable Object, serializing all coordination for that profile.
- **45s default lease, 15s recommended renewal** — returned in every lease
  response; `leaseTtlMs` is overridable per request and via `DEFAULT_LEASE_TTL_MS`.
- **Opaque lease ids, stored hashed** — the client receives a random 256-bit
  token; only its SHA-256 hash is persisted. Renew/publish/release verify the
  hash in constant time.
- **Monotonic fencing tokens** — incremented on every ownership change
  (acquire / re-acquire), stable across renewals.
- **Expected-revision CAS** — `publish` only succeeds when `expectedRevision`
  equals the authoritative `currentRevision`, else `REVISION_CONFLICT`.
- **Immutable revision rows** — each publish appends a row keyed on `revision`.
- **Operation-id idempotency** — every mutating call caches its result by
  `operationId`; retries replay the stored response with no side effects.
- **Deterministic errors/status** — see `src/errors.ts` (`LEASE_HELD` 409,
  `REVISION_CONFLICT` 409, `VALIDATION_FAILED` 422, `UNAUTHORIZED` 401, ...).

## Authentication

`/v1/**` requires a Cloudflare Access JWT. The Worker verifies it against the
team's remote JWKS (`<issuer>/cdn-cgi/access/certs`) with `jose`, pinning
`CF_ACCESS_JWT_ISSUER` and `CF_ACCESS_JWT_AUDIENCE`. For service tokens the
`common_name` (client id) and `sub` are bound into the request identity and
recorded as the lease owner.

`TEST_AUTH_BYPASS="1"` short-circuits verification with a synthetic identity and
is set **only** in `vitest.config.ts` — the deployed `wrangler.jsonc` never sets
it.

## Configuration

Set real values before deploy (as Worker vars or secrets):

```
CF_ACCESS_JWT_ISSUER   = https://<team>.cloudflareaccess.com
CF_ACCESS_JWT_AUDIENCE = <Access application AUD tag>
DEFAULT_LEASE_TTL_MS   = 45000
RECOMMENDED_RENEWAL_MS = 15000
```

## Develop

```sh
cd services/sync-backend
yarn install      # or npm install — standalone, does not touch the root lock
yarn typecheck
yarn test         # Vitest via @cloudflare/vitest-pool-workers (workerd)
yarn dev          # wrangler dev
```

Deploy is intentionally left to an operator (`yarn deploy`); this package does
not auto-deploy.
