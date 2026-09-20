# Acceptance & Failure Matrix

This is the exact acceptance checklist for the manual two-Mac Cloud Sync MVP,
the failure matrix operators should verify, and the explicit list of deferred
features.

> **Live acceptance requires operator credentials and hardware.** The two-Mac
> checklist below needs two physical/logical Macs, a deployed Worker, a
> Cloudflare Access self-hosted app with per-Mac service tokens, and a private
> R2 (or S3) bucket. It has **not** been executed while authoring this
> documentation. Run it in your own environment and record results.

## Prerequisites for acceptance

- Control plane deployed and healthy (`GET /health` → `{"status":"ok",…}`); see
  [deployment.md](./deployment.md).
- Cloudflare Access self-hosted app with a **Service Auth** policy and **one
  service token per Mac** in the include list.
- `CF_ACCESS_JWT_ISSUER` / `CF_ACCESS_JWT_AUDIENCE` set on the Worker.
- Private R2/S3 bucket + **per-device** least-privilege S3 API credentials.
- Kopia repository **initialized once** (first Mac) and **connectable** by the
  second Mac with the **shared repository password**.
- On each Mac: sync config filled in and all four secrets present in the vault
  (`sync:diagnostics.secretsPresent` all `true`).

## Two-Mac acceptance checklist

Label the machines **Mac A** and **Mac B**. Use one shared test profile with a
site that persists a login/cookie.

1. **Repository bring-up**
   - [ ] Mac A: initialize the Kopia repository (`kopia repository create s3 …`
         / `KopiaAdapter.createRepository`). Confirm objects appear under the
         bucket prefix.
   - [ ] Mac B: connect to the same repository with the same password
         (`connect`). Confirm success without re-creating.

2. **First publish from Mac A**
   - [ ] Mac A: enable sync for the profile (`sync:enable`).
   - [ ] Mac A: **Acquire** the lease (`sync:acquire`); `sync:status.hasLease` is
         true and `leaseExpiresAt` is ~45 s out.
   - [ ] Mac A: **Launch**, log in to the test site, then **Close** the browser
         fully.
   - [ ] Mac A: **Backup & Publish** (`sync:backup`); status shows
         `dirty=false`, `localRevision == baseRevision == remoteRevision` bumped,
         and a non-null `latestSnapshotId`.
   - [ ] Mac A: **Release** (`sync:release`); `hasLease` false.

3. **Move to Mac B**
   - [ ] Mac B: **Connect existing** the profile by id (`sync:connectExisting`),
         or enable + **Acquire** + **Restore** if the profile already exists
         locally.
   - [ ] Mac B: **Restore** pulls `latestSnapshotId`; the atomic swap completes;
         status shows the same revision as Mac A and `dirty=false`.
   - [ ] Mac B: **Launch** — the test site is **still logged in** (cookies/session
         survived the round-trip).

4. **Round-trip back to Mac A**
   - [ ] Mac B: modify state (e.g. change a setting on the site), **Close**,
         **Acquire** (if not held), **Backup & Publish**, **Release**. Revision
         increments again.
   - [ ] Mac A: **Acquire** + **Restore**; **Launch**; Mac B's change is present.

5. **Single-writer enforcement**
   - [ ] Mac A holds the lease. Mac B **Acquire** returns `LEASE_HELD` (409) /
         `LeaseHeldByOther`. Mac B cannot publish while Mac A owns the lease.

