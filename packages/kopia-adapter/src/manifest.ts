/**
 * Sanitized sync-manifest storage.
 *
 * A manifest records, per profile, which Kopia snapshot corresponds to a
 * profile and where its data lives. Because the manifest drives later restore
 * operations (which write to disk), we validate strictly on both write and
 * read:
 *  - IDs must match a conservative allow-list (no path separators, no dots that
 *    could enable traversal, bounded length).
 *  - Stored paths must be absolute and free of `..` traversal segments.
 *  - Unknown / malformed manifests are rejected rather than coerced.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

export const MANIFEST_VERSION = 1 as const;

/** One profile's entry in the manifest. */
export interface ManifestEntry {
  /** Stable profile identifier. */
  readonly profileId: string;
  /** Kopia snapshot or object id most recently associated with the profile. */
  readonly snapshotId: string;
  /** Absolute path to the profile's user-data directory. */
  readonly dataDir: string;
  /** ISO-8601 timestamp of when this entry was written. */
  readonly updatedAt: string;
}

/** Top-level manifest document. */
export interface SyncManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly entries: readonly ManifestEntry[];
}

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

// IDs: letters, digits, dash, underscore. 1..128 chars. No separators/dots.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Validate an identifier (profile id / snapshot id). */
export function validateId(id: unknown, label: string): string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new ManifestValidationError(
      `${label} must match ${ID_RE.source} (got ${JSON.stringify(id)})`,
    );
  }
  return id;
}

/**
 * Validate that a path is absolute and contains no traversal segments. Returns
 * a normalized absolute path. Does NOT touch the filesystem.
 */
export function validateSafePath(p: unknown, label: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new ManifestValidationError(`${label} must be a non-empty string`);
  }
  if (!isAbsolute(p)) {
    throw new ManifestValidationError(`${label} must be an absolute path: ${p}`);
  }
  // Inspect the RAW segments before normalize() collapses ".." — otherwise a
  // path like /var/../etc would be silently rewritten to /etc and slip past.
  const rawSegments = p.split(/[/\\]/);
  if (rawSegments.includes("..")) {
    throw new ManifestValidationError(`${label} must not contain ".." segments: ${p}`);
  }
  const normalized = normalize(p);
  const segments = normalized.split(sep);
  if (segments.includes("..")) {
    throw new ManifestValidationError(`${label} must not contain ".." segments: ${p}`);
  }
  return resolve(normalized);
}

function validateEntry(value: unknown, index: number): ManifestEntry {
  if (typeof value !== "object" || value === null) {
    throw new ManifestValidationError(`entry[${index}] must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const profileId = validateId(raw.profileId, `entry[${index}].profileId`);
  const snapshotId = validateId(raw.snapshotId, `entry[${index}].snapshotId`);
  const dataDir = validateSafePath(raw.dataDir, `entry[${index}].dataDir`);
  const updatedAt = raw.updatedAt;
  if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) {
    throw new ManifestValidationError(`entry[${index}].updatedAt must be an ISO timestamp`);
  }
  return { profileId, snapshotId, dataDir, updatedAt };
}

/** Validate an in-memory manifest, returning a sanitized copy. */
export function validateManifest(value: unknown): SyncManifest {
  if (typeof value !== "object" || value === null) {
    throw new ManifestValidationError("manifest must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== MANIFEST_VERSION) {
    throw new ManifestValidationError(
      `unsupported manifest version: ${JSON.stringify(raw.version)}`,
    );
  }
  if (!Array.isArray(raw.entries)) {
    throw new ManifestValidationError("manifest.entries must be an array");
  }
  const entries = raw.entries.map((e, i) => validateEntry(e, i));

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.profileId)) {
      throw new ManifestValidationError(`duplicate profileId: ${entry.profileId}`);
    }
    seen.add(entry.profileId);
  }

  return { version: MANIFEST_VERSION, entries };
}

/**
 * Write a manifest atomically: serialize, validate, write to a temp file on the
 * same directory, then rename into place. The manifest path itself is validated
 * for safety.
 */
export async function writeManifest(manifestPath: string, manifest: SyncManifest): Promise<void> {
  const safePath = validateSafePath(manifestPath, "manifestPath");
  const validated = validateManifest(manifest);
  const dir = dirname(safePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${safePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(validated, null, 2);
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(tmp, safePath);
}

/**
 * Read + validate a manifest from disk. Malformed JSON or content that fails
 * validation raises {@link ManifestValidationError}.
 */
export async function readManifest(manifestPath: string): Promise<SyncManifest> {
  const safePath = validateSafePath(manifestPath, "manifestPath");
  let text: string;
  try {
    text = await readFile(safePath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestValidationError(`unable to read manifest: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestValidationError(`manifest is not valid JSON: ${reason}`);
  }
  return validateManifest(parsed);
}
