import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideLaunch,
  decideRestore,
  classifyConflict,
  conflictCopyName,
  decidePublish,
} from "./decisions.js";
import { SyncErrorCode } from "./errors.js";
import type { Lease, ProfileSyncState } from "./types.js";

function state(over: Partial<ProfileSyncState> = {}): ProfileSyncState {
  return {
    profileId: "p1",
    syncEnabled: true,
    localRevision: 5,
    baseRevision: 5,
    remoteRevision: 5,
    dirty: false,
    latestSnapshotId: "snap-5",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ── decideLaunch ────────────────────────────────────────────────────────────

test("decideLaunch: sync disabled always launches", () => {
  const d = decideLaunch(state({ syncEnabled: false, dirty: true, localRevision: 1 }), 99);
  assert.deepEqual(d, { action: "launch" });
});

test("decideLaunch: remote == local → launch", () => {
  assert.deepEqual(decideLaunch(state({ localRevision: 5 }), 5), { action: "launch" });
});

test("decideLaunch: remote < local → launch", () => {
  assert.deepEqual(decideLaunch(state({ localRevision: 7 }), 5), { action: "launch" });
});

test("decideLaunch: remote > local, clean → restore-then-launch", () => {
  assert.deepEqual(decideLaunch(state({ localRevision: 5, dirty: false }), 8), {
    action: "restore-then-launch",
    targetRevision: 8,
  });
});

test("decideLaunch: dirty + remote advanced past base → conflict", () => {
  const d = decideLaunch(state({ localRevision: 5, baseRevision: 5, dirty: true }), 8);
  assert.deepEqual(d, { action: "conflict", baseRevision: 5, remoteRevision: 8 });
});

test("decideLaunch: dirty + remote not past base → launch (local ahead)", () => {
  // localRevision 6, base 6, remote 6 but dirty: remote not > local so launch.
  const d = decideLaunch(state({ localRevision: 6, baseRevision: 6, dirty: true }), 6);
  assert.deepEqual(d, { action: "launch" });
});

test("decideLaunch: negative revision → blocked LocalStateCorrupt", () => {
  const d = decideLaunch(state({ localRevision: -1 }), 3);
  assert.equal(d.action, "blocked");
  if (d.action === "blocked") assert.equal(d.error.code, SyncErrorCode.LocalStateCorrupt);
});

// ── decideRestore ─────────────────────────────────────────────────────────

test("decideRestore: disabled → skip", () => {
  assert.deepEqual(decideRestore(state({ syncEnabled: false }), 9), { action: "skip" });
});

test("decideRestore: remote <= local → skip", () => {
  assert.deepEqual(decideRestore(state({ localRevision: 5 }), 5), { action: "skip" });
});

test("decideRestore: clean + remote newer → restore", () => {
  assert.deepEqual(decideRestore(state({ localRevision: 5, dirty: false }), 9), {
    action: "restore",
    targetRevision: 9,
    snapshotRequired: true,
  });
});

test("decideRestore: dirty + remote advanced → blocked ConflictDetected", () => {
  const d = decideRestore(state({ localRevision: 5, baseRevision: 5, dirty: true }), 9);
  assert.equal(d.action, "blocked");
  if (d.action === "blocked") assert.equal(d.error.code, SyncErrorCode.ConflictDetected);
});

// ── classifyConflict ────────────────────────────────────────────────────────

test("classifyConflict: clean + up to date → none", () => {
  assert.deepEqual(classifyConflict(state({ localRevision: 5, dirty: false }), 5), {
    kind: "none",
  });
});

test("classifyConflict: clean + remote newer → fast-forward", () => {
  assert.deepEqual(classifyConflict(state({ localRevision: 5, dirty: false }), 8), {
    kind: "fast-forward",
    targetRevision: 8,
  });
});

test("classifyConflict: dirty + remote at base → local-ahead", () => {
  assert.deepEqual(classifyConflict(state({ localRevision: 5, baseRevision: 5, dirty: true }), 5), {
    kind: "local-ahead",
  });
});

test("classifyConflict: dirty + remote advanced → conflict", () => {
  assert.deepEqual(classifyConflict(state({ localRevision: 5, baseRevision: 5, dirty: true }), 9), {
    kind: "conflict",
    baseRevision: 5,
    remoteRevision: 9,
  });
});

// ── conflictCopyName ────────────────────────────────────────────────────────

test("conflictCopyName: builds deterministic name", () => {
  assert.equal(conflictCopyName("Amazon US", "Mac Studio"), "Amazon US - Conflict - Mac Studio");
});

test("conflictCopyName: trims and handles empty device", () => {
  assert.equal(conflictCopyName("  Amazon US  ", "   "), "Amazon US - Conflict");
});

test("conflictCopyName: is stable across calls", () => {
  const a = conflictCopyName("X", "Y");
  const b = conflictCopyName("X", "Y");
  assert.equal(a, b);
});

// ── decidePublish ────────────────────────────────────────────────────────

const validLease = (over: Partial<Lease> = {}): Lease => ({
  profileId: "p1",
  ownerDeviceId: "dev-A",
  expiresAtMs: 10_000,
  fencingToken: 3,
  ...over,
});

test("decidePublish: disabled → skip sync-disabled", () => {
  const d = decidePublish(state({ syncEnabled: false }), 5, {
    browserExited: true,
    lease: validLease(),
    nowMs: 1_000,
    deviceId: "dev-A",
  });
  assert.deepEqual(d, { action: "skip", reason: "sync-disabled" });
});

test("decidePublish: not dirty → skip not-dirty", () => {
  const d = decidePublish(state({ dirty: false }), 5, {
    browserExited: true,
    lease: validLease(),
    nowMs: 1_000,
    deviceId: "dev-A",
  });
  assert.deepEqual(d, { action: "skip", reason: "not-dirty" });
});

test("decidePublish: browser still running → blocked BrowserStillRunning", () => {
  const d = decidePublish(state({ dirty: true }), 5, {
    browserExited: false,
    lease: validLease(),
    nowMs: 1_000,
    deviceId: "dev-A",
  });
  assert.equal(d.action, "blocked");
  if (d.action === "blocked") assert.equal(d.error.code, SyncErrorCode.BrowserStillRunning);
});

test("decidePublish: no lease → blocked LeaseHeldByOther", () => {
  const d = decidePublish(state({ dirty: true }), 5, {
    browserExited: true,
    lease: null,
    nowMs: 1_000,
    deviceId: "dev-A",
  });
  assert.equal(d.action, "blocked");
  if (d.action === "blocked") assert.equal(d.error.code, SyncErrorCode.LeaseHeldByOther);
});

test("decidePublish: lease owned by other → blocked LeaseHeldByOther", () => {
  const d = decidePublish(state({ dirty: true }), 5, {
    browserExited: true,
    lease: validLease({ ownerDeviceId: "dev-B" }),
    nowMs: 1_000,
    deviceId: "dev-A",
  });
  assert.equal(d.action, "blocked");
  if (d.action === "blocked") assert.equal(d.error.code, SyncErrorCode.LeaseHeldByOther);
});

test("decidePublish: expired lease → blocked LeaseExpired", () => {
  const d = decidePublish(state({ dirty: true }), 5, {
    browserExited: true,
    lease: validLease({ expiresAtMs: 500 }),
    nowMs: 1_000,
    deviceId: "dev-A",
  });
  assert.equal(d.action, "blocked");
  if (d.action === "blocked") assert.equal(d.error.code, SyncErrorCode.LeaseExpired);
});

test("decidePublish: remote advanced past base → blocked ConflictDetected", () => {
  const d = decidePublish(state({ dirty: true, baseRevision: 5, localRevision: 5 }), 9, {
    browserExited: true,
    lease: validLease(),
    nowMs: 1_000,
    deviceId: "dev-A",
  });
  assert.equal(d.action, "blocked");
  if (d.action === "blocked") assert.equal(d.error.code, SyncErrorCode.ConflictDetected);
});

test("decidePublish: happy path → publish nextRevision = anchor+1", () => {
  const d = decidePublish(state({ dirty: true, baseRevision: 5, localRevision: 5 }), 5, {
    browserExited: true,
    lease: validLease(),
    nowMs: 1_000,
    deviceId: "dev-A",
  });
  assert.deepEqual(d, { action: "publish", expectedBaseRevision: 5, nextRevision: 6 });
});

test("decidePublish: local ahead of remote/base still bumps from max anchor", () => {
  const d = decidePublish(state({ dirty: true, baseRevision: 5, localRevision: 7 }), 5, {
    browserExited: true,
    lease: validLease(),
    nowMs: 1_000,
    deviceId: "dev-A",
  });
  assert.deepEqual(d, { action: "publish", expectedBaseRevision: 5, nextRevision: 8 });
});