6. **Conflict — keep both**
   - [ ] Create a divergence: Mac A publishes revision N+1 while Mac B still has
         a **dirty** profile based on revision N.
   - [ ] Mac B **Launch**/**Backup** is refused with `ConflictDetected`.
   - [ ] Mac B **Restore with keep-local-as-conflict**
         (`sync:restore` with `keepLocalAsConflict = true`) creates an unsynced
         conflict copy named `"<name> - Conflict - <Mac B display name>"` and
         restores the canonical revision. **Both** states exist afterward.

7. **Diagnostics hygiene**
   - [ ] `sync:diagnostics` shows secret **presence booleans** only — no secret
         values. Progress/error messages contain no secrets (redaction).

Acceptance passes when every box is checked and no secret value ever appears in
diagnostics, status, or logs.

## Failure matrix

Verify each row behaves as documented. Backend codes are from
`services/sync-backend/src/errors.ts`; desktop codes from
`packages/sync-core/src/errors.ts`.

| Scenario | Expected behavior | Signal |
| --- | --- | --- |
| Acquire while another Mac owns a valid lease | Refused; other Mac unaffected | `LEASE_HELD` 409 → `LeaseHeldByOther` |
| Publish with stale fencing token (after takeover) | Rejected; no overwrite | `FENCING_TOKEN_INVALID` 409 → `LeaseFenced` |
| Publish with wrong `expectedRevision` (concurrent peer publish) | Rejected; no fast-forward | `REVISION_CONFLICT` 409 → `PublishRejected` |
| Publish/restore/release while browser still running | Refused before any Kopia call | `BrowserStillRunning` |
| Publish without an owned/unexpired lease | Refused | `LeaseHeldByOther` |
| Local dirty + remote advanced past base | Refused; resolve via keep-local conflict | `ConflictDetected` |
| Missing/expired/wrong Access service token | Rejected at the edge | `401 UNAUTHORIZED` → `BackendAuthFailed` |
| Backend unreachable (network down) | Distinguished from auth failure | `BackendUnreachable` |
| Restore when no remote snapshot exists | Refused | `RevisionNotFound` |
| Kopia repository password not set | Refused before spawning Kopia | `InvalidInput` ("password is not set") |
| Lease renewal fails mid-session | Lease dropped; owned synced browser closed | `onLeaseLost` (redacted error emitted) |
| OS sleep / power suspend | All leases dropped; owned browsers closed | `onPowerSuspend` |
| App/Chromium crash mid-workflow | Backend lease expires (~45 s); profile stays `dirty`; no silent loss | Next `beforeLaunch` re-decides |
| Restore swap fails partway | Atomic rollback; live data intact | `atomicSwap` rollback |
| Snapshot created but publish fails (orphan) | Safe; orphan not restored; `dirty` retained | Orphan snapshot (operator cleanup) |
| Idempotent retry of a mutating call | Same result replayed; no duplicate side effects | `operationId` idempotency |
| OS secure storage unavailable | Vault construction refuses; no plaintext secrets | `CredentialVault` throws |

## Deferred features

Explicitly **not** in this manual MVP (consistent with the plan's non-goals):

- **Automatic backup on clean browser exit** — MVP requires manual Backup &
  Publish.
- **Live device presence / WebSocket** — no online/offline indicators; state is
  fetched on demand via the REST endpoints.
- **One-click "Move profile here" handoff** — handoff is the manual
  Acquire→Restore sequence, not an automated transfer.
- **Automatic pull-before-open / push-after-close orchestration** — the launch
  gate advises, but the operator drives the steps.
- **Retention policies & automatic orphan/snapshot pruning** — Kopia
  auto-maintenance is disabled; cleanup is an operator task.
- **First-class version history / point-in-time restore in the app** — the app
  restores the latest published snapshot; older snapshots are reachable only via
  the Kopia CLI.
- **In-app Kopia repository password rotation** — treated as a repository
  migration, not a field change.
- **Encrypted credential sync / device-to-device credential transfer** —
  secrets stay device-local in the Keychain vault.
- **Live merging of browser databases, simultaneous writable sessions, CRDTs** —
  never; the design keeps both copies on divergence.
- **Windows/Linux acceptance** — the MVP targets macOS first (Keychain-backed
  vault); other platforms are out of scope for this acceptance.
- **MCP registry / local MCP router / folder & agent integrations** — separate
  milestones, not part of the sync MVP.

## What was and was not verified for this document

- **Verified against source:** endpoint set, request/response shapes, error
  codes and HTTP statuses, auth header/JWT flow, environment variables, Kopia
  argv and hardening flags, secret handling, conflict/lease/publish decision
  logic, and the workflow IPC surface — all quoted from files in this repo.
- **Not executed (requires operator credentials/hardware):** live Cloudflare
  Worker/DO deployment, live Cloudflare Access authentication, live R2/S3
  read/write, and the two-Mac end-to-end round-trip. Run the checklist above in
  your environment to certify these.
