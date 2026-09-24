/**
 * Project-config synchronizer over a conditional object store.
 *
 * This is the control plane for MCP *project configuration* sync — the analogue
 * of `@multizen/s3-coordinator` for browser profiles, but for a DIFFERENT asset
 * living in a DIFFERENT reserved key namespace (`<prefix>/mcp/...`, see keys.ts).
 * It never touches browser-profile keys, and browser-profile deletion never
 * touches its keys.
 *
 * Guarantees:
 *   - Per-project monotonic revision with expected-revision CAS. Publishing
 *     revision N requires the head to currently be at N-1 (or absent for the
 *     first publish). A losing CAS is NEVER last-write-wins: the remote stays
 *     authoritative and the losing local signed config is returned to the caller
 *     as a durable conflict copy (with metadata) to persist locally.
 *   - Encryption-at-rest: every payload is AES-256-GCM sealed under a key
 *     derived from the operator password (crypto.ts). Cleartext config is never
 *     stored.
 *   - Signed envelopes: only valid canonical signed envelopes are published.
 *     On restore/list every record is verified (envelope shape, project id,
 *     revision monotonicity/rollback, config hash, Ed25519 signature against a
 *     signed trust registry, signer trusted/not-revoked) BEFORE it becomes an
 *     apply candidate. Anything failing goes to quarantine and never auto-starts.
 *   - Fresh-device semantics: a device with only the operator password + the
 *     signed trust registry can list and restore ALL projects (enabled AND
 *     disabled) to their exact desired state. Verification is honest — it trusts
 *     the trust registry's self-signature bootstrap, nothing more.
 *   - Robust discovery: paginated listing with a scan cap and strict key
 *     parsing; a single malformed/quarantined project never aborts the others.
 */

import { canonicalize, type JsonValue } from "../canonicalJson.js";
import { assertProjectId, isSafeId, type ProjectId } from "../ids.js";
import {
  parseProjectConfig,
  projectConfigToJson,
  type ProjectConfig,
} from "../projectConfig.js";
import {
  evaluateProject,
  hashConfig,
  signProject,
  verifyTrustRegistry,
  VerificationError,
  type ProjectEnvelope,
  type TrustRegistry,
} from "../trust.js";
import type { SigningKey } from "../vault.js";
import { open, seal, type CryptoEnvelope } from "./crypto.js";
import {
  isStoreErrorKind,
  type SyncObjectStore,
} from "./objectStore.js";
import {
  mcpProjectsPrefix,
  parseProjectStateKey,
  projectRevisionKey,
  projectStateKey,
} from "./keys.js";
import {
  decodeRecord,
  encodeRecord,
  PROJECT_RECORD_VERSION,
  RecordError,
  type ProjectRecord,
} from "./projectRecord.js";

/** Default page size and total scan cap for whole-library discovery. */
export const DEFAULT_LIST_PAGE_SIZE = 200;
export const DEFAULT_MAX_SCAN_KEYS = 100_000;

export interface SyncCoordinatorConfig {
  /** Object store (structural). */
  readonly store: SyncObjectStore;
  /** Base control prefix (repository root under the bucket). */
  readonly controlPrefix: string;
  /** Operator encryption password. Held only in memory; never persisted here. */
  readonly password: string;
  /** Per-repository salt (hex) for key derivation; stable across the repo. */
  readonly saltHex: string;
  /** This device's signing key (private material stays in the vault). */
  readonly signingKey: SigningKey;
  /** Per-page listing size (defaults to {@link DEFAULT_LIST_PAGE_SIZE}). */
  readonly listPageSize?: number;
  /** Hard cap on total keys scanned during discovery. */
  readonly maxScanKeys?: number;
}

/** A published (or would-be-published) project head. */
export interface PublishOutcome {
  readonly kind: "published";
  readonly projectId: string;
  readonly revision: number;
  readonly envelope: ProjectEnvelope;
}

/**
 * A concurrent-update loss: the remote advanced past our expected revision, so
 * we did NOT overwrite it. The losing local signed config is returned as a
 * durable conflict copy for the caller to persist locally (keep-both policy).
 */
export interface ConflictOutcome {
  readonly kind: "conflict";
  readonly projectId: string;
  /** Revision we attempted to publish. */
  readonly attemptedRevision: number;
  /** Revision currently authoritative on the remote. */
  readonly remoteRevision: number;
  /** The losing local envelope (authoritative-losing) for conflict persistence. */
  readonly losingEnvelope: ProjectEnvelope;
  /** The losing local config, to be saved as a conflict copy locally. */
  readonly losingConfig: ProjectConfig;
  /** Conflict metadata for the local durable copy. */
  readonly metadata: ConflictMetadata;
}

