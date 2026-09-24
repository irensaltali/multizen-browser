import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalize, canonicalBytes, CanonicalJsonError } from "./canonicalJson.js";

test("sorts object keys deterministically", () => {
  const a = canonicalize({ b: 1, a: 2, c: { z: 1, a: 2 } });
  const b = canonicalize({ c: { a: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"a":2,"z":1}}');
});

test("omits undefined values", () => {
  assert.equal(canonicalize({ a: 1, b: undefined as never }), '{"a":1}');
});

test("preserves array order", () => {
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
});

test("rejects non-finite numbers", () => {
  assert.throws(() => canonicalize(Number.NaN as never), CanonicalJsonError);
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY as never), CanonicalJsonError);
});

test("rejects circular references", () => {
  const o: Record<string, unknown> = {};
  o["self"] = o;
  assert.throws(() => canonicalize(o as never), CanonicalJsonError);
});

test("rejects bigint/function/symbol", () => {
  assert.throws(() => canonicalize(10n as never), CanonicalJsonError);
  assert.throws(() => canonicalize((() => 0) as never), CanonicalJsonError);
  assert.throws(() => canonicalize(Symbol("x") as never), CanonicalJsonError);
});

test("canonicalBytes matches UTF-8 of canonicalize", () => {
  const value = { greeting: "héllo", n: 1 };
  assert.deepEqual(canonicalBytes(value), new TextEncoder().encode(canonicalize(value)));
});
