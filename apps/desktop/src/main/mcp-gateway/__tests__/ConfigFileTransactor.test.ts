import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalizeWorkspace,
  ConfigFileError,
  ConfigFileTransactor,
  hashContent,
  resolveTargetPath,
} from "../ConfigFileTransactor.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mz-cft-"));
}

function transactor(root: string, maxBackups?: number): ConfigFileTransactor {
  return new ConfigFileTransactor({
    backupDir: join(root, "backups"),
    ...(maxBackups !== undefined ? { maxBackups } : {}),
  });
}

// ── canonicalization ────────────────────────────────────────────────────────

test("canonicalizeWorkspace resolves a real directory and rejects non-absolute paths", async () => {
  const dir = tmp();
  try {
    const ws = join(dir, "work");
    mkdirSync(ws);
    const canonical = await canonicalizeWorkspace(ws);
    assert.equal(typeof canonical, "string");
    assert.equal(canonical.endsWith("work"), true);

    await assert.rejects(
      () => canonicalizeWorkspace("relative/path"),
      (e: ConfigFileError) => e.code === "traversal-refused",
    );
    await assert.rejects(
      () => canonicalizeWorkspace(""),
      (e: ConfigFileError) => e.code === "traversal-refused",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonicalizeWorkspace reports a missing directory and a non-directory distinctly", async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      () => canonicalizeWorkspace(join(dir, "nope")),
      (e: ConfigFileError) => e.code === "not-found" && typeof e.hint === "string",
    );
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    await assert.rejects(
      () => canonicalizeWorkspace(file),
      (e: ConfigFileError) => e.code === "not-a-directory",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlinked workspace root is canonicalized to its real path", async () => {
  const dir = tmp();
  try {
    const real = join(dir, "real");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link, "dir");
    const canonical = await canonicalizeWorkspace(link);
    assert.equal(canonical, await canonicalizeWorkspace(real), "both spellings agree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── target path validation ──────────────────────────────────────────────────

test("resolveTargetPath builds a contained path and rejects traversal segments", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const target = await resolveTargetPath(ws, [".cursor", "mcp.json"]);
    assert.equal(target, join(ws, ".cursor", "mcp.json"));

    for (const bad of [[".."], ["a", ".."], ["."], [""], ["a/b"], ["a\u0000b"]]) {
      await assert.rejects(
        () => resolveTargetPath(ws, bad),
        (e: ConfigFileError) => e.code === "traversal-refused",
        `expected ${JSON.stringify(bad)} to be refused`,
      );
    }
    await assert.rejects(
      () => resolveTargetPath(ws, []),
      (e: ConfigFileError) => e.code === "traversal-refused",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlinked config FILE is refused", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, join(ws, ".mcp.json"));
    await assert.rejects(
      () => resolveTargetPath(ws, [".mcp.json"]),
      (e: ConfigFileError) => e.code === "symlink-refused" && typeof e.hint === "string",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlinked intermediate DIRECTORY is refused", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(ws, ".cursor"), "dir");
    await assert.rejects(
      () => resolveTargetPath(ws, [".cursor", "mcp.json"]),
      (e: ConfigFileError) => e.code === "symlink-refused",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a not-yet-created nested path is allowed", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const target = await resolveTargetPath(ws, [".kiro", "settings", "mcp.json"]);
    assert.equal(target, join(ws, ".kiro", "settings", "mcp.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── apply: create / update / idempotence ────────────────────────────────────

test("apply creates a new file, including missing parent directories", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "ws"));
    const ws = await canonicalizeWorkspace(join(dir, "ws"));
    const tx = transactor(dir);
    const target = await resolveTargetPath(ws, [".kiro", "settings", "mcp.json"]);
    const res = await tx.apply(target, () => '{"mcpServers":{}}');
    assert.equal(res.changed, true);
    assert.equal(res.backupPath, undefined, "nothing to back up for a new file");
    assert.equal(readFileSync(target, "utf8"), '{"mcpServers":{}}');
    assert.equal(res.fileHash, hashContent('{"mcpServers":{}}'));
    assert.equal(statSync(target).mode & 0o777, 0o644, "config files are world-readable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply updates an existing file and archives the prior content", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");
    writeFileSync(target, "ORIGINAL");

    const res = await tx.apply(target, (cur) => {
      assert.equal(cur, "ORIGINAL", "the transform sees current content");
      return "UPDATED";
    });
    assert.equal(res.changed, true);
    assert.equal(readFileSync(target, "utf8"), "UPDATED");
    assert.ok(res.backupPath, "a backup was written");
    assert.equal(readFileSync(res.backupPath as string, "utf8"), "ORIGINAL");
    assert.equal(
      (res.backupPath as string).startsWith(join(dir, "backups")),
      true,
      "backups live under userData, not in the workspace",
    );
    // The workspace itself gained no stray files.
    assert.deepEqual(readdirSync(ws).sort(), [".mcp.json", "backups"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unchanged transform result is a true no-op: no write, no backup", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");
    writeFileSync(target, "SAME");
    const before = statSync(target).mtimeMs;

    const res = await tx.apply(target, () => "SAME");
    assert.equal(res.changed, false);
    assert.equal(res.backupPath, undefined);
    assert.equal(statSync(target).mtimeMs, before, "the file was not rewritten");
    assert.deepEqual(await tx.listBackups(target), [], "no backup churn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing file permissions are preserved across an update", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");
    writeFileSync(target, "A");
    chmodSync(target, 0o600);

    await tx.apply(target, () => "B");
    assert.equal(statSync(target).mode & 0o777, 0o600, "0600 survived the atomic replace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no temp files are left behind after a successful apply", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");
    await tx.apply(target, () => "X");
    await tx.apply(target, () => "Y");
    const leftovers = readdirSync(ws).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── failure paths ───────────────────────────────────────────────────────────

test("a transform that throws leaves the original file untouched and writes no backup", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");
    writeFileSync(target, "ORIGINAL");

    await assert.rejects(
      () =>
        tx.apply(target, () => {
          throw new ConfigFileError("bad json", "malformed", "fix the file");
        }),
      (e: ConfigFileError) => e.code === "malformed" && e.hint === "fix the file",
    );
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL");
    assert.deepEqual(await tx.listBackups(target), []);
    assert.deepEqual(readdirSync(ws).filter((f) => f.includes(".tmp")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a concurrent modification aborts the write and preserves the other writer's content", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");
    writeFileSync(target, "ORIGINAL");

    await assert.rejects(
      () =>
        tx.apply(target, (cur) => {
          assert.equal(cur, "ORIGINAL");
          // Simulate another tool rewriting the file mid-transaction.
          writeFileSync(target, "THEIR EDIT");
          return "OUR EDIT";
        }),
      (e: ConfigFileError) => e.code === "concurrent-modification" && typeof e.hint === "string",
    );
    assert.equal(
      readFileSync(target, "utf8"),
      "THEIR EDIT",
      "the concurrent writer's content survives untouched",
    );
    assert.deepEqual(readdirSync(ws).filter((f) => f.includes(".tmp")), [], "temp cleaned up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a retry after a concurrent modification succeeds against the new content", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");
    writeFileSync(target, "ORIGINAL");
    let firstAttempt = true;

    const transform = (cur: string | null): string => {
      if (firstAttempt) {
        firstAttempt = false;
        writeFileSync(target, "THEIR EDIT");
      }
      return `${cur ?? ""}+OURS`;
    };
    await assert.rejects(() => tx.apply(target, transform));
    const res = await tx.apply(target, transform);
    assert.equal(res.changed, true);
    assert.equal(readFileSync(target, "utf8"), "THEIR EDIT+OURS", "merged onto the latest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reading through a symlinked target is refused by apply too", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "OUTSIDE");
    const target = join(ws, "linked.json");
    symlinkSync(outside, target);

    const tx = transactor(dir);
    await assert.rejects(
      () => tx.apply(target, () => "HACKED"),
      (e: ConfigFileError) => e.code === "symlink-refused",
    );
    assert.equal(readFileSync(outside, "utf8"), "OUTSIDE", "the link target was not written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read-only directory surfaces a permission error with a hint", async () => {
  if (process.getuid?.() === 0) return; // root ignores mode bits
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const locked = join(ws, "locked");
    mkdirSync(locked);
    const target = join(locked, ".mcp.json");
    writeFileSync(target, "ORIGINAL");
    chmodSync(locked, 0o500); // read + execute, no write

    const tx = transactor(dir);
    await assert.rejects(
      () => tx.apply(target, () => "NEW"),
      (e: ConfigFileError) => e.code === "permission" && typeof e.hint === "string",
    );
    chmodSync(locked, 0o700);
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL");
  } finally {
    try {
      chmodSync(join(dir, "locked"), 0o700);
    } catch {
      /* already restored */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── serialization ───────────────────────────────────────────────────────────

test("concurrent applies to one path serialize instead of losing an update", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");
    writeFileSync(target, "");

    // Each transform appends. Without serialization both would read "" and one
    // append would be lost.
    const append = (tag: string) => async (cur: string | null): Promise<string> => {
      await new Promise((r) => setTimeout(r, 5));
      return `${cur ?? ""}${tag}`;
    };
    await Promise.all([
      tx.apply(target, append("A")),
      tx.apply(target, append("B")),
      tx.apply(target, append("C")),
    ]);
    const final = readFileSync(target, "utf8");
    assert.equal(final.length, 3, `all three appends landed (got ${JSON.stringify(final)})`);
    assert.deepEqual(final.split("").sort(), ["A", "B", "C"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed apply does not stall the queue for later applies", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");

    await assert.rejects(() =>
      tx.apply(target, () => {
        throw new ConfigFileError("nope", "malformed");
      }),
    );
    const res = await tx.apply(target, () => "RECOVERED");
    assert.equal(res.changed, true);
    assert.equal(readFileSync(target, "utf8"), "RECOVERED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── backups ─────────────────────────────────────────────────────────────────

test("backup history is bounded and ordered newest-first", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    let clock = 1_700_000_000_000;
    const tx = new ConfigFileTransactor({
      backupDir: join(dir, "backups"),
      maxBackups: 3,
      now: () => (clock += 1000),
    });
    const target = join(ws, ".mcp.json");
    writeFileSync(target, "v0");
    for (let i = 1; i <= 6; i += 1) {
      await tx.apply(target, () => `v${i}`);
    }
    const backups = await tx.listBackups(target);
    assert.equal(backups.length, 3, "bounded to maxBackups");
    // Newest first: the most recent backup holds the content just before v6.
    assert.equal(readFileSync(backups[0] as string, "utf8"), "v5");
    assert.equal(readFileSync(backups[2] as string, "utf8"), "v3");
    assert.equal(readFileSync(target, "utf8"), "v6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a backup can restore the prior content after an unwanted change", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const target = join(ws, ".mcp.json");
    const original = '{"mcpServers":{"mine":{"command":"x"}}}';
    writeFileSync(target, original);
    await tx.apply(target, () => "{}");
    assert.equal(readFileSync(target, "utf8"), "{}");

    const [newest] = await tx.listBackups(target);
    assert.ok(newest);
    const recovered = readFileSync(newest as string, "utf8");
    assert.equal(recovered, original);
    // Restoring through the transactor keeps the same safety guarantees.
    await tx.apply(target, () => recovered);
    assert.equal(readFileSync(target, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backups of two different targets never collide, even with the same basename", async () => {
  const dir = tmp();
  try {
    const ws = await canonicalizeWorkspace(dir);
    const tx = transactor(dir);
    const a = join(ws, "a", ".mcp.json");
    const b = join(ws, "b", ".mcp.json");
    mkdirSync(join(ws, "a"));
    mkdirSync(join(ws, "b"));
    writeFileSync(a, "A0");
    writeFileSync(b, "B0");
    await tx.apply(a, () => "A1");
    await tx.apply(b, () => "B1");

    const ba = await tx.listBackups(a);
    const bb = await tx.listBackups(b);
    assert.equal(ba.length, 1);
    assert.equal(bb.length, 1);
    assert.equal(readFileSync(ba[0] as string, "utf8"), "A0");
    assert.equal(readFileSync(bb[0] as string, "utf8"), "B0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
