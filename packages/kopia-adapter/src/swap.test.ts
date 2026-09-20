import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SwapError, atomicSwap, nodeSwapFs, sameVolumeSync, type SwapFs } from "./swap.js";

/** A fake SwapFs that simulates a same-volume filesystem and can be told to
 * fail on a specific rename target to exercise rollback. */
function makeFakeFs(opts: {
  existing: Set<string>;
  failRename?: { from: string; to: string };
}): { fs: SwapFs; ops: string[]; existing: Set<string> } {
  const existing = new Set(opts.existing);
  const ops: string[] = [];
  const fs: SwapFs = {
    deviceId: async () => 42, // everything on the same volume
    exists: async (p) => existing.has(p),
    rename: async (from, to) => {
      ops.push(`rename ${from} -> ${to}`);
      if (opts.failRename && opts.failRename.from === from && opts.failRename.to === to) {
        throw new Error(`simulated rename failure ${from} -> ${to}`);
      }
      existing.delete(from);
      existing.add(to);
    },
    remove: async (p) => {
      ops.push(`remove ${p}`);
      existing.delete(p);
    },
  };
  return { fs, ops, existing };
}

test("happy path: staging becomes live, previous live moved to backup", async () => {
  const { fs, ops, existing } = makeFakeFs({
    existing: new Set(["/live", "/staging"]),
  });
  const result = await atomicSwap(
    { stagingDir: "/staging", liveDir: "/live", backupDir: "/backup" },
    fs,
  );
  assert.equal(result.backupDir, "/backup");
  assert.deepEqual(ops, ["rename /live -> /backup", "rename /staging -> /live"]);
  assert.ok(existing.has("/live"));
  assert.ok(existing.has("/backup"));
});

test("rollback: failure to install staging restores original live from backup", async () => {
  const { fs, ops, existing } = makeFakeFs({
    existing: new Set(["/live", "/staging"]),
    failRename: { from: "/staging", to: "/live" }, // fail installing staging
  });
  await assert.rejects(
    () => atomicSwap({ stagingDir: "/staging", liveDir: "/live", backupDir: "/backup" }, fs),
    (err: unknown) => {
      assert.ok(err instanceof SwapError);
      assert.match(err.message, /rolled back/);
      return true;
    },
  );
  // After rollback the original live must exist again and backup must be gone.
  assert.ok(existing.has("/live"), "live should be restored");
  assert.ok(!existing.has("/backup"), "backup should be renamed back to live");
  assert.ok(ops.includes("rename /backup -> /live"), "rollback rename must occur");
});

test("refuses when staging dir is missing", async () => {
  const { fs } = makeFakeFs({ existing: new Set(["/live"]) });
  await assert.rejects(
    () => atomicSwap({ stagingDir: "/staging", liveDir: "/live", backupDir: "/backup" }, fs),
    /staging dir does not exist/,
  );
});

test("refuses when backup dir already exists", async () => {
  const { fs } = makeFakeFs({ existing: new Set(["/live", "/staging", "/backup"]) });
  await assert.rejects(
    () => atomicSwap({ stagingDir: "/staging", liveDir: "/live", backupDir: "/backup" }, fs),
    /backup dir already exists/,
  );
});

test("cross-volume staging is refused", async () => {
  const fs: SwapFs = {
    deviceId: async (p) => (p.includes("staging") ? 1 : 2),
    exists: async () => true,
    rename: async () => {
      throw new Error("should not rename");
    },
    remove: async () => {},
  };
  // backup already existing would trip first; use a non-existing backup.
  const fs2: SwapFs = { ...fs, exists: async (p) => p !== "/backup" };
  await assert.rejects(
    () => atomicSwap({ stagingDir: "/staging", liveDir: "/live", backupDir: "/backup" }, fs2),
    /not on the same volume/,
  );
});

test("real fs same-volume swap moves data atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "kopia-swap-"));
  const live = join(root, "live");
  const staging = join(root, "staging");
  const backup = join(root, "backup");
  await mkdir(live, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(live, "marker.txt"), "old", "utf8");
  await writeFile(join(staging, "marker.txt"), "new", "utf8");

  assert.ok(sameVolumeSync(staging, live));

  const result = await atomicSwap({ stagingDir: staging, liveDir: live, backupDir: backup }, nodeSwapFs);
  assert.equal(result.backupDir, backup);

  // Live now holds the new data; backup holds the old data.
  assert.equal(await readFile(join(live, "marker.txt"), "utf8"), "new");
  assert.equal(await readFile(join(backup, "marker.txt"), "utf8"), "old");
  const entries = await readdir(root);
  assert.ok(entries.includes("live"));
  assert.ok(entries.includes("backup"));
  assert.ok(!entries.includes("staging"));
});
