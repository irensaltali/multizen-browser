import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_TAG_KEYS,
  TagValidationError,
  SnapshotIdValidationError,
  buildConnectArgs,
  buildCreateArgs,
  buildMaintenanceRunArgs,
  buildSnapshotCreateArgs,
  buildSnapshotDeleteArgs,
  buildSnapshotListArgs,
  buildSnapshotRestoreArgs,
  validateSnapshotId,
  validateTags,
  type GlobalKopiaOptions,
  type SnapshotTags,
} from "./commands.js";

const GLOBAL: GlobalKopiaOptions = { configFile: "/cfg/repository.config" };

// The deterministic global prefix emitted before EVERY subcommand.
const GLOBAL_PREFIX = [
  "--config-file",
  "/cfg/repository.config",
  "--no-persist-credentials",
];

// Secret values that must never show up in any argv.
const SECRETS = [
  "super-secret-password",
  "AKIAEXAMPLEKEYID",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "session-token-value",
];

function assertNoSecrets(args: readonly string[]): void {
  const joined = args.join("\u0000");
  for (const secret of SECRETS) {
    assert.ok(!joined.includes(secret), `argv must not contain secret ${secret}`);
  }
  // Also assert the secret-bearing flags are never emitted.
  for (const flag of [
    "--password",
    "-p",
    "--access-key",
    "--secret-access-key",
    "--session-token",
  ]) {
    assert.ok(!args.includes(flag), `argv must not contain flag ${flag}`);
  }
}

// ---------------------------------------------------------------------------
// Credential-persistence hardening: every builder must emit the negated flags.
// ---------------------------------------------------------------------------

test("global argv always hardens credential persistence", () => {
  const builders: Array<readonly string[]> = [
    buildConnectArgs(GLOBAL, { kind: "filesystem", path: "/repo" }),
    buildCreateArgs(GLOBAL, { kind: "filesystem", path: "/repo" }),
    buildSnapshotCreateArgs(GLOBAL, { source: "/data" }),
    buildSnapshotListArgs(GLOBAL),
    buildSnapshotRestoreArgs(GLOBAL, { id: "s1", target: "/t" }),
    buildSnapshotDeleteArgs(GLOBAL, { ids: ["0fd9a53ff5c74d04b5739ff1a8106b8a"] }),
    buildMaintenanceRunArgs(GLOBAL),
  ];
  for (const args of builders) {
    assert.deepEqual(args.slice(0, GLOBAL_PREFIX.length), GLOBAL_PREFIX);
    assert.ok(args.includes("--no-persist-credentials"));
    // The affirmative variant must never appear.
    assert.ok(!args.includes("--persist-credentials"));
  }
});

test("filesystem connect: correct flags, no secrets on argv", () => {
  const args = buildConnectArgs(GLOBAL, { kind: "filesystem", path: "/repo" });
  assert.deepEqual(args, [
    ...GLOBAL_PREFIX,
    "repository",
    "connect",
    "filesystem",
    "--path",
    "/repo",
  ]);
  assertNoSecrets(args);
});

test("s3 connect: emits only documented flags, no secrets on argv", () => {
  const args = buildConnectArgs(GLOBAL, {
    kind: "s3",
    bucket: "my-bucket",
    endpoint: "account.r2.cloudflarestorage.com",
    region: "auto",
    prefix: "profiles/",
  });
  assert.deepEqual(args, [
    ...GLOBAL_PREFIX,
    "repository",
    "connect",
    "s3",
    "--bucket",
    "my-bucket",
    "--endpoint",
    "account.r2.cloudflarestorage.com",
    "--region",
    "auto",
    "--prefix",
    "profiles/",
  ]);
  assertNoSecrets(args);
});

test("s3 connect: optional flags omitted when undefined", () => {
  const args = buildConnectArgs(GLOBAL, { kind: "s3", bucket: "b" });
  assert.deepEqual(args, [
    ...GLOBAL_PREFIX,
    "repository",
    "connect",
    "s3",
    "--bucket",
    "b",
  ]);
  assertNoSecrets(args);
});

test("repository create mirrors connect flag surface", () => {
  const fs = buildCreateArgs(GLOBAL, { kind: "filesystem", path: "/repo" });
  assert.deepEqual(fs.slice(GLOBAL_PREFIX.length), [
    "repository",
    "create",
    "filesystem",
    "--path",
    "/repo",
  ]);
  const s3 = buildCreateArgs(GLOBAL, { kind: "s3", bucket: "b", region: "us-east-1" });
  assert.deepEqual(s3.slice(GLOBAL_PREFIX.length), [
    "repository",
    "create",
    "s3",
    "--bucket",
    "b",
    "--region",
    "us-east-1",
  ]);
  assertNoSecrets(fs);
  assertNoSecrets(s3);
});

