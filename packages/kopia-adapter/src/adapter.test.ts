import { test } from "node:test";
import assert from "node:assert/strict";

import { KopiaAdapter, KopiaCommandError } from "./adapter.js";
import { FakeRunner } from "./fake-runner.js";
import { TagValidationError } from "./commands.js";
import { ResourceBusyError, alwaysQuiescentGuard, type QuiescenceGuard } from "./quiescence.js";
import type { KopiaSecrets } from "./env.js";

const SECRETS: KopiaSecrets = {
  kopiaPassword: "top-secret-pw",
  awsAccessKeyId: "AKIAEXAMPLE",
  awsSecretAccessKey: "shh-secret-key",
  awsSessionToken: "sess-token",
};

const SECRET_VALUES = ["top-secret-pw", "AKIAEXAMPLE", "shh-secret-key", "sess-token"];

function makeAdapter(runner: FakeRunner, guard: QuiescenceGuard = alwaysQuiescentGuard) {
  return new KopiaAdapter({
    bin: "/opt/kopia",
    global: { configFile: "/cfg/repository.config" },
    secrets: SECRETS,
    runner,
    guard,
    parentEnv: { PATH: "/usr/bin" },
  });
}

test("no secret value ever appears in argv, secrets are in env", async () => {
  const runner = new FakeRunner(() => ({ code: 0, stdout: "{}" }));
  const adapter = makeAdapter(runner);
  await adapter.snapshot("profile-1", "/data/profile-1");

  const call = runner.lastCall;
  const argvJoined = call.args.join("\u0000");
  for (const secret of SECRET_VALUES) {
    assert.ok(!argvJoined.includes(secret), `argv leaked secret ${secret}`);
  }
  // Secrets present in env only.
  assert.equal(call.env.KOPIA_PASSWORD, "top-secret-pw");
  assert.equal(call.env.AWS_SECRET_ACCESS_KEY, "shh-secret-key");
  // Redaction list is wired up.
  assert.deepEqual([...call.redact ?? []].sort(), [...SECRET_VALUES].sort());
});

test("snapshot refuses when resource is not quiescent", async () => {
  const runner = new FakeRunner();
  const busyGuard: QuiescenceGuard = {
    check: () => ({ quiescent: false, reason: "browser running" }),
  };
  const adapter = makeAdapter(runner, busyGuard);

  await assert.rejects(() => adapter.snapshot("p1", "/data/p1"), ResourceBusyError);
  // Must refuse BEFORE spawning any process.
  assert.equal(runner.calls.length, 0);
});

test("restore refuses when resource is not quiescent", async () => {
  const runner = new FakeRunner();
  const busyGuard: QuiescenceGuard = { check: () => ({ quiescent: false }) };
  const adapter = makeAdapter(runner, busyGuard);

  await assert.rejects(() => adapter.restore("p1", "snap1", "/restore/p1"), ResourceBusyError);
  assert.equal(runner.calls.length, 0);
});

test("list parses JSON array output", async () => {
  const runner = new FakeRunner(() => ({ code: 0, stdout: '[{"id":"s1"},{"id":"s2"}]' }));
  const adapter = makeAdapter(runner);
  const snaps = await adapter.list();
  assert.deepEqual(snaps, [{ id: "s1" }, { id: "s2" }]);
});

test("snapshot returns parsed JSON manifest", async () => {
  const runner = new FakeRunner(() => ({ code: 0, stdout: '{"id":"snap-abc","rootID":"k9"}' }));
  const adapter = makeAdapter(runner);
  const manifest = await adapter.snapshot("p1", "/data/p1");
  assert.deepEqual(manifest, { id: "snap-abc", rootID: "k9" });
});

