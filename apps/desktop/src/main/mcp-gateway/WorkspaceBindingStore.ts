/**
 * Device-local store for project↔directory associations and agent install state.
 *
 * This is deliberately SEPARATE from the signed/synced ProjectConfig store. A
 * ProjectConfig is portable: it describes servers, desired enable state, the
 * auth reference, and an optional browser-profile binding — nothing about THIS
 * machine. Absolute filesystem paths, which agents were selected, and what we
 * last wrote where are all machine-specific, so they live here and are never
 * published through project sync.
 *
 * Persistence is a single atomic JSON file (temp + fsync + rename) so a crash
 * mid-write can never leave a torn record. Loading is defensive: a malformed
 * entry is DROPPED rather than aborting startup, because a corrupt local cache
 * must never prevent the gateway from serving its projects. The authoritative
 * project set always comes from the signed config store.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import {
  AGENT_KINDS,
  type AgentInstallStatus,
  type AgentKind,
} from "./types.ts";

/** Per-agent install bookkeeping for one directory. */
export interface AgentState {
  readonly agent: AgentKind;
  /**
   * MultiZen-owned entry names we last wrote into this agent's config file.
   * This is the ownership record: we only ever replace or remove keys listed
   * here, so a same-named entry we did not create is never clobbered.
   */
  ownedKeys: string[];
  /** Hash of the desired configuration at the last successful write. */
  desiredHash: string | null;
  /** Hash of the target file observed immediately after our verified write. */
  fileHash: string | null;
  /** Epoch ms of the last verified successful write. */
  lastInstalledAt: number | null;
  status: AgentInstallStatus;
  /** Redacted failure reason when status is "error". */
  error?: string;
  /** Actionable recovery hint for a known agent precondition. */
  hint?: string;
}

/** One directory associated with one project. */
export interface Binding {
  readonly projectId: string;
  /** Canonical absolute directory path. */
  readonly directory: string;
  agents: AgentState[];
}

interface StateFile {
  version: 1;
  bindings: Binding[];
  /**
   * Environment variable NAMES the operator approved for expansion on THIS
   * device. A referenced name that is not approved is treated as unavailable
   * even when present in the process environment, so a synced config cannot
   * silently read an arbitrary host variable.
   */
  approvedEnv: string[];
}

const EMPTY: StateFile = { version: 1, bindings: [], approvedEnv: [] };

function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === "string" && (AGENT_KINDS as readonly string[]).includes(v);
}

function isStatus(v: unknown): v is AgentInstallStatus {
  return v === "current" || v === "out-of-date" || v === "error";
}

/** Strictly validate one persisted agent record; returns null when malformed. */
function parseAgentState(raw: unknown): AgentState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isAgentKind(r.agent)) return null;
  const ownedKeys = Array.isArray(r.ownedKeys)
    ? r.ownedKeys.filter((k): k is string => typeof k === "string")
    : [];
  const status = isStatus(r.status) ? r.status : "out-of-date";
  return {
    agent: r.agent,
    ownedKeys,
    desiredHash: typeof r.desiredHash === "string" ? r.desiredHash : null,
    fileHash: typeof r.fileHash === "string" ? r.fileHash : null,
    lastInstalledAt:
      typeof r.lastInstalledAt === "number" && Number.isFinite(r.lastInstalledAt)
        ? r.lastInstalledAt
        : null,
    status,
    ...(typeof r.error === "string" ? { error: r.error } : {}),
    ...(typeof r.hint === "string" ? { hint: r.hint } : {}),
  };
}

/** Strictly validate one persisted binding; returns null when malformed. */
function parseBinding(raw: unknown): Binding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== "string" || r.projectId.length === 0) return null;
  // Only absolute paths are meaningful; a relative path would resolve against
  // whatever cwd the app happened to have, which is not a stable identity.
  if (typeof r.directory !== "string" || !path.isAbsolute(r.directory)) return null;
  const agents = Array.isArray(r.agents)
    ? r.agents.map(parseAgentState).filter((a): a is AgentState => a !== null)
    : [];
  // Collapse duplicate agent rows (last wins) so a corrupted file cannot make
  // one agent appear twice for a directory.
  const byAgent = new Map<AgentKind, AgentState>();
  for (const a of agents) byAgent.set(a.agent, a);
  return {
    projectId: r.projectId,
    directory: r.directory,
    agents: [...byAgent.values()],
  };
}

