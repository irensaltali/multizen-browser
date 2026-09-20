import { test } from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";

import { NodeProcessRunner, UnsafeSpawnError, redactString } from "./process-runner.js";

const runner = new NodeProcessRunner();

// Use the current Node executable as a portable, always-present binary so the
// tests do not depend on any shell or external tool.
const NODE = execPath;

test("redactString scrubs all secret occurrences, longest first", () => {
  const out = redactString("key=ABCDEF and short=ABC", ["ABC", "ABCDEF"]);
  assert.equal(out, "key=[REDACTED] and short=[REDACTED]");
});

test("redactString ignores empty secrets", () => {
  assert.equal(redactString("hello", [""]), "hello");
});

test("captures stdout and applies redaction", async () => {
  const result = await runner.run({
    bin: NODE,
    args: ["-e", "process.stdout.write('token=SECRETVAL done')"],
    env: {},
    redact: ["SECRETVAL"],
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "token=[REDACTED] done");
  assert.ok(!result.stdout.includes("SECRETVAL"));
});

test("child env carries only what we pass, plus unavoidable OS vars", async () => {
  const result = await runner.run({
    bin: NODE,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({ mine: process.env.ONLY_ONE, path: process.env.PATH ?? null, leaked: process.env.LEAK ?? null }))",
    ],
    // Deliberately do NOT forward PATH or a fake secret; only ONLY_ONE.
    env: { ONLY_ONE: "1" },
  });
  const seen = JSON.parse(result.stdout) as { mine: string; path: string | null; leaked: string | null };
  // Our variable is present.
  assert.equal(seen.mine, "1");
  // Nothing we did not pass leaks in (PATH and LEAK were never provided).
  assert.equal(seen.path, null);
  assert.equal(seen.leaked, null);
});

test("timeout kills the process and reports timedOut", async () => {
  const result = await runner.run({
    bin: NODE,
    // Sleep well past the timeout.
    args: ["-e", "setTimeout(() => {}, 60000)"],
    env: {},
    timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.signal, null);
});

test("AbortSignal cancels the process", async () => {
  const controller = new AbortController();
  const promise = runner.run({
    bin: NODE,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    env: {},
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result.aborted, true);
});

test("pre-aborted signal short-circuits without spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runner.run({
    bin: NODE,
    args: ["-e", "process.stdout.write('should-not-run')"],
    env: {},
    signal: controller.signal,
  });
  assert.equal(result.aborted, true);
  assert.equal(result.stdout, "");
});

test("rejects an unsafe (empty) bin", () => {
  assert.throws(() => runner.run({ bin: "", args: [], env: {} }), UnsafeSpawnError);
});

test("argument values are passed verbatim, not shell-interpreted", async () => {
  // If a shell were involved, `$(...)`/backticks/`;` would be interpreted.
  const injected = "$(echo pwned); `echo pwned`; value";
  const result = await runner.run({
    bin: NODE,
    args: ["-e", "process.stdout.write(process.argv[1])", injected],
    env: {},
  });
  assert.equal(result.stdout, injected);
});
