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

/** Prefix under which a project's immutable revision archive lives. */
export function projectRevisionsPrefix(controlPrefix: string, projectId: string): string {
  if (!isSafeId(projectId)) {
    throw new Error(`invalid projectId for key: ${JSON.stringify(projectId)}`);
  }
  return `${mcpProjectsPrefix(controlPrefix)}${projectId}/rev/`;
}

/**
 * STRICT parse of a revision key back to its revision number. Returns null for
 * anything that is not EXACTLY `<prefix>/mcp/projects/<projectId>/rev/<n>.json`
 * with `n` a canonical positive integer.
 *
 * Canonical matters: `01.json` and `1.json` would otherwise both parse to 1 and
 * a hostile writer could shadow a real revision with a second object claiming the
 * same number.
 */
export function parseProjectRevisionKey(
  controlPrefix: string,
  projectId: string,
  key: string,
): number | null {
  const prefix = projectRevisionsPrefix(controlPrefix, projectId);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (!rest.endsWith(".json")) return null;
  const digits = rest.slice(0, rest.length - ".json".length);
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  const revision = Number(digits);
  return Number.isSafeInteger(revision) ? revision : null;
}

/** Prefix under which a project's conflict copies live locally-in-store (rare). */
export function trustRegistryKey(controlPrefix: string): string {
  return `${mcpRoot(controlPrefix)}/trust/registry.json`;
}

/**
 * Deletion marker for a project, inside that project's own subtree.
 *
 * Living beside `state.json` means whole-library discovery already lists it, so
 * a deletion is found by the same pass that finds configs — no second scan and
 * no chance of a device seeing the config but missing the deletion.
 */
export function projectTombstoneKey(controlPrefix: string, projectId: string): string {
  if (!isSafeId(projectId)) {
    throw new Error(`invalid projectId for key: ${JSON.stringify(projectId)}`);
  }
  return `${mcpProjectsPrefix(controlPrefix)}${projectId}/tombstone.json`;
}

/**
 * STRICT parse of a tombstone key back to its projectId. Returns null for any
 * key that is not EXACTLY `<prefix>/mcp/projects/<safeId>/tombstone.json`.
 */
export function parseProjectTombstoneKey(controlPrefix: string, key: string): string | null {
  const prefix = mcpProjectsPrefix(controlPrefix);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const suffix = "/tombstone.json";
  if (!rest.endsWith(suffix)) return null;
  const id = rest.slice(0, rest.length - suffix.length);
  if (id.length === 0 || id.includes("/")) return null;
  if (!isSafeId(id)) return null;
  return id;
}

/**
 * Prefix for self-announced *pending* devices awaiting approval.
 *
 * A device that is not yet in the trust registry cannot publish configs, and an
 * admin has no other way to learn its id and public key — the registry only
 * lists devices that are ALREADY entries. So an unapproved device writes a
 * self-signed announcement here, which is the discovery surface the approval UI
 * reads. These records carry public keys and a display name only: no secret, and
 * nothing that grants any authority by existing. Approving one is what grants
 * authority, and that still requires an already-trusted admin.
 */
export function pendingDevicesPrefix(controlPrefix: string): string {
  return `${mcpRoot(controlPrefix)}/trust/pending/`;
}

/** Key for one device's self-announcement. */
export function pendingDeviceKey(controlPrefix: string, deviceId: string): string {
  if (!isSafeId(deviceId)) {
    throw new Error(`invalid deviceId for key: ${JSON.stringify(deviceId)}`);
  }
  return `${pendingDevicesPrefix(controlPrefix)}${deviceId}.json`;
}

/**
 * STRICT parse of a pending-device key back to its deviceId. Returns null for
 * anything that is not EXACTLY `<prefix>/mcp/trust/pending/<safeId>.json`.
 */
export function parsePendingDeviceKey(controlPrefix: string, key: string): string | null {
  const prefix = pendingDevicesPrefix(controlPrefix);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (!rest.endsWith(".json")) return null;
  const id = rest.slice(0, rest.length - ".json".length);
  if (id.length === 0 || id.includes("/")) return null;
  if (!isSafeId(id)) return null;
  return id;
}

/**
 * Where a synced document lives.
 *
 * `shared` documents are one-per-repository (app preferences every device should
 * agree on). `device` documents are one-per-device (this machine's folder
 * layout), so they are backed up and restorable onto the same machine without
 * being pushed onto a different one as if they were universal.
 */
export type DocumentScope = "shared" | "device";

/** Prefix for repository-wide documents. */
export function sharedDocumentsPrefix(controlPrefix: string): string {
  return `${mcpRoot(controlPrefix)}/shared/`;
}

/** Prefix for one device's documents. */
export function deviceDocumentsPrefix(controlPrefix: string, deviceId: string): string {
  if (!isSafeId(deviceId)) {
    throw new Error(`invalid deviceId for key: ${JSON.stringify(deviceId)}`);
  }
  return `${mcpRoot(controlPrefix)}/devices/${deviceId}/`;
}

/**
 * Key for one synced document.
 *
 * Deliberately inside the reserved `mcp/` subtree rather than directly under the
 * control prefix: that keeps every guarantee already established for this
 * namespace — the browser coordinator's `parseStateKey` cannot see these keys, so
 * profile listing, tombstoning, and deletion can never touch them.
 */
export function documentKey(
  controlPrefix: string,
  scope: DocumentScope,
  name: string,
  deviceId?: string,
): string {
  if (!isSafeId(name)) {
    throw new Error(`invalid document name for key: ${JSON.stringify(name)}`);
  }
  if (scope === "shared") return `${sharedDocumentsPrefix(controlPrefix)}${name}.json`;
  if (deviceId === undefined) {
    throw new Error("a device-scoped document requires a deviceId");
  }
  return `${deviceDocumentsPrefix(controlPrefix, deviceId)}${name}.json`;
}

/** Parsed identity of a document key. */
export interface ParsedDocumentKey {
  readonly scope: DocumentScope;
  readonly name: string;
  /** Present only for device-scoped documents. */
  readonly deviceId?: string;
}

/**
 * STRICT parse of a document key. Returns null for anything that is not exactly
 * `<prefix>/mcp/shared/<name>.json` or `<prefix>/mcp/devices/<id>/<name>.json`.
 */
export function parseDocumentKey(
  controlPrefix: string,
  key: string,
): ParsedDocumentKey | null {
  const shared = sharedDocumentsPrefix(controlPrefix);
  if (key.startsWith(shared)) {
    const rest = key.slice(shared.length);
    if (!rest.endsWith(".json")) return null;
    const name = rest.slice(0, rest.length - ".json".length);
    if (name.length === 0 || name.includes("/") || !isSafeId(name)) return null;
    return { scope: "shared", name };
  }
  const devicesRoot = `${mcpRoot(controlPrefix)}/devices/`;
  if (!key.startsWith(devicesRoot)) return null;
  const rest = key.slice(devicesRoot.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const deviceId = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (!isSafeId(deviceId)) return null;
  if (!tail.endsWith(".json")) return null;
  const name = tail.slice(0, tail.length - ".json".length);
  if (name.length === 0 || name.includes("/") || !isSafeId(name)) return null;
  return { scope: "device", name, deviceId };
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
