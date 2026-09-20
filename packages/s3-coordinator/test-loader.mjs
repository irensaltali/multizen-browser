/**
 * Test-only ESM resolve hook.
 *
 * The workspace package `@multizen/sync-core` publishes its `main` as
 * TypeScript source (`src/index.ts`) whose internal imports use `.js`
 * specifiers — a setup that assumes a build step or a bundler (electron-vite in
 * production). For package-local `node:test` we run the already-built
 * `dist/index.js` of that package instead, so compiled tests execute plain
 * JavaScript with resolvable specifiers.
 *
 * This mirrors the established repo pattern in
 * `apps/desktop/src/main/sync/__tests__/sync-test-loader.mjs`. It only affects
 * the one bare specifier below; everything else resolves normally.
 *
 * PREREQUISITE: `packages/sync-core/dist/index.js` must exist (run
 * `yarn workspace @multizen/sync-core build` if it does not).
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/s3-coordinator → repo root is 2 levels up.
const repoRoot = resolvePath(here, "../..");

const REDIRECTS = {
  "@multizen/sync-core": resolvePath(repoRoot, "packages/sync-core/dist/index.js"),
};

export async function resolve(specifier, context, nextResolve) {
  const target = REDIRECTS[specifier];
  if (target) {
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
