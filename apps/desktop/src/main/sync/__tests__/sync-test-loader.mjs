/**
 * Test-only ESM resolve hook.
 *
 * The workspace packages `@multizen/sync-core` and `@multizen/kopia-adapter`
 * publish their `main` as TypeScript source (`src/index.ts`) whose internal
 * imports use `.js` specifiers — a setup that assumes a build step or a bundler
 * (electron-vite in production). For package-local `node:test` we run the
 * already-built `dist/index.js` of those packages instead, so tests execute
 * plain JavaScript with resolvable specifiers and zero Electron dependency.
 *
 * This hook only affects these two bare specifiers; everything else resolves
 * normally.
 */
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// here = apps/desktop/src/main/sync/__tests__ → repo root is 6 levels up.
const repoRoot = resolve(here, "../../../../../..");

const REDIRECTS = {
  "@multizen/sync-core": resolve(repoRoot, "packages/sync-core/dist/index.js"),
  "@multizen/kopia-adapter": resolve(repoRoot, "packages/kopia-adapter/dist/index.js"),
};

export async function resolve_(specifier, context, nextResolve) {
  const target = REDIRECTS[specifier];
  if (target) {
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export { resolve_ as resolve };
