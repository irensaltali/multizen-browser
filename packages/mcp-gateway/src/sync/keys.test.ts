import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseStateKey as parseBrowserStateKey,
  profilesPrefix as browserProfilesPrefix,
  stateKey as browserStateKey,
} from "@multizen/s3-coordinator";

import {
  isMcpControlKey,
  mcpProjectsPrefix,
  parsePendingDeviceKey,
  parseProjectStateKey,
  parseProjectTombstoneKey,
  pendingDeviceKey,
  pendingDevicesPrefix,
  projectTombstoneKey,
  projectRevisionKey,
  projectStateKey,
  trustRegistryKey,
} from "./keys.js";

const PREFIX = "repo/root";

test("mcp project head key is well-formed and parses back", () => {
  const key = projectStateKey(PREFIX, "proj-a");
  assert.equal(key, "repo/root/mcp/projects/proj-a/state.json");
  assert.equal(parseProjectStateKey(PREFIX, key), "proj-a");
});

test("revision + trust keys live under the reserved mcp namespace", () => {
  assert.equal(projectRevisionKey(PREFIX, "p", 3), "repo/root/mcp/projects/p/rev/3.json");
  assert.equal(trustRegistryKey(PREFIX), "repo/root/mcp/trust/registry.json");
});

test("parseProjectStateKey strictly rejects non-head keys", () => {
  assert.equal(parseProjectStateKey(PREFIX, projectRevisionKey(PREFIX, "p", 1)), null);
  assert.equal(parseProjectStateKey(PREFIX, trustRegistryKey(PREFIX)), null);
  assert.equal(parseProjectStateKey(PREFIX, "repo/root/mcp/projects/a/b/state.json"), null);
  assert.equal(parseProjectStateKey(PREFIX, "repo/root/mcp/projects//state.json"), null);
  assert.equal(parseProjectStateKey(PREFIX, "repo/root/mcp/projects/BAD_ID!/state.json"), null);
  assert.equal(parseProjectStateKey(PREFIX, "repo/root/profiles/p/state.json"), null);
});

test("invalid project ids throw when building keys", () => {
  assert.throws(() => projectStateKey(PREFIX, "../escape"));
  assert.throws(() => projectStateKey(PREFIX, "UPPER"));
  assert.throws(() => projectRevisionKey(PREFIX, "p", 0));
});

// ── namespace independence: mcp control keys and browser profile keys never
//    collide, and neither parser accepts the other's keys. ─────────────────

test("browser profile parser rejects every mcp control key", () => {
  const mcpKeys = [
    projectStateKey(PREFIX, "proj-a"),
    projectRevisionKey(PREFIX, "proj-a", 2),
    trustRegistryKey(PREFIX),
  ];
  for (const key of mcpKeys) {
    assert.equal(parseBrowserStateKey(PREFIX, key), null, `browser parser must reject ${key}`);
    assert.ok(isMcpControlKey(PREFIX, key), `${key} must be an mcp control key`);
  }
});

test("mcp project parser rejects browser profile state keys", () => {
  const browserKey = browserStateKey(PREFIX, "profile-x");
  assert.equal(parseProjectStateKey(PREFIX, browserKey), null);
  assert.ok(!isMcpControlKey(PREFIX, browserKey));
});

test("mcp and browser prefixes are disjoint subtrees", () => {
  const mcpP = mcpProjectsPrefix(PREFIX);
  const browserP = browserProfilesPrefix(PREFIX);
  assert.ok(!mcpP.startsWith(browserP));
  assert.ok(!browserP.startsWith(mcpP));
  // A browser profile named "mcp" cannot reach into the mcp control subtree.
  const sneaky = browserStateKey(PREFIX, "mcp");
  assert.equal(parseProjectStateKey(PREFIX, sneaky), null);
});


test("pending-device keys round-trip and live inside the mcp control subtree", () => {
  const id = "dev_0123456789abcdef0123456789abcdef";
  const key = pendingDeviceKey(PREFIX, id);
  assert.equal(parsePendingDeviceKey(PREFIX, key), id);
  assert.ok(isMcpControlKey(PREFIX, key));
  // Pending announcements must never be mistaken for a project head, or a device
  // id would be discovered as a project and restored as one.
  assert.equal(parseProjectStateKey(PREFIX, key), null);
  assert.equal(parseBrowserStateKey(PREFIX, key), null);
});

test("the pending-device parser rejects anything not exactly one announcement", () => {
  const prefix = pendingDevicesPrefix(PREFIX);
  for (const key of [
    `${prefix}`,
    `${prefix}.json`,
    `${prefix}dev_a/nested.json`,
    `${prefix}dev_a.txt`,
    `${prefix}dev_a`,
    `${prefix}../registry.json`,
    `${prefix}Dev_Upper.json`,
    trustRegistryKey(PREFIX),
    projectStateKey(PREFIX, "alpha"),
  ]) {
    assert.equal(parsePendingDeviceKey(PREFIX, key), null, `must reject ${key}`);
  }
});

test("an unsafe device id cannot be turned into a key", () => {
  for (const bad of ["", "../escape", "has/slash", "UPPER", "has space"]) {
    assert.throws(() => pendingDeviceKey(PREFIX, bad), /invalid deviceId/);
  }
});

test("tombstone keys sit beside the head so one listing finds both", () => {
  const head = projectStateKey(PREFIX, "proj-a");
  const tomb = projectTombstoneKey(PREFIX, "proj-a");
  assert.equal(parseProjectTombstoneKey(PREFIX, tomb), "proj-a");
  assert.ok(tomb.startsWith(mcpProjectsPrefix(PREFIX)));
  assert.ok(head.startsWith(mcpProjectsPrefix(PREFIX)));
  // Each parser must recognise only its own kind, so a deletion is never read as
  // a config and a config is never obeyed as a deletion.
  assert.equal(parseProjectStateKey(PREFIX, tomb), null);
  assert.equal(parseProjectTombstoneKey(PREFIX, head), null);
  assert.equal(parseBrowserStateKey(PREFIX, tomb), null);
});

test("the tombstone parser rejects near-misses", () => {
  const prefix = mcpProjectsPrefix(PREFIX);
  for (const key of [
    `${prefix}tombstone.json`,
    `${prefix}a/b/tombstone.json`,
    `${prefix}a/tombstone.txt`,
    `${prefix}a/rev/1.json`,
    `${prefix}UPPER/tombstone.json`,
  ]) {
    assert.equal(parseProjectTombstoneKey(PREFIX, key), null, `must reject ${key}`);
  }
  assert.throws(() => projectTombstoneKey(PREFIX, "../escape"), /invalid projectId/);
});
