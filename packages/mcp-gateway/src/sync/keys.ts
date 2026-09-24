/**
 * Object-key layout for the reserved MCP *control* namespace.
 *
 * The browser-profile sync (`@multizen/s3-coordinator`) owns keys under
 * `<controlPrefix>/profiles/`, `<controlPrefix>/revisions/`, and
 * `<controlPrefix>/capabilities/`. MCP project configs are a DIFFERENT logical
 * asset and MUST NOT collide with, be discovered by, or be deletable through the
 * browser-profile list/tombstone/delete flows. We therefore place them under a
 * dedicated, reserved control subtree:
 *
 *   <controlPrefix>/mcp/projects/<projectId>/state.json      ← project head (CAS)
 *   <controlPrefix>/mcp/projects/<projectId>/rev/<n>.json    ← immutable revision
 *   <controlPrefix>/mcp/trust/registry.json                  ← signed trust registry
 *
 * The `mcp/` segment is the "reserved non-browser control namespace". The
 * browser coordinator's `parseStateKey` only matches `<prefix>/profiles/<id>/
 * state.json` and returns null for anything else, so these `mcp/` keys are
 * invisible to whole-library browser discovery and cannot be tombstoned or
 * deleted by profile operations. Conversely, the parsers here reject any key
 * that is not EXACTLY a well-formed mcp control key.
 *
 * Project ids reuse the gateway id grammar (see ids.ts): 1–64 chars of
 * `[a-z0-9_-]`, no separators, no traversal — safe to embed in a key segment.
 */

import { isSafeId } from "../ids.js";

/** The reserved control-namespace segment for MCP project configs. */
export const MCP_NAMESPACE = "mcp" as const;

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Root prefix for all MCP control keys under a repository. */
export function mcpRoot(controlPrefix: string): string {
  return `${normalizePrefix(controlPrefix)}/${MCP_NAMESPACE}`;
}

/** Prefix under which per-project subtrees live (used for discovery listing). */
export function mcpProjectsPrefix(controlPrefix: string): string {
  return `${mcpRoot(controlPrefix)}/projects/`;
}

/** Head (CAS) key for a project's current signed envelope + config. */
export function projectStateKey(controlPrefix: string, projectId: string): string {
  if (!isSafeId(projectId)) {
    throw new Error(`invalid projectId for key: ${JSON.stringify(projectId)}`);
  }
  return `${mcpProjectsPrefix(controlPrefix)}${projectId}/state.json`;
}

/** Immutable per-revision (history) key for a project. */
export function projectRevisionKey(
  controlPrefix: string,
  projectId: string,
  revision: number,
): string {
  if (!isSafeId(projectId)) {
    throw new Error(`invalid projectId for key: ${JSON.stringify(projectId)}`);
  }
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error(`revision must be a positive integer, got ${revision}`);
  }
  return `${mcpProjectsPrefix(controlPrefix)}${projectId}/rev/${revision}.json`;
}

/** Prefix under which a project's conflict copies live locally-in-store (rare). */
export function trustRegistryKey(controlPrefix: string): string {
  return `${mcpRoot(controlPrefix)}/trust/registry.json`;
}

/**
 * STRICT parse of a project head key back to its projectId. Returns null for
 * ANY key that is not EXACTLY `<prefix>/mcp/projects/<safeId>/state.json`:
 * revision keys, the trust registry, nested/extra segments, or unsafe ids.
 *
 * This is the whole-library discovery filter for MCP projects — the exact
 * analogue of the browser coordinator's `parseStateKey`, but scoped to the
 * reserved `mcp/` namespace so the two never cross.
 */
export function parseProjectStateKey(controlPrefix: string, key: string): string | null {
  const prefix = mcpProjectsPrefix(controlPrefix);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const suffix = "/state.json";
  if (!rest.endsWith(suffix)) return null;
  const id = rest.slice(0, rest.length - suffix.length);
  if (id.length === 0) return null;
  if (id.includes("/")) return null; // no nested subpaths
  if (!isSafeId(id)) return null;
  return id;
}

/**
 * True when `key` lives inside the reserved MCP control namespace. The browser
 * profile flows use the negation of this to assert independence: no MCP key is
 * ever a browser-profile state key and vice versa.
 */
export function isMcpControlKey(controlPrefix: string, key: string): boolean {
  return key.startsWith(`${mcpRoot(controlPrefix)}/`);
}
