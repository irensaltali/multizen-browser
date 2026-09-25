# Credential Backup — Format and Threat Model

The opt-in backup of MCP server credentials: what it is, what it protects
against, and — the part that matters most — what it does **not**.

Off by default. Nothing in this document happens unless an operator switches it
on and supplies a passphrase.

## Why it exists, and the trade it makes

Normally the API keys and tokens your MCP servers need never leave the machine.
They sit in OS secure storage and the synced project configuration carries only a
`${NAME}` reference. That is the safest arrangement and it is the default.

It has one cost: a new or rebuilt machine restores every project, folder binding
and preference, and then every server sits inactive waiting for secrets that
cannot be recovered from anywhere. The operator has to find and paste each key
again.

Credential backup trades that inconvenience for two real costs, stated plainly
because an operator should be able to decline on an informed basis:

1. **Your secrets gain another place they can be stolen from.** They are in your
   bucket, encrypted, instead of only on your machines.
2. **A forgotten passphrase is unrecoverable.** There is no reset, no escrow, and
   no recovery path. The passphrase is never transmitted and never stored outside
   the participating devices' OS keychains.

## Two layers, and why

A bundle is sealed twice. Unwrapping the outer layer yields another ciphertext.

| Layer | Key comes from | Provides |
| --- | --- | --- |
| Outer (`SyncedDocumentStore`) | Repository encryption password + per-repository salt, via scrypt (N=2^15, r=8, p=1) | AES-256-GCM at rest, Ed25519 signature checked against the trust registry, monotonic revisions with compare-and-swap |
| Inner (`credentialBundle.ts`) | A **separate** passphrase, via Argon2id (m=64 MiB, t=3, p=1) | AES-256-GCM over the canonical bundle payload |

The consequence is the property the feature exists for: **holding the bucket
credentials *and* the repository password is still not enough to read a single
secret.** An attacker additionally needs the passphrase.

