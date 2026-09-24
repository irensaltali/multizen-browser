import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertProjectId,
  assertServerId,
  hasNoEnvRef,
  InvalidIdError,
  isEnvName,
  isPureEnvRef,
  isSafeId,
  pureEnvRefName,
  referencedEnvNames,
} from "./ids.js";

test("accepts safe ids", () => {
  for (const id of ["a", "ab", "my-project", "srv_1", "a0", "x".repeat(64)]) {
    assert.ok(isSafeId(id), id);
  }
});

test("rejects unsafe ids", () => {
  for (const id of ["", "-a", "a-", "_a", "a_", "A", "a.b", "a/b", "..", "x".repeat(65), 1 as never]) {
    assert.ok(!isSafeId(id), String(id));
  }
});

test("assert helpers throw on invalid", () => {
  assert.throws(() => assertProjectId("bad/id"), InvalidIdError);
  assert.throws(() => assertServerId(""), InvalidIdError);
  assert.equal(assertProjectId("good"), "good");
});

test("pure env ref detection", () => {
  assert.ok(isPureEnvRef("${TOKEN}"));
  assert.ok(!isPureEnvRef("prefix-${TOKEN}"));
  assert.ok(!isPureEnvRef("${TOKEN}suffix"));
  assert.ok(!isPureEnvRef("literal"));
  assert.equal(pureEnvRefName("${API_KEY}"), "API_KEY");
  assert.equal(pureEnvRefName("nope"), null);
});

test("env name grammar", () => {
  assert.ok(isEnvName("FOO_BAR"));
  assert.ok(isEnvName("_x9"));
  assert.ok(!isEnvName("9x"));
  assert.ok(!isEnvName("has-dash"));
});

test("referenced env names in strings", () => {
  assert.deepEqual(
    referencedEnvNames("https://${HOST}:${PORT}/mcp?t=${HOST}").sort(),
    ["HOST", "PORT"],
  );
  assert.deepEqual(referencedEnvNames("no refs"), []);
});

test("hasNoEnvRef", () => {
  assert.ok(hasNoEnvRef("/tmp/work"));
  assert.ok(!hasNoEnvRef("/tmp/${X}"));
});
