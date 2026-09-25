/**
 * Backup and restore of this device's folder/agent bindings.
 *
 * `workspaces.json` records which local folders each project is installed into,
 * which agents were selected per folder, and which environment variable names the
 * operator approved here. All of that is device-local by nature: the paths are
 * absolute and specific to one machine's layout.
 *
 * So bindings are published to the DEVICE scope, never the shared one. The
 * distinction is the whole point:
 *
 *   - Restoring onto the SAME device (after a reinstall, a wiped data directory,
 *     or a fresh checkout of the app) is a true restore: the paths are this
 *     machine's paths, so MultiZen re-links them and rewrites the agent config
 *     files exactly as they were.
 *   - Restoring from a DIFFERENT device is a suggestion, not an instruction.
 *     `/Users/alice/work` means nothing on a Windows laptop, and silently writing
 *     agent config into whatever happens to exist at that path would be wrong.
 *     Those are returned as proposals for the operator to confirm.
 *
 * What is deliberately NOT restored: per-agent install status, hashes, and
 * `ownedKeys`. Those describe files on disk, and the disk is the authority — a
 * restored `ownedKeys` could claim ownership of entries MultiZen never wrote,
 * which is exactly the way to clobber somebody else's config. Re-installing
 * recomputes them from the real files.
 */

import { existsSync, statSync } from "node:fs";

import type { JsonValue } from "@multizen/mcp-gateway";

import type { GatewayService } from "./GatewayService.ts";
import { AGENT_KINDS, type AgentKind } from "./types.ts";

/** Document name under the device scope. */
export const BINDINGS_DOCUMENT = "workspaces" as const;

/** One folder's portable description: where it is and which agents it feeds. */
export interface BindingBackup {
  readonly projectId: string;
  readonly directory: string;
  readonly agents: readonly AgentKind[];
}

/** The published shape. Status, hashes and ownedKeys are intentionally absent. */
export interface BindingsDocument {
  readonly version: 1;
  readonly bindings: readonly BindingBackup[];
  readonly approvedEnv: readonly string[];
}

/** A binding from another device, offered for the operator to accept or ignore. */
export interface BindingProposal extends BindingBackup {
  /** True when the path exists on this machine right now. */
  readonly directoryExists: boolean;
  /** Device that backed this binding up. */
  readonly fromDeviceId: string;
}

export interface BindingsRestoreOutcome {
  /** Bindings re-linked and reconciled (same-device restore only). */
  readonly restored: readonly BindingBackup[];
  /** Bindings that could not be applied, with the reason. */
  readonly skipped: ReadonlyArray<{ binding: BindingBackup; reason: string }>;
  /** Environment approvals restored. */
  readonly approvedEnv: readonly string[];
  readonly reason?: "not-syncing" | "absent" | "rejected";
  readonly rejection?: string;
}

function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === "string" && (AGENT_KINDS as readonly string[]).includes(v);
}

/**
 * Validate a decoded bindings document. Remote input, so every entry is checked
 * and anything malformed is dropped rather than trusted.
 */
export function parseBindingsDocument(raw: unknown): BindingsDocument {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { version: 1, bindings: [], approvedEnv: [] };
  }
  const r = raw as Record<string, unknown>;
  const bindings: BindingBackup[] = [];
  if (Array.isArray(r.bindings)) {
    for (const entry of r.bindings) {
      if (typeof entry !== "object" || entry === null) continue;
      const b = entry as Record<string, unknown>;
      if (typeof b.projectId !== "string" || b.projectId.length === 0) continue;
      if (typeof b.directory !== "string" || b.directory.length === 0) continue;
      if (!Array.isArray(b.agents)) continue;
      const agents = b.agents.filter(isAgentKind);
      bindings.push({ projectId: b.projectId, directory: b.directory, agents });
    }
  }
  const approvedEnv = Array.isArray(r.approvedEnv)
    ? r.approvedEnv.filter((n): n is string => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    : [];
  return { version: 1, bindings, approvedEnv };
}

export interface BindingsSyncDeps {
  readonly service: GatewayService;
}

export class BindingsSync {
  constructor(private readonly deps: BindingsSyncDeps) {}

  /** Project the live binding store onto the portable backup shape. */
  async snapshot(): Promise<BindingsDocument> {
    const svc = this.deps.service;
    const bindings = svc.allBindingIntents();
    return { version: 1, bindings, approvedEnv: svc.approvedEnvNames() };
  }

