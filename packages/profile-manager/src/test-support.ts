/**
 * Shared test support.
 *
 * Drains native finalizers *during* the run (while the V8 environment is still
 * fully alive) by forcing a GC after every test. This prevents better-sqlite3's
 * `Database` destructor from firing during process shutdown, where it hits
 * Node 24's `(env) != nullptr` assertion and aborts (SIGABRT). Requires the
 * process to be started with `--expose-gc`; if it is not exposed the hook is a
 * no-op and the runner falls back to its exit-time GC (see run-tests.ts).
 */
import { afterEach } from "node:test";

const gc = (globalThis as { gc?: () => void }).gc;

afterEach(() => {
  if (gc) {
    // Two passes: first collects unreachable Database wrappers, second runs any
    // finalizers scheduled by the first pass.
    gc();
    gc();
  }
});
