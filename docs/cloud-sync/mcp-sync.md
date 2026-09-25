# MCP Configuration Sync

How MCP gateway configuration travels between machines: projects, the device
trust registry, shared settings, per-device folder bindings, configuration
history, and the one-pass device setup that assembles them.

This is a **different asset** from browser-profile sync, living in a different
key namespace, with a different coordination model. Profile sync is
single-writer with ownership leases, because two machines writing one Chromium
profile would corrupt it. Configuration is small, structured, and mergeable per
project, so it uses per-project revisions with compare-and-swap instead — no
leases, and any device can edit any project.

## Key layout

Everything lives under a reserved `mcp/` segment inside the control prefix:

```
<controlPrefix>/mcp/projects/<projectId>/state.json      ← project head (CAS)
<controlPrefix>/mcp/projects/<projectId>/rev/<n>.json    ← immutable revision archive
<controlPrefix>/mcp/projects/<projectId>/tombstone.json  ← signed deletion marker
<controlPrefix>/mcp/trust/registry.json                  ← signed trust registry
<controlPrefix>/mcp/trust/pending/<deviceId>.json        ← self-announcement, awaiting approval
<controlPrefix>/mcp/shared/<name>.json                   ← repository-wide documents
<controlPrefix>/mcp/devices/<deviceId>/<name>.json       ← one device's documents
```

The `mcp/` segment is load-bearing, not cosmetic. The browser coordinator's
`parseStateKey` matches only `<prefix>/profiles/<id>/state.json` and returns null
for anything else, so **no profile operation can list, tombstone, or delete an
MCP key**, and the parsers here reject any key that is not exactly a well-formed
MCP control key. Project ids reuse the gateway slug grammar (1–64 chars of
`[a-z0-9_-]`), so they are safe to embed in a key segment with no traversal
potential.

## Every record is signed and encrypted

| Property | How |
| --- | --- |
| Confidential at rest | AES-256-GCM, key derived from the operator's encryption password + a per-repository salt (scrypt N=2^15). The salt travels in the authenticated header, so a fresh device re-derives the same key from the same password. |
| Authentic | Ed25519 signature over canonical JSON, verified against a self-verified trust registry. |
| Ordered | Per-project monotonic revisions. Publishing revision N requires the head to be at N−1. |
| Never last-write-wins | A lost compare-and-swap returns a conflict carrying the losing signed config, kept as a durable local copy. |
| Replay-resistant | A record at or below the last applied revision is refused as a rollback. |

Anything that fails verification is **quarantined**: recorded with a reason,
never applied, never started. One bad record cannot abort a whole-library
restore.

## Device trust

A fresh bucket has no registry. The first device bootstraps itself as the sole
trust root; every later device **adopts** the existing registry after verifying
its self-signature.

The distinction that matters, and the one most likely to be misread:

- **Restoring does not require approval.** A new device adopts the registry and
  can therefore verify records signed by devices already in it. Reads work
  immediately.
- **Publishing does require approval.** The new device's own signature is unknown
  until an administrator approves it, so until then its edits stay local.

Because the registry only lists devices that are already entries, an unapproved
device would otherwise be invisible and could never be promoted. So it writes a
**self-signed announcement** under `mcp/trust/pending/`. That record carries a
public key and a display name only: no secret, and it grants no authority by
existing. Approving one is what grants authority, and that still requires an
already-trusted device.

Revoking a device stops its **future** records from being accepted. It does not
retroactively invalidate what it already published, and it cannot claw back
anything the device already read.

## Shared settings vs device-local settings

App settings are split by an explicit allow-list, not by convention.

**Shared** (`SHARED_SETTINGS_KEYS`): `theme`, `mcpHttpEnabled`, `autoUpdate`,
`engineAutoUpdate`.

**Device-local**, with reasons:

| Field | Why it must not travel |
| --- | --- |
| `browserEngine` | A platform-specific binary choice; the same value can be invalid on another machine |
| `mcpHttpPort` | A local listener that can collide with something else on the receiving device |
| the whole `sync` block | Device identity the trust and lease systems depend on, plus the bucket coordinates and credential reference names — which cannot travel inside the bucket they describe |

A remote document that **omits** a field leaves the local value untouched, so an
older peer publishing a smaller document cannot blank a setting it never knew
about. Unknown keys and wrong types are dropped field by field rather than
rejecting the whole document.

Settings conflicts are **last-writer**, unlike project configs. A preference is a
scalar with no meaningful merge, so asking the operator to arbitrate would be
noise.

## Folder bindings are per device

Which local folders a project is installed into, which agents are written there,
and which environment variable names are approved for expansion — all of it is
backed up to the **device** scope.

- **Restoring onto the same machine** is a true restore: the bindings are
  re-linked through the normal path, so agent config files are rewritten from
  *current* project configuration rather than from stale recorded state.
  Environment approvals are restored first, so references can resolve.
- **Restoring from a different machine is impossible**, and the code says so
  instead of trying. Another device's `/Users/alice/work` means nothing here;
  writing agent configuration into whatever occupies that path would be wrong. So
  another device's bindings are surfaced as **proposals**, each flagged with
  whether the directory exists, and applying nothing.

Deliberately **not** backed up: per-agent install status, `desiredHash`,
`fileHash`, `lastInstalledAt`, and `ownedKeys`. Those describe files on disk and
the disk is the authority. A restored `ownedKeys` could claim ownership of entries
MultiZen never wrote, which is precisely how you clobber someone else's config.

## Project deletion propagates

