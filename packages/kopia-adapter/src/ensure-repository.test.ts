import { test } from "node:test";
import assert from "node:assert/strict";

import { KopiaAdapter, KopiaCommandError } from "./adapter.js";
import { isRepositoryNotInitialized } from "./ensure-repository.js";
import { FakeRunner } from "./fake-runner.js";
import { alwaysQuiescentGuard } from "./quiescence.js";
import type { KopiaSecrets } from "./env.js";
import type { S3Repository } from "./commands.js";

const SECRETS: KopiaSecrets = {
  kopiaPassword: "top-secret-pw",
  awsAccessKeyId: "AKIAEXAMPLE",
  awsSecretAccessKey: "shh-secret-key",
};

const SECRET_VALUES = ["top-secret-pw", "AKIAEXAMPLE", "shh-secret-key"];

const TARGET: S3Repository = {
  kind: "s3",
  bucket: "bucket",
  endpoint: "s3.example.com",
  region: "auto",
  prefix: "profiles/",
};

function makeAdapter(runner: FakeRunner) {
  return new KopiaAdapter({
    bin: "/opt/kopia",
    global: { configFile: "/cfg/repository.config" },
    secrets: SECRETS,
    runner,
    guard: alwaysQuiescentGuard,
    parentEnv: { PATH: "/usr/bin" },
  });
}

/** A runner whose behavior depends on which subcommand it sees. */
function subcommandRunner(
  handlers: { connect?: () => Partial<import("./process-runner.js").ProcessResult>; create?: () => Partial<import("./process-runner.js").ProcessResult> },
  counters?: { connect: number; create: number },
): FakeRunner {
  const c = counters ?? { connect: 0, create: 0 };
  return new FakeRunner((req) => {
    const isConnect = req.args.includes("connect");
    const isCreate = req.args.includes("create");
    if (isConnect) {
      c.connect += 1;
      return handlers.connect?.() ?? { code: 0 };
    }
    if (isCreate) {
      c.create += 1;
      return handlers.create?.() ?? { code: 0 };
    }
    return { code: 0 };
  });
}

// ── Pure matcher ────────────────────────────────────────────────────────────

test("isRepositoryNotInitialized matches the exact pinned message (case-insensitive)", () => {
  assert.equal(
    isRepositoryNotInitialized("ERROR: repository not initialized in the provided storage"),
    true,
  );
  assert.equal(
    isRepositoryNotInitialized("Repository Not Initialized In The Provided Storage"),
    true,
  );
  // Tolerant of extra inter-word whitespace.
  assert.equal(
    isRepositoryNotInitialized("repository  not   initialized  in the provided storage"),
    true,
  );
});

test("isRepositoryNotInitialized rejects unrelated repository/auth errors", () => {
  assert.equal(isRepositoryNotInitialized("invalid repository password"), false);
  assert.equal(isRepositoryNotInitialized("repository not found"), false);
  assert.equal(isRepositoryNotInitialized("error connecting to repository: access denied"), false);
  assert.equal(isRepositoryNotInitialized("network timeout reaching endpoint"), false);
  assert.equal(isRepositoryNotInitialized("repository is corrupted"), false);
  assert.equal(isRepositoryNotInitialized(""), false);
  assert.equal(isRepositoryNotInitialized(null), false);
  assert.equal(isRepositoryNotInitialized(undefined), false);
});

// ── ensureRepository behavior ─────────────────────────────────────────────

test("ensureRepository returns {created:false} when connect succeeds (no create)", async () => {
  const counters = { connect: 0, create: 0 };
  const runner = subcommandRunner({ connect: () => ({ code: 0 }) }, counters);
  const adapter = makeAdapter(runner);
  const res = await adapter.ensureRepository(TARGET);
  assert.deepEqual(res, { created: false });
  assert.equal(counters.connect, 1);
  assert.equal(counters.create, 0, "must not create when an existing repo connects");
});

test("ensureRepository creates when connect reports missing repo, returns {created:true}", async () => {
  const counters = { connect: 0, create: 0 };
  const runner = subcommandRunner(
    {
      connect: () => ({ code: 1, stderr: "repository not initialized in the provided storage" }),
      create: () => ({ code: 0 }),
    },
    counters,
  );
  const adapter = makeAdapter(runner);
  const res = await adapter.ensureRepository(TARGET);
  assert.deepEqual(res, { created: true });
  assert.equal(counters.connect, 1);
  assert.equal(counters.create, 1, "create invoked exactly once after missing-repo connect");
});

test("ensureRepository does NOT create on an unrelated connect error (propagates)", async () => {
  const counters = { connect: 0, create: 0 };
  const runner = subcommandRunner(
    { connect: () => ({ code: 1, stderr: "invalid repository password" }) },
    counters,
  );
  const adapter = makeAdapter(runner);
  await assert.rejects(() => adapter.ensureRepository(TARGET), KopiaCommandError);
  assert.equal(counters.create, 0, "auth error must NOT initialize a repository");
});

test("ensureRepository propagates a network connect error without creating", async () => {
  const counters = { connect: 0, create: 0 };
  const runner = subcommandRunner(
    { connect: () => ({ code: 1, stderr: "dial tcp: connection refused" }) },
    counters,
  );
  const adapter = makeAdapter(runner);
  await assert.rejects(() => adapter.ensureRepository(TARGET), KopiaCommandError);
  assert.equal(counters.create, 0);
});

test("ensureRepository resolves a create race via one reconnect, returns {created:false}", async () => {
  const counters = { connect: 0, create: 0 };
  const runner = subcommandRunner(
    {
      // First connect: missing. Second connect (after race): succeeds.
      connect: () =>
        counters.connect === 1
          ? { code: 1, stderr: "repository not initialized in the provided storage" }
          : { code: 0 },
      // Create loses the race: repo already initialized concurrently.
      create: () => ({ code: 1, stderr: "found existing data in storage location" }),
    },
    counters,
  );
  const adapter = makeAdapter(runner);
  const res = await adapter.ensureRepository(TARGET);
  assert.deepEqual(res, { created: false });
  assert.equal(counters.connect, 2, "one safe reconnect after a create race");
  assert.equal(counters.create, 1);
});

test("ensureRepository propagates a non-race create failure unchanged", async () => {
  const counters = { connect: 0, create: 0 };
  const runner = subcommandRunner(
    {
      connect: () => ({ code: 1, stderr: "repository not initialized in the provided storage" }),
      create: () => ({ code: 1, stderr: "access denied while creating repository" }),
    },
    counters,
  );
  const adapter = makeAdapter(runner);
  await assert.rejects(() => adapter.ensureRepository(TARGET), KopiaCommandError);
  // Only the initial connect; no reconnect after a hard create failure.
  assert.equal(counters.connect, 1);
});

test("ensureRepository never leaks secrets in a propagated error", async () => {
  const runner = subcommandRunner({
    connect: () => ({ code: 1, stderr: "auth failed for key top-secret-pw / AKIAEXAMPLE" }),
  });
  const adapter = makeAdapter(runner);
  await assert.rejects(
    () => adapter.ensureRepository(TARGET),
    (err: unknown) => {
      assert.ok(err instanceof KopiaCommandError);
      const haystack = err.message + err.result.stderr;
      for (const secret of SECRET_VALUES) {
        assert.ok(!haystack.includes(secret), `secret leaked: ${secret}`);
      }
      return true;
    },
  );
});
