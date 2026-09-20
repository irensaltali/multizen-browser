/**
 * Test bootstrap for @multizen/profile-manager.
 *
 * Why this exists: better-sqlite3's native `Database` finalizer calls
 * `RemoveEnvironmentCleanupHook` during V8 garbage collection. On Node 24 that
 * hook can fire once the environment has begun teardown, hitting an internal
 * `(env) != nullptr` assertion and aborting the process (SIGABRT) — even when
 * every Database has been explicitly `.close()`d.
 *
 * `node --test <glob>` spawns each test file in a *child* process, so the abort
 * happens in a child we cannot intercept. Instead we drive the built-in runner
 * programmatically with `isolation: "none"`, which executes every test file
 * **in this same process** (no spawning). Combined with the per-test GC drain
 * in test-support.ts (run with `--expose-gc`), pending native finalizers are
 * flushed *while the environment is alive*, and we hard-`process.exit()` on
 * completion before the shutdown GC pass. Zero extra dependencies.
 */
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => join(here, f));

let failures = 0;

const stream = run({ files, isolation: "none", concurrency: false });
stream.on("test:fail", () => {
  failures += 1;
});
stream.on("end", () => {
  // Drain finalizers while the env is still alive (requires --expose-gc), then
  // hard-exit before the shutdown GC pass can abort the process.
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) {
    gc();
    gc();
  }
  process.exit(failures > 0 ? 1 : 0);
});
// Pretty-print progress without consuming the events we count above.
stream.compose(spec).pipe(process.stdout);
