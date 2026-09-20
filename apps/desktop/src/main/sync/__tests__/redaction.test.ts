import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactError } from "../redaction.ts";

test("redact scrubs known secret values, longest first", () => {
  const out = redact("token=SUPERSECRET and key=SUPER", ["SUPER", "SUPERSECRET"]);
  assert.equal(out, "token=[REDACTED] and key=[REDACTED]");
});

test("redact ignores short/empty secrets to avoid nuking the message", () => {
  const out = redact("all good here", ["", "ab", null, undefined]);
  assert.equal(out, "all good here");
});

test("redact handles repeated occurrences", () => {
  const out = redact("aaa-SECRETKEY-bbb-SECRETKEY", ["SECRETKEY"]);
  assert.equal(out, "aaa-[REDACTED]-bbb-[REDACTED]");
});

test("redactError normalizes Error and scrubs secrets", () => {
  const msg = redactError(new Error("failed with pw=HUNTER2LONG"), ["HUNTER2LONG"]);
  assert.equal(msg, "failed with pw=[REDACTED]");
});

test("redactError handles non-Error throwns", () => {
  assert.equal(redactError("plain string", []), "plain string");
});