test("non-zero exit surfaces KopiaCommandError with redacted stderr", async () => {
  const runner = new FakeRunner(() => ({
    code: 1,
    stderr: "auth failed for key top-secret-pw",
  }));
  const adapter = makeAdapter(runner);
  await assert.rejects(
    () => adapter.list(),
    (err: unknown) => {
      assert.ok(err instanceof KopiaCommandError);
      assert.ok(!err.message.includes("top-secret-pw"), "error leaked secret");
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("timeout surfaces a timeout error", async () => {
  const runner = new FakeRunner(() => ({ code: null, timedOut: true }));
  const adapter = makeAdapter(runner);
  await assert.rejects(() => adapter.list(), /timed out/);
});

test("abort surfaces an aborted error", async () => {
  const runner = new FakeRunner(() => ({ code: null, aborted: true }));
  const adapter = makeAdapter(runner);
  await assert.rejects(() => adapter.list(), /aborted/);
});

test("every invocation carries credential-hardening global flags", async () => {
  const runner = new FakeRunner(() => ({ code: 0, stdout: "{}" }));
  const adapter = makeAdapter(runner);
  await adapter.snapshot("p1", "/data/p1");
  const args = runner.lastCall.args;
  assert.ok(args.includes("--no-persist-credentials"));
  assert.ok(!args.includes("--persist-credentials"));
});

test("snapshot accepts validated tags and emits them on argv (not env)", async () => {
  const runner = new FakeRunner(() => ({ code: 0, stdout: "{}" }));
  const adapter = makeAdapter(runner);
  await adapter.snapshot("p1", "/data/p1", {
    profileId: "p1",
    deviceId: "dev-1",
    baseRevision: "5",
    operationId: "op-7",
  });
  const args = runner.lastCall.args;
  // Repeated --tags key:value in fixed order.
  const tagIdx = args.indexOf("--tags");
  assert.ok(tagIdx !== -1, "expected --tags present");
  assert.ok(args.includes("profileId:p1"));
  assert.ok(args.includes("deviceId:dev-1"));
  assert.ok(args.includes("baseRevision:5"));
  assert.ok(args.includes("operationId:op-7"));
  // Tags are correlation ids only — never mirrored into the secret env keys.
  assert.equal(runner.lastCall.env.KOPIA_PASSWORD, "top-secret-pw");
  const envJoined = JSON.stringify(runner.lastCall.env);
  assert.ok(!envJoined.includes("op-7") || runner.lastCall.env.AWS_SESSION_TOKEN !== "op-7");
});

test("snapshot with invalid tag rejects BEFORE spawning a process", async () => {
  const runner = new FakeRunner();
  const adapter = makeAdapter(runner);
  await assert.rejects(
    () => adapter.snapshot("p1", "/data/p1", { operationId: "bad\nvalue" }),
    TagValidationError,
  );
  assert.equal(runner.calls.length, 0);
});

test("snapshot with a secret-looking tag value is rejected, no leakage to argv", async () => {
  const runner = new FakeRunner();
  const adapter = makeAdapter(runner);
  await assert.rejects(
    () => adapter.snapshot("p1", "/data/p1", { operationId: "top-secret-pw shh" }),
    TagValidationError,
  );
  assert.equal(runner.calls.length, 0);
});

test("existing two-arg snapshot call site still works (tags optional)", async () => {
  const runner = new FakeRunner(() => ({ code: 0, stdout: '{"id":"snap-1"}' }));
  const adapter = makeAdapter(runner);
  const manifest = await adapter.snapshot("p1", "/data/p1");
  assert.deepEqual(manifest, { id: "snap-1" });
  assert.ok(!runner.lastCall.args.includes("--tags"));
});

// ---------------------------------------------------------------------------
// Profile-scoped logical deletion: list + delete safety, idempotency, redaction.
// ---------------------------------------------------------------------------

const SNAP_A = "0fd9a53ff5c74d04b5739ff1a8106b8a";
const SNAP_B = "1122334455667788990011223344aabb";
const SNAP_OTHER = "ffffffffffffffffffffffffffffffff";

function snapRecord(id: string, profileId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    source: { host: "h", userName: "u", path: "/data/" + profileId },
    tags: { "tag:profileId": profileId, "tag:deviceId": "devA" },
    ...extra,
  };
}

/** Guarded access to the Nth recorded call (keeps strict TS happy). */
function callAt(runner: FakeRunner, index: number) {
  const call = runner.calls[index];
  assert.ok(call, `expected a recorded call at index ${index}`);
  return call;
}

test("listProfileSnapshots: filters by validated profileId tag on argv", async () => {
  const runner = new FakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify([snapRecord(SNAP_A, "p1")]),
  }));
  const adapter = makeAdapter(runner);
  const snaps = await adapter.listProfileSnapshots("p1");
  assert.equal(snaps.length, 1);
  const [only] = snaps;
  assert.ok(only);
  assert.equal(only.id, SNAP_A);
  assert.equal(only.profileId, "p1");

  const args = runner.lastCall.args;
  assert.ok(args.includes("--tags"));
  assert.ok(args.includes("profileId:p1"));
  assert.ok(args.includes("--all"));
  assert.ok(args.includes("--json"));
});

test("listProfileSnapshots: rejects a malformed profileId before spawning", async () => {
  const runner = new FakeRunner();
  const adapter = makeAdapter(runner);
  await assert.rejects(() => adapter.listProfileSnapshots("bad id!"), /profileId/);
  assert.equal(runner.calls.length, 0);
});

test("listProfileSnapshots: drops records for OTHER profiles even if returned", async () => {
  const runner = new FakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify([
      snapRecord(SNAP_A, "p1"),
      snapRecord(SNAP_OTHER, "p2"),
    ]),
  }));
  const adapter = makeAdapter(runner);
  const snaps = await adapter.listProfileSnapshots("p1");
  assert.deepEqual(snaps.map((s) => s.id), [SNAP_A]);
});

test("listProfileSnapshots: defends against malformed list entries", async () => {
  const runner = new FakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify([
      snapRecord(SNAP_A, "p1"),
      null,
      42,
      "a string",
      { id: SNAP_B },
      { id: "not-hex!", tags: { "tag:profileId": "p1" } },
      { tags: { "tag:profileId": "p1" } },
      { id: SNAP_B, tags: { "tag:profileId": "p1x" } },
    ]),
  }));
  const adapter = makeAdapter(runner);
  const snaps = await adapter.listProfileSnapshots("p1");
  assert.deepEqual(snaps.map((s) => s.id), [SNAP_A]);
});

