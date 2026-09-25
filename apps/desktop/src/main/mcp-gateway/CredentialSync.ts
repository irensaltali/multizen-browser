/**
 * Publishes and restores the opt-in credential bundle.
 *
 * The bundle is the one synced document whose contents MultiZen itself cannot
 * read without something the operator supplies: a passphrase separate from the
 * repository encryption password. That passphrase lives in OS secure storage on
 * each participating device, and its presence is what "credential backup is on"
 * means — there is no second flag in settings that could drift out of step with
 * the key material.
 *
 * MERGE, NOT OVERWRITE. Push does not simply publish this device's vault. A
 * device may legitimately hold a subset of the account's secrets: it might not
 * have restored a project's values yet, or the project may not exist here at all.
 * Publishing the local vault verbatim would silently delete every secret this
 * device happens not to have — a backup feature destroying the backup. So a push
 * combines:
 *
 *   - every bundleable credential in the local vault (authoritative for the
 *     projects this device has), and
 *   - every remote entry belonging to a project this device does NOT have (left
 *     exactly as found, because this device has no standing to speak for it).
 *
 * Deletion therefore propagates for projects this device holds — removing a
 * managed secret here removes it from the backup — while secrets belonging to
 * other machines' projects survive. The single case that needs an explicit signal
 * is deleting a whole project, where the project stops being "held here" at the
 * same moment its secrets should disappear; that path passes the id in
 * `purgeProjects`.
 *
 * REFUSING TO CLOBBER. Because push merges, it must first open the remote bundle.
 * If a bundle exists and this device's passphrase cannot open it, push aborts with
 * `remote-unreadable` and writes nothing. Without that check, a second device
 * configured with a mistyped passphrase would replace a good backup with one only
 * it could read.
 */

import {
  CredentialBundleError,
  credentialProjectId,
  credentialsDocumentToJson,
  openCredentialBundle,
  parseCredentialsDocument,
  sealCredentialBundle,
  type BundleScope,
  type CredentialEntry,
  type CredentialsDocument,
  type RejectedDocument,
} from "@multizen/mcp-gateway";

import type { GatewayService } from "./GatewayService.ts";
import type { GatewayVault } from "./GatewayVault.ts";

/** Shared-scope document name carrying the sealed bundle. */
export const CREDENTIALS_DOCUMENT = "credentials";

export interface CredentialSyncDeps {
  readonly service: GatewayService;
  readonly vault: GatewayVault;
  /**
   * Credential names the surrounding configuration reserves for secrets that must
   * never be backed up — the Kopia password and S3 key refs, whose names are
   * operator-configurable and so cannot be hard-coded in the format layer.
   * Read fresh on every call so a settings change takes effect immediately.
   */
  readonly excludedNames: () => readonly string[];
}

export type CredentialPushReason =
  /** Cloud Sync is not composed; nothing to publish to. */
  | "not-syncing"
  /** No passphrase on this device: the feature is off. */
  | "disabled"
  /** The computed bundle matches what is already published. */
  | "unchanged"
  /** A bundle exists but this device's passphrase cannot open it. */
  | "remote-unreadable"
  /** The remote document could not be trusted (signature, rollback, ...). */
  | "rejected"
  /** Another device published first; the caller may retry. */
  | "conflict";

export interface CredentialPushOutcome {
  readonly pushed: boolean;
  /** Entries in the published bundle (0 when nothing was published). */
  readonly entryCount: number;
  readonly reason?: CredentialPushReason;
  readonly rejection?: RejectedDocument;
}

export type CredentialRestoreReason =
  | "not-syncing"
  | "no-passphrase"
  | "absent"
  /** The document exists but holds no bundle: backup was switched off. */
  | "purged"
  | "wrong-passphrase"
  | "malformed"
  | "rejected";

export interface CredentialRestoreOutcome {
  readonly restored: number;
  /** Projects whose credentials were written, so a caller can report specifics. */
  readonly projects: string[];
  readonly reason?: CredentialRestoreReason;
  readonly rejection?: RejectedDocument;
}

export interface CredentialStatus {
  /** A passphrase is stored on this device. */
  readonly enabled: boolean;
  /** Bundleable credentials currently in the local vault. */
  readonly localCount: number;
  /** A bundle is present remotely (null when not syncing / unknown). */
  readonly remotePresent: boolean | null;
}

