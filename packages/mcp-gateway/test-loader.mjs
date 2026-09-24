/**
 * Test-only ESM resolve hook.
 *
 * The workspace package `@multizen/s3-coordinator` publishes its `main` as
 * TypeScript source (`src/index.ts`) whose internal imports use `.js`
 * specifiers — a setup that assumes a build step or a bundler in production.
 * The gateway's sync tests use `@multizen/s3-coordinator`'s
 * `InMemoryConditionalObjectStore` and key helpers to prove structural
 * compatibility with the real store. For package-local `node:test` we redirect
 * that bare specifier to the already-built `dist/index.js` so compiled tests
 * execute plain JavaScript with resolvable specifiers.
 *
 * This mirrors the established repo pattern in
 * `packages/s3-coordinator/test-loader.mjs`. It only affects the one bare
 * specifier below; everything else resolves normally.
 *
 * PREREQUISITE: `packages/s3-coordinator/dist/index.js` (and its
 * `packages/sync-core/dist/index.js` dependency) must exist. The `test` script
 * builds them first.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/mcp-gateway → repo root is 2 levels up.
const repoRoot = resolvePath(here, "../..");

const REDIRECTS = {
  "@multizen/s3-coordinator": resolvePath(repoRoot, "packages/s3-coordinator/dist/index.js"),
  "@multizen/sync-core": resolvePath(repoRoot, "packages/sync-core/dist/index.js"),
};

export async function resolve(specifier, context, nextResolve) {
  const target = REDIRECTS[specifier];
  if (target) {
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