test("snapshot create: json by default, source positional", () => {
  const args = buildSnapshotCreateArgs(GLOBAL, { source: "/data/profile" });
  assert.deepEqual(args, [...GLOBAL_PREFIX, "snapshot", "create", "/data/profile", "--json"]);
  const noJson = buildSnapshotCreateArgs(GLOBAL, { source: "/data/profile", json: false });
  assert.ok(!noJson.includes("--json"));
});

test("snapshot list: json default, optional source + all", () => {
  const bare = buildSnapshotListArgs(GLOBAL);
  assert.deepEqual(bare, [...GLOBAL_PREFIX, "snapshot", "list", "--json"]);

  const full = buildSnapshotListArgs(GLOBAL, { source: "/data", all: true });
  assert.deepEqual(full, [...GLOBAL_PREFIX, "snapshot", "list", "/data", "--all", "--json"]);
});

test("snapshot restore: id and target positional", () => {
  const args = buildSnapshotRestoreArgs(GLOBAL, { id: "k1a2b3", target: "/restore/here" });
  assert.deepEqual(args, [...GLOBAL_PREFIX, "snapshot", "restore", "k1a2b3", "/restore/here"]);
});

// ---------------------------------------------------------------------------
// Tag behavior on snapshot create.
// ---------------------------------------------------------------------------

test("snapshot create: emits validated tags in a fixed key order", () => {
  const args = buildSnapshotCreateArgs(GLOBAL, {
    source: "/data/profile",
    // Supplied out of order — output must still follow ALLOWED_TAG_KEYS order.
    tags: {
      operationId: "op-42",
      profileId: "profile_1",
      deviceId: "device-A",
      baseRevision: "17",
    },
  });
  assert.deepEqual(args, [
    ...GLOBAL_PREFIX,
    "snapshot",
    "create",
    "/data/profile",
    "--json",
    "--tags",
    "profileId:profile_1",
    "--tags",
    "deviceId:device-A",
    "--tags",
    "baseRevision:17",
    "--tags",
    "operationId:op-42",
  ]);
});

test("snapshot create: partial tags only emit provided keys", () => {
  const args = buildSnapshotCreateArgs(GLOBAL, {
    source: "/data",
    tags: { profileId: "p1", baseRevision: "3" },
  });
  assert.deepEqual(args.slice(GLOBAL_PREFIX.length), [
    "snapshot",
    "create",
    "/data",
    "--json",
    "--tags",
    "profileId:p1",
    "--tags",
    "baseRevision:3",
  ]);
});

test("snapshot create: empty tags object emits no --tags", () => {
  const args = buildSnapshotCreateArgs(GLOBAL, { source: "/data", tags: {} });
  assert.ok(!args.includes("--tags"));
});

test("snapshot list: supports validated tag filters", () => {
  const args = buildSnapshotListArgs(GLOBAL, {
    source: "/data",
    tags: { profileId: "p1", operationId: "op-9" },
  });
  assert.deepEqual(args, [
    ...GLOBAL_PREFIX,
    "snapshot",
    "list",
    "/data",
    "--json",
    "--tags",
    "profileId:p1",
    "--tags",
    "operationId:op-9",
  ]);
});

// ---------------------------------------------------------------------------
// Tag validation: invalid tags rejected, no secret / control-char leakage.
// ---------------------------------------------------------------------------

test("validateTags: allowed keys are exactly the documented set", () => {
  assert.deepEqual([...ALLOWED_TAG_KEYS], [
    "profileId",
    "deviceId",
    "baseRevision",
    "operationId",
  ]);
});

test("validateTags: rejects unknown keys", () => {
  assert.throws(
    () => validateTags({ password: "hunter2" } as unknown as SnapshotTags),
    TagValidationError,
  );
});

