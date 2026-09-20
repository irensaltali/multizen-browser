import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ResourceBusyError,
  alwaysQuiescentGuard,
  assertQuiescent,
  type QuiescenceGuard,
} from "./quiescence.js";

test("assertQuiescent resolves when quiescent", async () => {
  await assert.doesNotReject(() => assertQuiescent(alwaysQuiescentGuard, "p1"));
});

test("assertQuiescent throws ResourceBusyError with reason", async () => {
  const guard: QuiescenceGuard = { check: () => ({ quiescent: false, reason: "in use" }) };
  await assert.rejects(
    () => assertQuiescent(guard, "p1"),
    (err: unknown) => {
      assert.ok(err instanceof ResourceBusyError);
      assert.equal(err.resourceId, "p1");
      assert.match(err.message, /in use/);
      return true;
    },
  );
});

test("assertQuiescent supports async guards", async () => {
  const guard: QuiescenceGuard = { check: async () => ({ quiescent: false }) };
  await assert.rejects(() => assertQuiescent(guard, "p2"), ResourceBusyError);
});
