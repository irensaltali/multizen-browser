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