/** A fresh agent row for a newly selected agent (never installed yet). */
export function newAgentState(agent: AgentKind): AgentState {
  return {
    agent,
    ownedKeys: [],
    desiredHash: null,
    fileHash: null,
    lastInstalledAt: null,
    status: "out-of-date",
  };
}

export class WorkspaceBindingStore {
  private state: StateFile = { ...EMPTY, bindings: [], approvedEnv: [] };
  private loaded = false;
  /** Serializes writes so two concurrent mutations cannot interleave. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Load from disk. Idempotent; a missing or corrupt file yields empty state. */
  async load(): Promise<void> {
    try {
      const text = await fs.readFile(this.file, "utf8");
      const raw = JSON.parse(text) as unknown;
      if (typeof raw !== "object" || raw === null) throw new Error("not an object");
      const r = raw as Record<string, unknown>;
      const bindings = Array.isArray(r.bindings)
        ? r.bindings.map(parseBinding).filter((b): b is Binding => b !== null)
        : [];
      // Dedupe on the (projectId, directory) identity: the same canonical path
      // may legitimately be bound by DIFFERENT projects, but one project must
      // never hold two rows for the same directory.
      const seen = new Map<string, Binding>();
      for (const b of bindings) seen.set(this.key(b.projectId, b.directory), b);
      this.state = {
        version: 1,
        bindings: [...seen.values()],
        approvedEnv: Array.isArray(r.approvedEnv)
          ? [...new Set(r.approvedEnv.filter((n): n is string => typeof n === "string"))]
          : [],
      };
    } catch {
      this.state = { version: 1, bindings: [], approvedEnv: [] };
    }
    this.loaded = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("WorkspaceBindingStore.load() was not awaited");
  }

  private key(projectId: string, directory: string): string {
    return `${projectId}\u0000${directory}`;
  }

