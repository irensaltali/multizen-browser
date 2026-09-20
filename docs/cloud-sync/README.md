# MultiZen Cloud Sync — Operator & Deployment Documentation

Production-facing documentation for the **manual** MultiZen Cloud Sync MVP: a
two-plane system that lets a browser profile move safely between Macs with a
single active writer, encrypted backups, and no silent state merges.

> **Status: MVP, manual workflow.** Every sync step (Acquire, Restore, Launch,
> Close, Backup & Publish, Release) is an explicit, operator-triggered action.
> There is no automatic backup-on-close, no live WebSocket presence, and no
> one-click handoff in this MVP. Those are [deferred](./acceptance.md#deferred-features).

## Read in this order

| Doc | What it covers |
| --- | --- |
| [architecture.md](./architecture.md) | Control plane vs data plane, components, trust boundaries, revision/lease model. |
| [deployment.md](./deployment.md) | Deploying the Worker + Durable Object (`yarn deploy:backend`), Cloudflare Access self-hosted app + Service Auth policy, one service token per Mac, R2 private bucket, least-privilege per-device S3 API credentials. |
| [security.md](./security.md) | Credential inventory, Keychain-backed vault, secret exclusions, rotation & revocation, generic S3 fields, diagnostics redaction. |
| [operations.md](./operations.md) | The manual Acquire → Restore → Launch → Close → Backup & Publish → Release workflow, Kopia initialize vs connect, conflict-copy behavior, lease-loss / sleep / crash caveats, orphan snapshots, recovery/rollback, pinned Kopia licensing. |
| [acceptance.md](./acceptance.md) | Exact two-Mac acceptance checklist, failure matrix, and the explicit list of deferred features. |

## What is and is not verified in these docs

These documents are derived from the **code and configuration in this
repository** (`services/sync-backend/**`, `packages/sync-core/**`,
`packages/kopia-adapter/**`, `apps/desktop/src/main/sync/**`,
`packages/settings-store/**`). API shapes, error codes, headers, environment
variables, and Kopia argv are quoted from source.

Live Cloudflare R2, Cloudflare Access, and two-physical-Mac acceptance runs
**require operator-supplied credentials and hardware** and have **not** been
executed as part of authoring this documentation. Every command that touches a
real account or device is presented as a procedure to run, not as a result. All
`curl` / API examples use placeholder values and never contain real secrets.