Argon2id parameters are RFC 9106's second recommended configuration for memory,
with `p=1` rather than the RFC's 4 — the implementation
([`hash-wasm@4.12.0`](https://www.npmjs.com/package/hash-wasm), pure
WebAssembly) is single-threaded, so raising lanes would not speed *us* up while
still widening the parallelism available to an attacker with real hardware.
Measured at roughly 100 ms per derivation, which is paid on unseal, not per
request.

The implementation is cross-checked: its Argon2id output was verified
byte-identical to OpenSSL 3.6.3's independent `openssl kdf ... ARGON2ID` for a
fixed vector, and that vector is pinned as a test so a dependency swap that
computed something else would fail loudly.

## What may and may not be in a bundle

Admission is **default-deny** and enforced at three independent points: when a
bundle is sealed, when one is opened, and again at the vault write boundary. A
bug in any single layer cannot admit an excluded secret.

**Eligible** (allow-listed prefixes):

- `mcp-gateway:project-secret:<projectId>:<NAME>` — values the operator pasted
  in. Unrecoverable by any other means, which is the whole point.
- `mcp-gateway:project-token:<projectId>` — per-project bearer tokens. A restored
  device could mint its own, but the one-shot reveal exists so the operator can
  paste a token into external agent configs by hand; silently changing it on
  restore would break those without saying so.

**Never, regardless of anything else:**

- `mcp-gateway:device-signing-key-pem` — a restored identity would let two
  machines impersonate each other.
- `mcp-gateway:credential-bundle-passphrase` — sealing the passphrase inside what
  it protects would reduce two factors to one.
- `mcp-gateway:sync-salt-hex` — not secret, but device-scoped and already carried
  in envelope headers.
- The configured Kopia password and S3 credential reference names. These are
  operator-configurable strings in settings, so they are passed in as exclusions
  rather than hard-coded — which means even a ref renamed to *look* eligible is
  still refused.

Nothing else is eligible. A new kind of secret stays excluded until someone adds
it to the allow-list on purpose.

## What is in the clear

Only the format version. The entry count, the credential names, and the seal
timestamp all live **inside** the AEAD.

That is deliberate. A count or a timestamp in the clear would be convenient for
the UI, but anything outside the AEAD is attacker-writable, and unauthenticated
metadata that some later code path trusts is how this kind of design fails.

## Threat model

### Defended

| Threat | Defence |
| --- | --- |
| Bucket operator or anyone with read access reads your secrets | Two-layer encryption; the passphrase never leaves the participating devices |
| Someone with the repository password reads your secrets | The inner layer is keyed by a different secret entirely |
| Tampering with the ciphertext, tag, or AEAD header | AES-256-GCM authentication; the header is bound as additional data |
| Substituting a bundle from another logical slot | The AEAD context string binds it to "credential bundle"; the enclosing document binds to its own slot |
| Downgrading the KDF to something cheap | A bundle that is not Argon2id is refused outright |
| A hostile header demanding 4 GiB of memory | Cost parameters are capped before derivation is attempted |
| An untrusted device publishing a bundle | The enclosing document is signed and verified against the trust registry |
| A **trusted but compromised** device injecting an excluded secret | Admission is re-checked on open and at the vault boundary, not just on seal |
| A second device with a mistyped passphrase destroying the backup | A push that cannot open the existing bundle writes nothing and reports `remote-unreadable` |
| A device losing secrets it does not hold | Push merges: it keeps remote entries for projects this device does not have, instead of publishing its own vault verbatim |
| The passphrase leaking back to the renderer | No IPC channel returns one. The channel allow-list is asserted by test, so adding a reader would fail CI |
| The passphrase appearing in an error message | Refusals never echo the input; a test asserts the rejected value is absent from responses and from the DOM |

### Not defended — accepted limitations

These are real. They are listed because a threat model that only lists wins is
not a threat model.

1. **A bucket *writer* can replay a previously valid revision of the credentials
   document.** The credentials document is read without the replay guard applied
   to other documents, because a push is a read-modify-write (it must see the
   revision it last wrote) and a restore is idempotent by design. An attacker
   with write access cannot forge a bundle (it is signed) or read one (it is
   sealed), so the worst outcome is **reinstating a credential value that was
   genuinely in an earlier backup** — for example resurrecting a key you rotated.
   Mitigation: rotate the compromised credential at its source (the upstream
   provider), not only in MultiZen.

2. **Switching backup off overwrites the stored bundle; it does not guarantee
   byte-level erasure.** Disabling publishes an explicit empty marker over the
   bundle. If you have enabled **object versioning** on your bucket, the previous
   ciphertext may be retained as a non-current version. That is your bucket's
   retention policy and outside this application's control. If you need the old
   ciphertext gone, delete the non-current versions (or set a lifecycle rule) at
   the storage layer.

3. **A compromised trusted device can read every secret in the bundle** if it also
   has the passphrase. Trust is binary here: approval grants the ability to
   publish signed records, and a device the operator has approved and given the
   passphrase to is inside the boundary. Revoking a device stops its future
   publishes from being accepted, but does not retroactively protect secrets it
   already had. Rotate them.

4. **An attacker who obtains the passphrase and the repository password has
   everything.** There is no rate limiting on offline guessing — Argon2id's cost
   is the only thing standing between a weak passphrase and a successful attack.
   The 12-character minimum is a floor, not a recommendation.

5. **Metadata is not hidden.** Someone with bucket read access learns that a
   credential bundle exists, its size within base64 rounding, and how often it
   changes. The contents and the credential names are not exposed.

## Operational notes

- **Enabling is all or nothing.** If the first publish cannot happen — no Cloud
  Sync yet, an existing bundle this passphrase cannot open, a lost race — the
  passphrase is rolled back out of the vault. The device is never left reporting
  "off" while behaving as "on".
- **Being enabled is *defined* as having a passphrase stored.** There is no
  separate settings flag that could drift out of step with the key material.
- **The backup refreshes itself** whenever a credential changes: saving or
  deleting a managed secret, storing a pasted value, rotating a project token, or
  deleting a project (which purges that project's entries).
- **Deleting a project purges its secrets from the backup.** This is the one
  removal that needs an explicit signal, because a deleted project is
  indistinguishable from one this device never had.
- **Disabling needs no passphrase.** An operator who has forgotten it must still
  be able to stop backing credentials up.
- **Turning it off does not delete local credentials.** Your machines keep
  working; only the stored copy is cleared.

## Where this lives in the code

| Concern | File |
| --- | --- |
| Bundle format, admission control, seal/open | `packages/mcp-gateway/src/sync/credentialBundle.ts` |
| Argon2id + AES-256-GCM envelope, cost caps | `packages/mcp-gateway/src/sync/crypto.ts` |
| Publish/restore/merge, refuse-to-clobber | `apps/desktop/src/main/mcp-gateway/CredentialSync.ts` |
| Vault boundary, passphrase storage | `apps/desktop/src/main/mcp-gateway/GatewayVault.ts` |
| IPC surface (write-only passphrase) | `apps/desktop/src/main/mcp-gateway/registerGatewayHandlers.ts` |
| Settings UI, strength gate | `apps/desktop/src/renderer/src/components/settings/CredentialBackupSection.tsx` |

Tests: `packages/mcp-gateway/src/sync/credentialBundle.test.ts`,
`apps/desktop/src/main/mcp-gateway/__tests__/credentialSync.test.ts`,
`apps/desktop/src/main/mcp-gateway/__tests__/credentialBackupIpc.test.ts`,
`apps/desktop/src/renderer/src/components/settings/__tests__/CredentialBackupSection.test.tsx`.

## What was and was not verified

Every claim above about behaviour is derived from the code in this repository and
is covered by automated tests running against an in-memory conditional object
store (`InMemoryConditionalObjectStore`) and temporary directories.

**Not verified here:** no test in this repository talks to a real S3 or R2
bucket, and the Electron application was never launched as part of authoring this
document. Bucket versioning behaviour (limitation 2) is a property of your
storage provider and was reasoned about from its documentation, not observed.
Two-machine behaviour is covered by the checklist in
[acceptance.md](./acceptance.md), which is a procedure to run, not a result.