  /** Atomically persist current state. Serialized against other writes. */
  private async persist(): Promise<void> {
    const run = this.writeChain.then(async () => {
      const body = JSON.stringify(this.state);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
      const handle = await fs.open(tmp, "wx");
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.file);
    });
    // Keep the chain alive even if this write failed, so a later write still runs.
    this.writeChain = run.catch(() => {});
    return run;
  }

  // ── reads ───────────────────────────────────────────────────────────────

  /** Every binding on this device. */
  listAll(): Binding[] {
    this.assertLoaded();
    return this.state.bindings.map(cloneBinding);
  }

  /** Bindings for one project, sorted by directory for stable UI ordering. */
  listForProject(projectId: string): Binding[] {
    this.assertLoaded();
    return this.state.bindings
      .filter((b) => b.projectId === projectId)
      .map(cloneBinding)
      .sort((a, b) => a.directory.localeCompare(b.directory));
  }

  /** One binding, or null. */
  get(projectId: string, directory: string): Binding | null {
    this.assertLoaded();
    const found = this.state.bindings.find(
      (b) => b.projectId === projectId && b.directory === directory,
    );
    return found ? cloneBinding(found) : null;
  }

  // ── mutations ───────────────────────────────────────────────────────────

  /**
   * Associate `directory` with `projectId` and set its selected agents.
   *
   * Existing agent rows are PRESERVED (so ownership records and install history
   * survive a selection change); agents removed from the selection are returned
   * so the caller can uninstall their owned entries before they are forgotten.
   */
  async setAgents(
    projectId: string,
    directory: string,
    agents: readonly AgentKind[],
  ): Promise<{ binding: Binding; removed: AgentState[] }> {
    this.assertLoaded();
    const wanted = [...new Set(agents)];
    const idx = this.state.bindings.findIndex(
      (b) => b.projectId === projectId && b.directory === directory,
    );
    const existing = idx >= 0 ? this.state.bindings[idx] : undefined;
    const prior = existing?.agents ?? [];
    const removed = prior.filter((a) => !wanted.includes(a.agent)).map(cloneAgent);
    const next: Binding = {
      projectId,
      directory,
      agents: wanted.map((a) => {
        const kept = prior.find((p) => p.agent === a);
        return kept ? cloneAgent(kept) : newAgentState(a);
      }),
    };
    if (idx >= 0) this.state.bindings[idx] = next;
    else this.state.bindings.push(next);
    await this.persist();
    return { binding: cloneBinding(next), removed };
  }

  /**
   * Forget one directory binding. Returns the removed record so the caller can
   * first uninstall the owned entries it describes.
   */
  async removeBinding(projectId: string, directory: string): Promise<Binding | null> {
    this.assertLoaded();
    const idx = this.state.bindings.findIndex(
      (b) => b.projectId === projectId && b.directory === directory,
    );
    if (idx < 0) return null;
    const [removed] = this.state.bindings.splice(idx, 1);
    await this.persist();
    return removed ? cloneBinding(removed) : null;
  }

  /** Forget every binding of a project (used after owned entries are removed). */
  async removeProject(projectId: string): Promise<Binding[]> {
    this.assertLoaded();
    const removed = this.state.bindings.filter((b) => b.projectId === projectId);
    if (removed.length === 0) return [];
    this.state.bindings = this.state.bindings.filter((b) => b.projectId !== projectId);
    await this.persist();
    return removed.map(cloneBinding);
  }

  /** Patch one agent's install bookkeeping after an attempted write. */
  async updateAgentState(
    projectId: string,
    directory: string,
    agent: AgentKind,
    patch: Partial<Omit<AgentState, "agent">>,
  ): Promise<void> {
    this.assertLoaded();
    const binding = this.state.bindings.find(
      (b) => b.projectId === projectId && b.directory === directory,
    );
    if (!binding) return;
    const row = binding.agents.find((a) => a.agent === agent);
    if (!row) return;
    if (patch.ownedKeys !== undefined) row.ownedKeys = [...patch.ownedKeys];
    if (patch.desiredHash !== undefined) row.desiredHash = patch.desiredHash;
    if (patch.fileHash !== undefined) row.fileHash = patch.fileHash;
    if (patch.lastInstalledAt !== undefined) row.lastInstalledAt = patch.lastInstalledAt;
    if (patch.status !== undefined) row.status = patch.status;
    // `error`/`hint` are cleared by passing undefined explicitly via the key.
    if ("error" in patch) {
      if (patch.error === undefined) delete row.error;
      else row.error = patch.error;
    }
    if ("hint" in patch) {
      if (patch.hint === undefined) delete row.hint;
      else row.hint = patch.hint;
    }
    await this.persist();
  }

  // ── approved environment names (device-local) ────────────────────────────

  /** Environment variable NAMES approved for expansion on this device. */
  approvedEnv(): string[] {
    this.assertLoaded();
    return [...this.state.approvedEnv].sort();
  }

  isEnvApproved(name: string): boolean {
    this.assertLoaded();
    return this.state.approvedEnv.includes(name);
  }

  async approveEnv(name: string): Promise<void> {
    this.assertLoaded();
    if (this.state.approvedEnv.includes(name)) return;
    this.state.approvedEnv.push(name);
    await this.persist();
  }

  async revokeEnv(name: string): Promise<void> {
    this.assertLoaded();
    const idx = this.state.approvedEnv.indexOf(name);
    if (idx < 0) return;
    this.state.approvedEnv.splice(idx, 1);
    await this.persist();
  }
}

function cloneAgent(a: AgentState): AgentState {
  return {
    agent: a.agent,
    ownedKeys: [...a.ownedKeys],
    desiredHash: a.desiredHash,
    fileHash: a.fileHash,
    lastInstalledAt: a.lastInstalledAt,
    status: a.status,
    ...(a.error !== undefined ? { error: a.error } : {}),
    ...(a.hint !== undefined ? { hint: a.hint } : {}),
  };
}

function cloneBinding(b: Binding): Binding {
  return { projectId: b.projectId, directory: b.directory, agents: b.agents.map(cloneAgent) };
}