Deleting a project writes a **signed tombstone** in the project's own subtree,
beside the head. Living there means whole-library discovery already lists it, so a
deletion is found by the same pass that finds configs — no second scan, and no
chance of a device seeing the config but missing the deletion.

The tombstone shares the project's revision sequence, so a deletion and a
concurrent edit are ordered against each other rather than racing on wall-clock
time. The head object is deliberately left in place: readers compare revisions and
the newer record wins, which means a slow reader can never see an empty subtree
and conclude the project simply never existed.

Recreating a deleted project works: revision contiguity is computed against
`max(head, tombstone)`, so the new config lands above the deletion rather than
being permanently blocked by it.

## Configuration history

Every published revision is archived immutably at
`mcp/projects/<id>/rev/<n>.json`. The archive wraps the signed record together
with a **signed timestamp**:

```json
{ "archiveVersion": 1, "stamp": { ... }, "record": { ... } }
```

The timestamp is signed rather than written as plain metadata because it is what
"restore the configuration as of Tuesday" selects on — an unauthenticated
timestamp would let anyone with bucket write access relabel an old revision as
recent and choose which config an operator restores. The stamp includes a hash of
the archived record, so a valid stamp cannot be moved onto a different revision's
content.

Reading history applies three rules:

1. A revision whose stamp cannot be verified is still **listed**, with no date. A
   config signed by a trusted device is a real config; dropping it because its
   clock reading is untrustworthy would lose real history. The UI shows "date
   unknown" rather than a plausible-looking guess.
2. A revision whose **signer** is not a trusted registry entry is not listed at
   all — history is the menu of restorable revisions, and that one can never be
   restored. (Listing applies a membership check only; the full signature
   verification runs before anything is actually restored, because verifying every
   entry would mean a key derivation per revision.)
3. A deletion is part of the timeline. If the newest event at or before the chosen
   moment is a tombstone, the project did not exist then and the honest answer is
   "nothing to restore" rather than the config from before it was deleted.

**Restoring republishes forward.** Making revision 3 current publishes its content
as revision N+1; it does not rewind the head. Rewinding would look to every other
device exactly like the rollback attack their replay protection exists to refuse.
It also means the intervening revisions stay in the archive, so a restore can
itself be undone.

**Retention** keeps the newest 20 revisions per project (`DEFAULT_HISTORY_LIMIT`),
pruned after each successful publish. Pruning touches only the archive — never a
head, a tombstone, or a trust record. A store that cannot delete keeps full
history and reports `supported: false`, because silently doing nothing would be
indistinguishable from a retention policy that worked.

## Setting up a device from a backup

Settings → Cloud Sync → *Set up this device from a backup* runs one ordered pass.
The order is not arbitrary:

| Stage | Why here | Fatal? |
| --- | --- | --- |
| `storage` | Nothing else can run without bucket coordinates, credentials, and a store that genuinely supports conditional writes | **Yes** |
| `trust` | Every later stage verifies signatures against the registry | **Yes** |
| `settings` | Cheap, and shared preferences can influence what follows | No |
| `projects` | Bindings and credentials are both keyed by project id | No |
| `bindings` | Rewrites agent config files from the projects restored above | No |
| `credentials` | Writing a secret starts the servers held back for a missing `${NAME}` | No |
| `profiles` | Heaviest by far, and nothing depends on it — a slow or partial run has already left a usable install | No |

`storage` and `trust` are fatal because without them every later stage would fail
for the same reason, and reporting one root cause seven times is worse than
reporting it once; stages after a fatal failure stay `pending`, which is a
truthful description of a stage that never ran. Everything else records its
failure and is stepped over, because a device that recovered its projects but not
its browser profiles is far more useful than one that recovered nothing.

The flow is **idempotent** — re-running is the expected way to finish an
interrupted setup or to retry after approval. It reports `awaitingApproval` when
this device can restore but not yet publish, rather than blocking on a human.

Omitting the credential passphrase **skips** that stage rather than failing it,
and the report says so: the operator has not got their server secrets back, and
the UI must not imply otherwise.

## Where this lives in the code

| Concern | File |
| --- | --- |
| Key layout and strict parsers | `packages/mcp-gateway/src/sync/keys.ts` |
| Signing, verification, trust registry, tombstones, archive stamps | `packages/mcp-gateway/src/trust.ts` |
| Project publish/restore/conflict/tombstone/history | `packages/mcp-gateway/src/sync/syncCoordinator.ts` |
| Generic encrypted+signed documents | `packages/mcp-gateway/src/sync/documentStore.ts` |
| Trust registry sync + announcements | `packages/mcp-gateway/src/sync/trustSync.ts` |
| Desktop composition of the above | `apps/desktop/src/main/mcp-gateway/GatewaySyncBridge.ts`, `GatewayService.ts` |
| Shared settings split | `packages/settings-store/src/shared.ts`, `apps/desktop/src/main/mcp-gateway/SettingsSync.ts` |
| Per-device bindings backup | `apps/desktop/src/main/mcp-gateway/BindingsSync.ts` |
| One-pass device setup | `apps/desktop/src/main/mcp-gateway/DeviceSetup.ts` |

Credentials are covered separately in
[credential-backup.md](./credential-backup.md).

## What was and was not verified

Behaviour described here is derived from the code in this repository and covered
by automated tests against `InMemoryConditionalObjectStore` and temporary
directories, including genuine two-device tests (two coordinators, two signing
identities, one shared store).

**Not verified here:** no test talks to a real S3 or R2 bucket, and the Electron
application was never launched as part of authoring this document. Two-physical-
machine behaviour is a procedure to run — see
[acceptance.md](./acceptance.md#mcp-configuration-sync-two-machine-checklist).