test("listProfileSnapshots: de-duplicates repeated ids", async () => {
  const runner = new FakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify([snapRecord(SNAP_A, "p1"), snapRecord(SNAP_A, "p1")]),
  }));
  const adapter = makeAdapter(runner);
  const snaps = await adapter.listProfileSnapshots("p1");
  assert.deepEqual(snaps.map((s) => s.id), [SNAP_A]);
});

test("deleteProfileSnapshots: lists once then deletes exact validated ids", async () => {
  const runner = new FakeRunner((req) => {
    if (req.args.includes("list")) {
      return { code: 0, stdout: JSON.stringify([snapRecord(SNAP_A, "p1"), snapRecord(SNAP_B, "p1")]) };
    }
    return { code: 0, stdout: "" };
  });
  const adapter = makeAdapter(runner);
  const result = await adapter.deleteProfileSnapshots("p1");

  assert.deepEqual(result.deletedIds, [SNAP_A, SNAP_B]);
  assert.equal(result.deleted, 2);
  assert.equal(result.profileId, "p1");

  assert.equal(runner.calls.length, 2);
  const deleteArgs = callAt(runner, 1).args;
  assert.deepEqual(
    deleteArgs.slice(deleteArgs.indexOf("snapshot")),
    ["snapshot", "delete", SNAP_A, SNAP_B, "--delete"],
  );
  assert.ok(!deleteArgs.includes("--all-snapshots-for-source"));
});

test("deleteProfileSnapshots: no secret value in the delete argv, secrets env-only", async () => {
  const runner = new FakeRunner((req) =>
    req.args.includes("list")
      ? { code: 0, stdout: JSON.stringify([snapRecord(SNAP_A, "p1")]) }
      : { code: 0, stdout: "" },
  );
  const adapter = makeAdapter(runner);
  await adapter.deleteProfileSnapshots("p1");
  const deleteCall = callAt(runner, 1);
  const joined = deleteCall.args.join("\u0000");
  for (const secret of SECRET_VALUES) {
    assert.ok(!joined.includes(secret), `delete argv leaked secret ${secret}`);
  }
  assert.equal(deleteCall.env.KOPIA_PASSWORD, "top-secret-pw");
  assert.deepEqual([...(deleteCall.redact ?? [])].sort(), [...SECRET_VALUES].sort());
});

test("deleteProfileSnapshots: zero snapshots is an idempotent no-op success", async () => {
  const runner = new FakeRunner(() => ({ code: 0, stdout: "[]" }));
  const adapter = makeAdapter(runner);
  const result = await adapter.deleteProfileSnapshots("p1");
  assert.deepEqual(result.deletedIds, []);
  assert.equal(result.deleted, 0);
  assert.equal(runner.calls.length, 1);
  assert.ok(!runner.lastCall.args.includes("delete"));
});

test("deleteProfileSnapshots: cannot select another profile's snapshots", async () => {
  const runner = new FakeRunner((req) =>
    req.args.includes("list")
      ? {
          code: 0,
          stdout: JSON.stringify([snapRecord(SNAP_A, "p1"), snapRecord(SNAP_OTHER, "p2")]),
        }
      : { code: 0, stdout: "" },
  );
  const adapter = makeAdapter(runner);
  const result = await adapter.deleteProfileSnapshots("p1");
  assert.deepEqual(result.deletedIds, [SNAP_A]);
  const deleteArgs = callAt(runner, 1).args;
  assert.ok(deleteArgs.includes(SNAP_A));
  assert.ok(!deleteArgs.includes(SNAP_OTHER));
});

test("deleteProfileSnapshots: delete failure surfaces redacted KopiaCommandError", async () => {
  const runner = new FakeRunner((req) =>
    req.args.includes("list")
      ? { code: 0, stdout: JSON.stringify([snapRecord(SNAP_A, "p1")]) }
      : { code: 1, stderr: "delete failed using key top-secret-pw" },
  );
  const adapter = makeAdapter(runner);
  await assert.rejects(
    () => adapter.deleteProfileSnapshots("p1"),
    (err: unknown) => {
      assert.ok(err instanceof KopiaCommandError);
      assert.ok(!err.message.includes("top-secret-pw"), "delete error leaked secret");
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("deleteProfileSnapshots: list failure aborts before any delete", async () => {
  const runner = new FakeRunner(() => ({ code: 1, stderr: "list failed" }));
  const adapter = makeAdapter(runner);
  await assert.rejects(() => adapter.deleteProfileSnapshots("p1"), KopiaCommandError);
  assert.equal(runner.calls.length, 1);
  assert.ok(!runner.lastCall.args.includes("delete"));
});

test("runMaintenance: builds verified argv and is never called implicitly", async () => {
  const runner = new FakeRunner(() => ({ code: 0, stdout: "" }));
  const adapter = makeAdapter(runner);
  await adapter.runMaintenance({ full: true, safety: "full" });
  const args = runner.lastCall.args;
  assert.deepEqual(
    args.slice(args.indexOf("maintenance")),
    ["maintenance", "run", "--full", "--safety=full"],
  );
});
