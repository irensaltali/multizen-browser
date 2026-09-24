/**
 * Test-only ESM resolve hook for the desktop MCP-gateway integration tests.
 *
 * The workspace packages publish their `main` as TypeScript source whose
 * internal imports use `.js` specifiers (assuming a bundler in production). For
 * package-local `node:test` we redirect those bare specifiers to the already
 * built `dist/index.js` so compiled tests execute plain JavaScript with
 * resolvable specifiers and no Electron dependency.
 *
 * PREREQUISITE (handled by the `test:gateway` script): the redirected packages
 * must be built to `dist/` first.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// here = apps/desktop/src/main/mcp-gateway/__tests__ → repo root is 6 levels up.
const repoRoot = resolvePath(here, "../../../../../..");

const REDIRECTS = {
  "@multizen/mcp-gateway": resolvePath(repoRoot, "packages/mcp-gateway/dist/index.js"),
  "@multizen/mcp-server": resolvePath(repoRoot, "packages/mcp-server/dist/index.js"),
  "@multizen/profile-manager": resolvePath(repoRoot, "packages/profile-manager/dist/index.js"),
  "@multizen/s3-coordinator": resolvePath(repoRoot, "packages/s3-coordinator/dist/index.js"),
  "@multizen/sync-core": resolvePath(repoRoot, "packages/sync-core/dist/index.js"),
  "@multizen/types": resolvePath(repoRoot, "packages/types/dist/index.js"),
};

export async function resolve(specifier, context, nextResolve) {
  const target = REDIRECTS[specifier];
  if (target) {
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
