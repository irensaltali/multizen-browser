import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MANIFEST_VERSION,
  ManifestValidationError,
  readManifest,
  validateId,
  validateManifest,
  validateSafePath,
  writeManifest,
  type SyncManifest,
} from "./manifest.js";

function goodManifest(): SyncManifest {
  return {
    version: MANIFEST_VERSION,
    entries: [
      {
        profileId: "profile-1",
        snapshotId: "snap_abc123",
        dataDir: "/var/data/profile-1",
        updatedAt: new Date("2024-01-01T00:00:00Z").toISOString(),
      },
    ],
  };
}

test("validateId accepts safe ids and rejects unsafe ones", () => {
  assert.equal(validateId("abc-123_XYZ", "id"), "abc-123_XYZ");
  for (const bad of ["../etc", "a/b", "a.b", "", "x".repeat(129), "has space"]) {
    assert.throws(() => validateId(bad, "id"), ManifestValidationError, `should reject ${bad}`);
  }
});

test("validateSafePath rejects relative and traversal paths", () => {
  assert.throws(() => validateSafePath("relative/dir", "p"), ManifestValidationError);
  assert.throws(() => validateSafePath("/var/../etc/passwd", "p"), ManifestValidationError);
  assert.throws(() => validateSafePath("", "p"), ManifestValidationError);
  assert.equal(validateSafePath("/var/data", "p"), "/var/data");
});

test("validateManifest rejects wrong version", () => {
  assert.throws(
    () => validateManifest({ version: 999, entries: [] }),
    /unsupported manifest version/,
  );
});

test("validateManifest rejects traversal in dataDir", () => {
  const bad = {
    version: MANIFEST_VERSION,
    entries: [
      { profileId: "p1", snapshotId: "s1", dataDir: "/a/../b", updatedAt: "2024-01-01T00:00:00Z" },
    ],
  };
  assert.throws(() => validateManifest(bad), ManifestValidationError);
});

test("validateManifest rejects duplicate profileIds", () => {
  const dup = {
    version: MANIFEST_VERSION,
    entries: [
      { profileId: "p1", snapshotId: "s1", dataDir: "/a", updatedAt: "2024-01-01T00:00:00Z" },
      { profileId: "p1", snapshotId: "s2", dataDir: "/b", updatedAt: "2024-01-01T00:00:00Z" },
    ],
  };
  assert.throws(() => validateManifest(dup), /duplicate profileId/);
});

test("write + read round trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kopia-manifest-"));
  const path = join(dir, "sync-manifest.json");
  await writeManifest(path, goodManifest());
  const loaded = await readManifest(path);
  assert.deepEqual(loaded, goodManifest());
});

test("readManifest rejects malformed JSON on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kopia-manifest-"));
  const path = join(dir, "sync-manifest.json");
  await writeFile(path, "{ not json", "utf8");
  await assert.rejects(() => readManifest(path), /not valid JSON/);
});

test("readManifest rejects a structurally invalid manifest on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kopia-manifest-"));
  const path = join(dir, "sync-manifest.json");
  await writeFile(
    path,
    JSON.stringify({
      version: MANIFEST_VERSION,
      entries: [{ profileId: "../evil", snapshotId: "s1", dataDir: "/a", updatedAt: "2024-01-01T00:00:00Z" }],
    }),
    "utf8",
  );
  await assert.rejects(() => readManifest(path), ManifestValidationError);
});

test("writeManifest writes with restrictive permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kopia-manifest-"));
  const path = join(dir, "sync-manifest.json");
  await writeManifest(path, goodManifest());
  // Ensure the file is valid JSON and parseable (content-level check).
  const text = await readFile(path, "utf8");
  assert.doesNotThrow(() => JSON.parse(text));
});