test("validateTags: rejects control characters", () => {
  for (const bad of ["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u001bb", "line1\nline2"]) {
    assert.throws(
      () => validateTags({ profileId: bad }),
      TagValidationError,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test("validateTags: rejects whitespace and the ':' separator", () => {
  for (const bad of ["has space", "key:value", "a b", "\t"]) {
    assert.throws(() => validateTags({ deviceId: bad }), TagValidationError);
  }
});

test("validateTags: rejects empty and overlong values", () => {
  assert.throws(() => validateTags({ profileId: "" }), TagValidationError);
  assert.throws(() => validateTags({ profileId: "x".repeat(201) }), TagValidationError);
});

test("validateTags: rejects non-string values", () => {
  assert.throws(
    () => validateTags({ baseRevision: 17 as unknown as string }),
    TagValidationError,
  );
});

test("validateTags: secret-looking blobs with special chars are rejected", () => {
  // A typical AWS secret key contains '/' and '+' which are not in the allow-list.
  assert.throws(
    () => validateTags({ operationId: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }),
    TagValidationError,
  );
});

test("snapshot create: invalid tag rejection prevents any leakage onto argv", () => {
  assert.throws(
    () =>
      buildSnapshotCreateArgs(GLOBAL, {
        source: "/data",
        tags: { profileId: "ok", operationId: "bad\nvalue" },
      }),
    TagValidationError,
  );
});

// ---------------------------------------------------------------------------
// Snapshot delete: exact argv, confirmation flag, no dangerous flags, no shell.
// ---------------------------------------------------------------------------

test("snapshot delete: single id emits ids then --delete confirm flag", () => {
  const id = "0fd9a53ff5c74d04b5739ff1a8106b8a";
  const args = buildSnapshotDeleteArgs(GLOBAL, { ids: [id] });
  assert.deepEqual(args, [...GLOBAL_PREFIX, "snapshot", "delete", id, "--delete"]);
  // Never the whole-source deletion flag.
  assert.ok(!args.includes("--all-snapshots-for-source"));
  assertNoSecrets(args);
});

test("snapshot delete: multiple ids all precede the single --delete", () => {
  const ids = [
    "0fd9a53ff5c74d04b5739ff1a8106b8a",
    "1122334455667788990011223344aabb",
    "keb76a6e0f54063c6defd4f4b53994b3f",
  ];
  const args = buildSnapshotDeleteArgs(GLOBAL, { ids });
  assert.deepEqual(args, [...GLOBAL_PREFIX, "snapshot", "delete", ...ids, "--delete"]);
  // Exactly one confirmation flag, positioned last.
  assert.equal(args.filter((a) => a === "--delete").length, 1);
  assert.equal(args.at(-1), "--delete");
});

test("snapshot delete: empty id list is rejected (never an unbounded delete)", () => {
  assert.throws(() => buildSnapshotDeleteArgs(GLOBAL, { ids: [] }), SnapshotIdValidationError);
});

test("snapshot delete: flag-like / malformed ids are rejected before argv", () => {
  for (const bad of [
    "--all-snapshots-for-source",
    "-p",
    "--delete",
    "id with space",
    "a/b",
    "a:b",
    "bad\nvalue",
    "",
    "xyz", // too short
    "g".repeat(200), // overlong + non-hex
  ]) {
    assert.throws(
      () => buildSnapshotDeleteArgs(GLOBAL, { ids: [bad] }),
      SnapshotIdValidationError,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test("snapshot delete: one malformed id in a batch rejects the whole build", () => {
  assert.throws(
    () =>
      buildSnapshotDeleteArgs(GLOBAL, {
        ids: ["0fd9a53ff5c74d04b5739ff1a8106b8a", "--delete"],
      }),
    SnapshotIdValidationError,
  );
});

test("validateSnapshotId: accepts hex manifest ids and leading-letter object ids", () => {
  assert.equal(
    validateSnapshotId("0fd9a53ff5c74d04b5739ff1a8106b8a"),
    "0fd9a53ff5c74d04b5739ff1a8106b8a",
  );
  assert.equal(
    validateSnapshotId("keb76a6e0f54063c6defd4f4b53994b3f"),
    "keb76a6e0f54063c6defd4f4b53994b3f",
  );
});

test("validateSnapshotId: rejects non-string, control chars, separators", () => {
  for (const bad of [123 as unknown, null, undefined, "a b", "a\nb", "a/b", "a:b", "-abc123"]) {
    assert.throws(() => validateSnapshotId(bad), SnapshotIdValidationError);
  }
});

// ---------------------------------------------------------------------------
// Maintenance run: verified pinned syntax, opt-in flags only.
// ---------------------------------------------------------------------------

test("maintenance run: bare form is just `maintenance run`", () => {
  const args = buildMaintenanceRunArgs(GLOBAL);
  assert.deepEqual(args, [...GLOBAL_PREFIX, "maintenance", "run"]);
  assertNoSecrets(args);
});

test("maintenance run: --full and --safety=<level> emitted when requested", () => {
  const args = buildMaintenanceRunArgs(GLOBAL, { full: true, safety: "full" });
  assert.deepEqual(args, [...GLOBAL_PREFIX, "maintenance", "run", "--full", "--safety=full"]);
});

test("maintenance run: rejects a malformed safety token", () => {
  assert.throws(
    () => buildMaintenanceRunArgs(GLOBAL, { safety: "full; rm -rf /" }),
    SnapshotIdValidationError,
  );
});