/** Sorted, de-duplicated entry list — the canonical form a bundle is sealed from. */
function normalize(entries: readonly CredentialEntry[]): CredentialEntry[] {
  const byName = new Map<string, string>();
  for (const e of entries) byName.set(e.name, e.value);
  return [...byName.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function sameEntries(a: readonly CredentialEntry[], b: readonly CredentialEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => e.name === b[i]?.name && e.value === b[i]?.value);
}

export class CredentialSync {
  constructor(private readonly deps: CredentialSyncDeps) {}

  private scope(): BundleScope {
    return { excludedNames: [...this.deps.excludedNames()] };
  }

  /** True when this device has a bundle passphrase, i.e. the feature is on. */
  async enabled(): Promise<boolean> {
    return this.deps.vault.hasBundlePassphrase();
  }

  /** Non-secret summary for the settings UI. */
  async status(): Promise<CredentialStatus> {
    const enabled = await this.enabled();
    const localCount = (await this.deps.vault.bundleableNames(this.scope())).length;
    let remotePresent: boolean | null = null;
    const read = await this.readRemote();
    if (read.kind === "ok") remotePresent = read.document.bundle !== null;
    else if (read.kind === "absent") remotePresent = false;
    return { enabled, localCount, remotePresent };
  }

  /**
   * Turn credential backup on: store the passphrase, then publish.
   *
   * The passphrase is validated by the format layer before it is stored, so a
   * value too weak to seal with never reaches the vault.
   *
   * Enabling is ALL OR NOTHING. If the publish does not happen — no Cloud Sync
   * yet, an existing bundle this passphrase cannot open, an untrusted document, a
   * lost race — the passphrase is rolled back out of the vault. Otherwise the
   * caller would be told "this failed" while the device had quietly switched
   * itself on, which is the worst of both: the UI shows off, the backend behaves
   * as on, and neither the operator nor the next push agrees about the state.
   *
   * `unchanged` counts as success: it means an identical bundle is already
   * published, which is exactly the desired end state.
   */
  async enable(passphrase: string): Promise<CredentialPushOutcome> {
    await this.deps.vault.setBundlePassphrase(passphrase);
    let outcome: CredentialPushOutcome;
    try {
      outcome = await this.push();
    } catch (err) {
      await this.deps.vault.clearBundlePassphrase();
      throw err;
    }
    if (!outcome.pushed && outcome.reason !== "unchanged") {
      await this.deps.vault.clearBundlePassphrase();
    }
    return outcome;
  }

  /**
   * Turn credential backup off: replace the published bundle with an explicit
   * null and forget the passphrase.
   *
   * Ordered so the remote is cleared first. Forgetting the passphrase before the
   * purge would leave ciphertext in the bucket with no way to tell whether it had
   * been superseded. The purge needs no passphrase, so a lost one is not a trap.
   */
  async disable(): Promise<{ purged: boolean; reason?: CredentialPushReason }> {
    const published = await this.deps.service.publishDocument(
      "shared",
      CREDENTIALS_DOCUMENT,
      credentialsDocumentToJson({ version: 1, bundle: null }),
    );
    await this.deps.vault.clearBundlePassphrase();
    if (published === null) return { purged: false, reason: "not-syncing" };
    if (published.kind === "conflict") return { purged: false, reason: "conflict" };
    return { purged: true };
  }

  /**
   * Publish the merged bundle. Safe to call on any secret change: it is a no-op
   * when the feature is off, when Cloud Sync is not composed, or when the result
   * would be byte-identical to what is already published.
   */
  async push(options: { purgeProjects?: readonly string[] } = {}): Promise<CredentialPushOutcome> {
    const passphrase = await this.deps.vault.bundlePassphrase();
    if (passphrase === null) return { pushed: false, entryCount: 0, reason: "disabled" };
    if (this.deps.service.documentStore === null) {
      return { pushed: false, entryCount: 0, reason: "not-syncing" };
    }

    const remote = await this.readRemote();
    if (remote.kind === "rejected") {
      return {
        pushed: false,
        entryCount: 0,
        reason: "rejected",
        rejection: remote.rejection,
      };
    }
    if (remote.kind === "not-syncing") {
      return { pushed: false, entryCount: 0, reason: "not-syncing" };
    }

    let remoteEntries: CredentialEntry[] = [];
    if (remote.kind === "ok" && remote.document.bundle !== null) {
      try {
        remoteEntries = [
          ...(await openCredentialBundle(passphrase, remote.document.bundle, this.scope())).entries,
        ];
      } catch (err) {
        if (err instanceof CredentialBundleError) {
          // Do not overwrite a bundle we cannot read: it belongs to someone whose
          // passphrase differs from ours, and replacing it would lock them out.
          return { pushed: false, entryCount: 0, reason: "remote-unreadable" };
        }
        throw err;
      }
    }

    const local = await this.deps.vault.collectBundleEntries(this.scope());
    const heldHere = new Set<string>(this.deps.service.allConfigs().map((c) => c.id));
    const purge = new Set(options.purgeProjects ?? []);
    const foreign = remoteEntries.filter((e) => {
      const pid = credentialProjectId(e.name);
      if (pid === null) return false;
      if (purge.has(pid)) return false;
      return !heldHere.has(pid);
    });

    // Local last, so a value this device holds wins over the remote copy.
    const merged = normalize([...foreign, ...local]);
    if (sameEntries(merged, normalize(remoteEntries))) {
      return { pushed: false, entryCount: merged.length, reason: "unchanged" };
    }

    const bundle = await sealCredentialBundle(passphrase, merged, this.scope());
    const result = await this.deps.service.publishDocument(
      "shared",
      CREDENTIALS_DOCUMENT,
      credentialsDocumentToJson({ version: 1, bundle }),
    );
    if (result === null) return { pushed: false, entryCount: 0, reason: "not-syncing" };
    if (result.kind === "conflict") {
      return { pushed: false, entryCount: merged.length, reason: "conflict" };
    }
    return { pushed: true, entryCount: merged.length };
  }

  /**
   * Write the published credentials into the local vault, then reconcile.
   *
   * The reconcile is the point of the whole exercise: a server whose `${NAME}`
   * could not be resolved is held visible-inactive with a non-empty `missingEnv`,
   * and the runtime restarts exactly those whose references now resolve. So
   * restoring a secret starts the server that was waiting for it, without the
   * operator touching anything.
   *
   * `passphrase` defaults to the stored one, so a device that is already enabled
   * can re-pull without prompting; a fresh device passes the operator's input.
   */
  async restore(passphrase?: string): Promise<CredentialRestoreOutcome> {
    const pass = passphrase ?? (await this.deps.vault.bundlePassphrase());
    if (pass === null) return { restored: 0, projects: [], reason: "no-passphrase" };

    const remote = await this.readRemote();
    if (remote.kind === "not-syncing") {
      return { restored: 0, projects: [], reason: "not-syncing" };
    }
    if (remote.kind === "absent") return { restored: 0, projects: [], reason: "absent" };
    if (remote.kind === "rejected") {
      return {
        restored: 0,
        projects: [],
        reason: "rejected",
        rejection: remote.rejection,
      };
    }
    if (remote.document.bundle === null) {
      return { restored: 0, projects: [], reason: "purged" };
    }

    let entries: readonly CredentialEntry[];
    try {
      entries = (await openCredentialBundle(pass, remote.document.bundle, this.scope())).entries;
    } catch (err) {
      if (err instanceof CredentialBundleError) {
        return {
          restored: 0,
          projects: [],
          reason: err.code === "auth" ? "wrong-passphrase" : "malformed",
        };
      }
      throw err;
    }

    const projects = new Set<string>();
    let restored = 0;
    for (const entry of entries) {
      await this.deps.vault.writeBundleableCredential(entry.name, entry.value, this.scope());
      restored += 1;
      const pid = credentialProjectId(entry.name);
      if (pid !== null) projects.add(pid);
    }
    if (restored > 0) await this.deps.service.reconcile();
    return { restored, projects: [...projects].sort() };
  }

  /**
   * Adopt then publish, for startup and for a device coming back online.
   *
   * Pull first: a device that was off while secrets changed elsewhere should take
   * what it missed before offering its own view, or it would re-publish a stale
   * merge. Pull is skipped when the feature is off so switching it on stays an
   * explicit act.
   */
  async reconcile(): Promise<{
    restore: CredentialRestoreOutcome;
    push: CredentialPushOutcome;
  }> {
    if (!(await this.enabled())) {
      return {
        restore: { restored: 0, projects: [], reason: "no-passphrase" },
        push: { pushed: false, entryCount: 0, reason: "disabled" },
      };
    }
    const restore = await this.restore();
    const push = await this.push();
    return { restore, push };
  }

  /**
   * Read + parse the credentials document, normalising every failure mode.
   *
   * Always reads the current head rather than applying the document store's
   * replay guard. That guard suits documents that are applied once per revision;
   * this one is different in both directions. A push is a read-modify-write, so
   * it must see the revision it last wrote or the merge would refuse its own
   * previous publish as a rollback and the backup would freeze after the first
   * one. A restore is idempotent — writing the same credential values back is
   * exactly what "restore" means, and the operator asking for it again is not an
   * attack.
   *
   * What that gives up is narrow: someone with WRITE access to the bucket could
   * re-upload a previously valid revision of this document and have it accepted.
   * They still cannot forge one (it is signed against the trust registry) or read
   * one (it is sealed with the passphrase), so the worst outcome is reinstating a
   * credential value that was genuinely in an earlier backup. That trade is
   * recorded here rather than left implicit, and is part of the documented threat
   * model.
   */
  private async readRemote(): Promise<
    | { kind: "ok"; document: CredentialsDocument }
    | { kind: "absent" }
    | { kind: "not-syncing" }
    | { kind: "rejected"; rejection: RejectedDocument }
  > {
    const read = await this.deps.service.readDocument<unknown>("shared", CREDENTIALS_DOCUMENT, {
      expectFresh: false,
    });
    if (read === null) return { kind: "not-syncing" };
    if (read.kind === "absent") return { kind: "absent" };
    if (read.kind === "rejected") return { kind: "rejected", rejection: read.rejection };
    try {
      return { kind: "ok", document: parseCredentialsDocument(read.document.value) };
    } catch (err) {
      return {
        kind: "rejected",
        rejection: {
          scope: "shared",
          name: CREDENTIALS_DOCUMENT,
          reason: (err as Error).message,
          code: "malformed",
        },
      };
    }
  }
}
