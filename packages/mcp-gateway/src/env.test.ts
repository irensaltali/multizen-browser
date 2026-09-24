import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBaseEnv, DEFAULT_BASE_ENV_ALLOW, EnvResolutionError, EnvResolver } from "./env.js";

function resolver(base: Record<string, string | undefined>, allow: string[]) {
  return new EnvResolver({ base, allow });
}

test("resolves a pure reference", () => {
  const r = resolver({ TOKEN: "s3cr3t" }, ["TOKEN"]);
  assert.equal(r.resolvePure("${TOKEN}"), "s3cr3t");
});

test("rejects non-allowlisted variable", () => {
  const r = resolver({ SECRET: "x" }, ["OTHER"]);
  assert.throws(() => r.resolvePure("${SECRET}"), EnvResolutionError);
});

test("rejects unresolved (missing) variable", () => {
  const r = resolver({}, ["TOKEN"]);
  assert.throws(() => r.resolvePure("${TOKEN}"), EnvResolutionError);
});

test("rejects non-pure reference in resolvePure", () => {
  const r = resolver({ T: "x" }, ["T"]);
  assert.throws(() => r.resolvePure("prefix-${T}"), EnvResolutionError);
});

test("resolves template with multiple refs", () => {
  const r = resolver({ HOST: "h", PORT: "8443" }, ["HOST", "PORT"]);
  assert.equal(r.resolveTemplate("https://${HOST}:${PORT}/mcp"), "https://h:8443/mcp");
});

test("resolves a map of refs", () => {
  const r = resolver({ A: "1", B: "2" }, ["A", "B"]);
  assert.deepEqual(r.resolveMap({ x: "${A}", y: "${B}" }), { x: "1", y: "2" });
});

test("buildBaseEnv copies only allowlisted names", () => {
  const base = buildBaseEnv({ PATH: "/bin", SECRET: "no", HOME: "/h" });
  assert.deepEqual(base, { PATH: "/bin", HOME: "/h" });
  assert.ok(DEFAULT_BASE_ENV_ALLOW.includes("PATH"));
});