export type PublishResult = PublishOutcome | ConflictOutcome;

export interface ConflictMetadata {
  readonly projectId: string;
  readonly attemptedRevision: number;
  readonly remoteRevision: number;
  readonly localSigner: string;
  readonly remoteSigner: string;
  readonly detectedAt: string;
  readonly reason: "cas-lost" | "remote-newer";
}

/** A verified, ready-to-apply project. */
export interface AppliedProject {
  readonly projectId: string;
  readonly revision: number;
  readonly signer: string;
  readonly config: ProjectConfig;
}

/** A rejected/quarantined project; never auto-started. */
export interface QuarantinedProject {
  readonly projectId: string;
  readonly reason: string;
  readonly code:
    | "malformed"
    | "decrypt"
    | "bad-signature"
    | "hash-mismatch"
    | "unknown-signer"
    | "revoked-signer"
    | "rollback"
    | "id-mismatch";
}

export interface RestoreResult {
  readonly applied: AppliedProject[];
  readonly quarantined: QuarantinedProject[];
  readonly scanned: number;
}

export class SyncCoordinatorError extends Error {
  override readonly name = "SyncCoordinatorError";
  constructor(
    message: string,
    readonly code: "store" | "config" | "crypto" | "trust",
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();

export class ProjectSyncCoordinator {
  private readonly store: SyncObjectStore;
  private readonly controlPrefix: string;
  private readonly password: string;
  private readonly saltHex: string;
  private readonly signingKey: SigningKey;
  private readonly pageSize: number;
  private readonly maxScanKeys: number;

  constructor(config: SyncCoordinatorConfig) {
    this.store = config.store;
    this.controlPrefix = config.controlPrefix;
    this.password = config.password;
    this.saltHex = config.saltHex;
    this.signingKey = config.signingKey;
    this.pageSize = config.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
    this.maxScanKeys = config.maxScanKeys ?? DEFAULT_MAX_SCAN_KEYS;
  }

  // ── payload sealing ───────────────────────────────────────────────────────

  private sealConfig(config: ProjectConfig): CryptoEnvelope {
    const canonical = canonicalize(projectConfigToJson(config) as JsonValue);
    return seal(this.password, encoder.encode(canonical), {
      saltHex: this.saltHex,
      // Bind the ciphertext to the project id: a password holder cannot move a
      // ciphertext to another project's slot without failing the AAD check.
      context: config.id,
    });
  }

  private openConfig(payload: CryptoEnvelope, projectId: string): ProjectConfig {
    const plaintext = open(this.password, payload, projectId);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    return parseProjectConfig(JSON.parse(text) as unknown);
  }

  // ── head read ─────────────────────────────────────────────────────────────

  /**
   * Read the current head record + etag for a project, or null when absent.
   * Malformed/oversized head objects reject as a store error caller can handle.
   */
  private async readHead(
    projectId: ProjectId,
  ): Promise<{ record: ProjectRecord; etag: string } | null> {
    const key = projectStateKey(this.controlPrefix, projectId);
    try {
      const got = await this.store.get(key);
      return { record: decodeRecord(got.bytes), etag: got.etag };
    } catch (err) {
      if (isStoreErrorKind(err, "NotFound")) return null;
      throw err;
    }
  }

  // ── publish ─────────────────────────────────────────────────────────────

  /**
   * Publish `config` at `revision`. `revision` must be strictly greater than the
   * current remote revision (monotonic). The first publish uses revision 1 and a
   * conditional create; subsequent publishes CAS against the current head etag,
   * asserting the head is exactly at `revision - 1`.
   *
   * On a lost race (someone else advanced the head first) we DO NOT overwrite:
   * we return a {@link ConflictOutcome} carrying the losing signed config so the
   * caller persists a durable local conflict copy (keep-both). Bound and unbound
   * projects (with/without `browserProfileId`) publish identically.
   */
  async publish(config: ProjectConfig, revision: number): Promise<PublishResult> {
    const projectId = assertProjectId(config.id);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new SyncCoordinatorError(`revision must be a positive integer`, "config");
    }

    // Sign the (canonical) config at this revision. Only canonical signed
    // envelopes are ever written.
    const envelope = await signProject(this.signingKey, projectId, revision, config);
    const record: ProjectRecord = {
      recordVersion: PROJECT_RECORD_VERSION,
      envelope,
      payload: this.sealConfig(config),
    };
    const body = encodeRecord(record);
    const headKey = projectStateKey(this.controlPrefix, projectId);

    const current = await this.readHead(projectId);

    if (current === null) {
      if (revision !== 1) {
        // Expected-revision CAS: first publish must be revision 1.
        throw new SyncCoordinatorError(
          `first publish must be revision 1, got ${revision}`,
          "config",
        );
      }
      try {
        await this.store.putCreate(headKey, body);
      } catch (err) {
        if (isStoreErrorKind(err, "PreconditionFailed", "Conflict")) {
          // Lost the create race: someone created the head first.
          return this.buildConflict(projectId, config, envelope, revision);
        }
        throw err;
      }
      await this.writeHistory(projectId, revision, body);
      return { kind: "published", projectId, revision, envelope };
    }

    const remoteRevision = current.record.envelope.revision;
    if (revision <= remoteRevision) {
      // Remote already at/ahead of our revision: do not overwrite. Keep both.
      return this.buildConflict(projectId, config, envelope, revision, current.record);
    }
    if (revision !== remoteRevision + 1) {
      throw new SyncCoordinatorError(
        `non-contiguous revision: head at ${remoteRevision}, cannot publish ${revision}`,
        "config",
      );
    }

    try {
      await this.store.putCompareAndSwap(headKey, body, current.etag);
    } catch (err) {
      if (isStoreErrorKind(err, "PreconditionFailed", "Conflict", "NotFound")) {
        // Lost the CAS race: re-read to attach the winning remote metadata.
        const fresh = await this.readHead(projectId);
        return this.buildConflict(
          projectId,
          config,
          envelope,
          revision,
          fresh?.record,
        );
      }
      throw err;
    }
    await this.writeHistory(projectId, revision, body);
    return { kind: "published", projectId, revision, envelope };
  }

  private buildConflict(
    projectId: ProjectId,
    losingConfig: ProjectConfig,
    losingEnvelope: ProjectEnvelope,
    attemptedRevision: number,
    remoteRecord?: ProjectRecord,
  ): ConflictOutcome {
    const remoteRevision = remoteRecord?.envelope.revision ?? attemptedRevision;
    const remoteSigner = remoteRecord?.envelope.signer ?? "unknown";
    return {
      kind: "conflict",
      projectId,
      attemptedRevision,
      remoteRevision,
      losingEnvelope,
      losingConfig,
      metadata: {
        projectId,
        attemptedRevision,
        remoteRevision,
        localSigner: this.signingKey.deviceId,
        remoteSigner,
        detectedAt: new Date().toISOString(),
        reason: remoteRevision >= attemptedRevision ? "remote-newer" : "cas-lost",
      },
    };
  }

  /** Best-effort write of the immutable revision-history record. */
  private async writeHistory(
    projectId: ProjectId,
    revision: number,
    body: Uint8Array,
  ): Promise<void> {
    const key = projectRevisionKey(this.controlPrefix, projectId, revision);
    try {
      await this.store.putImmutable(key, body);
    } catch (err) {
      // A pre-existing immutable record for this exact revision is fine
      // (idempotent republish). Other failures are non-fatal for the head.
      if (isStoreErrorKind(err, "PreconditionFailed", "Conflict")) return;
      // Swallow: history is advisory; head is the source of truth.
    }
  }

  // ── verification ─────────────────────────────────────────────────────────

  /**
   * Verify a single stored record against a pre-verified trust registry into an
   * apply candidate, or a quarantine decision. Never throws for verification
   * failures — returns a discriminated result so one bad project cannot abort a
   * batch.
   */
  private verifyRecord(
    projectId: string,
    record: ProjectRecord,
    registry: TrustRegistry,
    lastAppliedRevision?: number,
  ): AppliedProject | QuarantinedProject {
    // Decrypt first: a record we cannot authenticate is quarantined without
    // ever trusting its bytes.
    let config: ProjectConfig;
    try {
      config = this.openConfig(record.payload, projectId);
    } catch (err) {
      return {
        projectId,
        reason: `decrypt/parse failed: ${(err as Error).message}`,
        code: "decrypt",
      };
    }
    if (config.id !== projectId) {
      return { projectId, reason: "config id does not match key", code: "id-mismatch" };
    }
    const decision = evaluateProject(record.envelope, config, registry, {
      ...(lastAppliedRevision !== undefined ? { lastAppliedRevision } : {}),
    });
    if (decision.accepted && decision.verified) {
      return {
        projectId,
        revision: decision.verified.revision,
        signer: decision.verified.signer,
        config: decision.verified.config,
      };
    }
    const code = (decision.error?.code ?? "malformed") as QuarantinedProject["code"];
    return {
      projectId,
      reason: decision.error?.message ?? "verification failed",
      code,
    };
  }

  // ── restore one ────────────────────────────────────────────────────────

  /**
   * Restore a single project by id. Returns an apply candidate or a quarantine
   * record; null when the project head is absent. `lastAppliedRevision` enables
   * rollback protection against replay of a stale (previously-applied) record.
   */
  async restoreProject(
    id: ProjectId,
    registry: TrustRegistry,
    lastAppliedRevision?: number,
  ): Promise<AppliedProject | QuarantinedProject | null> {
    verifyTrustRegistry(registry);
    const head = await this.readHeadResilient(id);
    if (head === null) return null;
    if (head.kind === "malformed") {
      return { projectId: id, reason: head.reason, code: "malformed" };
    }
    return this.verifyRecord(id, head.record, registry, lastAppliedRevision);
  }

  /**
   * Read a head, converting decode failures into a structured malformed marker
   * rather than throwing, so a corrupt head quarantines instead of aborting.
   */
  private async readHeadResilient(
    projectId: ProjectId,
  ): Promise<
    | { kind: "ok"; record: ProjectRecord }
    | { kind: "malformed"; reason: string }
    | null
  > {
    const key = projectStateKey(this.controlPrefix, projectId);
    let bytes: Uint8Array;
    try {
      const got = await this.store.get(key);
      bytes = got.bytes;
    } catch (err) {
      if (isStoreErrorKind(err, "NotFound")) return null;
      throw err;
    }
    try {
      return { kind: "ok", record: decodeRecord(bytes) };
    } catch (err) {
      if (err instanceof RecordError) {
        return { kind: "malformed", reason: err.message };
      }
      throw err;
    }
  }

  // ── restore all (fresh-device / whole-library) ─────────────────────────

  /**
   * Discover and restore ALL projects (enabled and disabled) to their exact
   * desired state. This is the fresh-device path: given only the password and a
   * signed trust registry, it lists every project head, verifies each, and
   * returns apply candidates plus quarantined records. Disabled projects are
   * returned as-is (their `enabled=false` desired state is preserved) — a
   * disabled project remains disabled after restore.
   *
   * Discovery is paginated with a hard scan cap and strict key parsing. A
   * malformed key, a decode failure, or a verification failure for one project
   * NEVER aborts the whole pass — that project is quarantined and the scan
   * continues.
   *
   * `knownRevisions` (optional) maps projectId → last-applied revision for
   * rollback protection; absent entries are treated as never-applied (0).
   */
  async restoreAll(
    registry: TrustRegistry,
    knownRevisions?: ReadonlyMap<string, number>,
  ): Promise<RestoreResult> {
    verifyTrustRegistry(registry);
    const prefix = mcpProjectsPrefix(this.controlPrefix);
    const applied: AppliedProject[] = [];
    const quarantined: QuarantinedProject[] = [];
    let scanned = 0;
    let continuationToken: string | undefined;

    do {
      const page = await this.store.list(prefix, {
        maxKeys: this.pageSize,
        ...(continuationToken !== undefined ? { continuationToken } : {}),
      });
      for (const key of page.keys) {
        if (scanned >= this.maxScanKeys) {
          continuationToken = undefined;
          break;
        }
        // STRICT key parse: only exact project head keys are considered. Every
        // other key (revision history, trust registry, foreign keys) is ignored.
        const id = parseProjectStateKey(this.controlPrefix, key);
        if (id === null) continue;
        scanned += 1;
        if (!isSafeId(id)) continue;
        const projectId = id as ProjectId;
        const last = knownRevisions?.get(projectId);
        try {
          const head = await this.readHeadResilient(projectId);
          if (head === null) continue;
          if (head.kind === "malformed") {
            quarantined.push({ projectId, reason: head.reason, code: "malformed" });
            continue;
          }
          const result = this.verifyRecord(projectId, head.record, registry, last);
          if ("config" in result) applied.push(result);
          else quarantined.push(result);
        } catch (err) {
          // Transport/other error for one project: quarantine it, keep scanning.
          quarantined.push({
            projectId,
            reason: `read failed: ${(err as Error).message}`,
            code: "malformed",
          });
        }
      }
      continuationToken = page.nextContinuationToken ?? undefined;
    } while (continuationToken !== undefined && scanned < this.maxScanKeys);

    return { applied, quarantined, scanned };
  }
}

export {
  VerificationError,
  type ProjectEnvelope,
  type TrustRegistry,
};
