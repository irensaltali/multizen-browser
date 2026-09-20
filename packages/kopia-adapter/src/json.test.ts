import { test } from "node:test";
import assert from "node:assert/strict";

import { KopiaJsonParseError, parseJson, parseJsonArray } from "./json.js";

test("parseJson parses a single object", () => {
  const value = parseJson<{ id: string }>(' {"id":"abc"} ');
  assert.equal(value.id, "abc");
});

test("parseJson throws typed error on empty input", () => {
  assert.throws(() => parseJson(""), KopiaJsonParseError);
});

test("parseJson throws typed error on malformed JSON", () => {
  assert.throws(() => parseJson("{not json"), (err: unknown) => {
    assert.ok(err instanceof KopiaJsonParseError);
    assert.match(err.message, /invalid JSON/);
    return true;
  });
});

test("parseJsonArray handles a JSON array", () => {
  const arr = parseJsonArray<number>("[1, 2, 3]");
  assert.deepEqual(arr, [1, 2, 3]);
});

test("parseJsonArray handles newline-delimited JSON objects", () => {
  const arr = parseJsonArray<{ n: number }>('{"n":1}\n{"n":2}\n');
  assert.deepEqual(arr, [{ n: 1 }, { n: 2 }]);
});

test("parseJsonArray returns empty for empty input", () => {
  assert.deepEqual(parseJsonArray(""), []);
});

test("parseJsonArray rejects a non-array JSON value", () => {
  assert.throws(() => parseJsonArray('{"not":"array"}'), KopiaJsonParseError);
});

test("parseJsonArray rejects malformed NDJSON line", () => {
  assert.throws(() => parseJsonArray('{"ok":1}\n{bad}\n'), KopiaJsonParseError);
});
