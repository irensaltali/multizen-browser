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
  parseProjectStateKey,
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