  /**
   * Publish this device's bindings. Best-effort: the local store is
   * authoritative, so a bucket problem must never block linking a folder.
   */
  async push(): Promise<boolean> {
    const doc = await this.snapshot();
    const result = await this.deps.service
      .publishDocument("device", BINDINGS_DOCUMENT, doc as unknown as JsonValue)
      .catch(() => null);
    return result?.kind === "published";
  }

  /**
   * Restore THIS device's own backed-up bindings.
   *
   * Each folder is re-linked through the normal install path, so agent config
   * files are rewritten from the current project configs rather than from stale
   * recorded state. A folder that no longer exists is reported and skipped — it
   * is not an error, because a restore onto a machine whose layout has moved on
   * is a perfectly ordinary situation.
   */
  async restoreOwn(options: { expectFresh?: boolean } = {}): Promise<BindingsRestoreOutcome> {
    const read = await this.deps.service.readDocument<unknown>("device", BINDINGS_DOCUMENT, {
      ...(options.expectFresh !== undefined ? { expectFresh: options.expectFresh } : {}),
    });
    if (read === null) {
      return { restored: [], skipped: [], approvedEnv: [], reason: "not-syncing" };
    }
    if (read.kind === "absent") {
      return { restored: [], skipped: [], approvedEnv: [], reason: "absent" };
    }
    if (read.kind === "rejected") {
      return {
        restored: [],
        skipped: [],
        approvedEnv: [],
        reason: "rejected",
        rejection: `${read.rejection.code}: ${read.rejection.reason}`,
      };
    }

    const doc = parseBindingsDocument(read.document.value);
    const restored: BindingBackup[] = [];
    const skipped: Array<{ binding: BindingBackup; reason: string }> = [];

    // Approvals first: a folder's servers may reference names that must resolve
    // before the install is meaningful.
    for (const name of doc.approvedEnv) {
      await this.deps.service.approveEnvName(name).catch(() => undefined);
    }

    for (const binding of doc.bindings) {
      if (binding.agents.length === 0) {
        skipped.push({ binding, reason: "no agents were selected for this folder" });
        continue;
      }
      if (this.deps.service.configOf(binding.projectId) === null) {
        skipped.push({
          binding,
          reason: `project ${binding.projectId} is not on this device`,
        });
        continue;
      }
      if (!directoryUsable(binding.directory)) {
        skipped.push({ binding, reason: "the folder no longer exists on this device" });
        continue;
      }
      try {
        await this.deps.service.setDirectoryAgents(
          binding.projectId,
          binding.directory,
          binding.agents,
        );
        restored.push(binding);
      } catch (err) {
        skipped.push({ binding, reason: (err as Error).message });
      }
    }

    return { restored, skipped, approvedEnv: doc.approvedEnv };
  }

  /**
   * Read another device's bindings as PROPOSALS. Nothing is written.
   *
   * This is what makes a cross-machine restore honest: the operator sees which
   * folders the other device used and whether each path happens to exist here,
   * and decides. Applying them silently would write agent configuration into
   * whatever unrelated directory occupied the same path.
   */
  async proposalsFrom(deviceId: string): Promise<{
    proposals: readonly BindingProposal[];
    reason?: "not-syncing" | "absent" | "rejected";
    rejection?: string;
  }> {
    const read = await this.deps.service.readDocument<unknown>("device", BINDINGS_DOCUMENT, {
      deviceId,
      expectFresh: false,
    });
    if (read === null) return { proposals: [], reason: "not-syncing" };
    if (read.kind === "absent") return { proposals: [], reason: "absent" };
    if (read.kind === "rejected") {
      return {
        proposals: [],
        reason: "rejected",
        rejection: `${read.rejection.code}: ${read.rejection.reason}`,
      };
    }
    const doc = parseBindingsDocument(read.document.value);
    return {
      proposals: doc.bindings.map((b) => ({
        ...b,
        directoryExists: directoryUsable(b.directory),
        fromDeviceId: deviceId,
      })),
    };
  }
}

/** True when the path exists and is a directory we could install into. */
function directoryUsable(directory: string): boolean {
  try {
    return existsSync(directory) && statSync(directory).isDirectory();
  } catch {
    return false;
  }
}
