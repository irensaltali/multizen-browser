/**
 * Atomic one-file-per-project config store.
 *
 * Each project's desired config is persisted as a single JSON file named by its
 * id: `<dir>/<projectId>.json`. Writes are atomic (temp file + fsync + rename)
 * so a crash mid-write can never leave a torn or partial config. The id grammar
 * (see ids.ts) guarantees the filename is a safe slug with no traversal.
 *
 * The store persists *only* validated ProjectConfig JSON — desired state,
 * including the `enabled`/`disabled` flags. It never writes runtime state or
 * expanded secrets. Reads validate strictly and surface migrations; a file that
 * fails validation is reported as a rejection rather than silently dropped.
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { canonicalize, type JsonValue } from "./canonicalJson.js";
import { assertProjectId, type ProjectId } from "./ids.js";
import {
  parseProjectConfig,
  projectConfigToJson,
  type ProjectConfig,
} from "./projectConfig.js";

export interface StoredProject {
  readonly config: ProjectConfig;
  /** SHA-256 (hex) of the canonical JSON of the persisted config. */
  readonly hash: string;
}

export interface RejectedProject {
  readonly file: string;
  readonly reason: string;
}

export interface LoadResult {
  readonly projects: readonly StoredProject[];
  readonly rejected: readonly RejectedProject[];
}

/** SHA-256 hex of the canonical form of a config's persisted JSON. */
export function configHash(config: ProjectConfig): string {
  const json = projectConfigToJson(config) as JsonValue;
  return createHash("sha256").update(canonicalize(json)).digest("hex");
}

export class ProjectConfigStore {
  constructor(private readonly dir: string) {}

  private fileFor(id: ProjectId): string {
    return path.join(this.dir, `${id}.json`);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** Load and validate all `*.json` files, separating valid from rejected. */
  async loadAll(): Promise<LoadResult> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { projects: [], rejected: [] };
      }
      throw err;
    }
    const projects: StoredProject[] = [];
    const rejected: RejectedProject[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const full = path.join(this.dir, entry);
      try {
        const text = await fs.readFile(full, "utf8");
        const raw = JSON.parse(text) as unknown;
        const config = parseProjectConfig(raw);
        const expected = `${config.id}.json`;
        if (entry !== expected) {
          rejected.push({
            file: entry,
            reason: `Filename does not match project id (expected ${expected})`,
          });
          continue;
        }
        projects.push({ config, hash: configHash(config) });
      } catch (err) {
        rejected.push({ file: entry, reason: (err as Error).message });
      }
    }
    return { projects, rejected };
  }

  async load(id: ProjectId): Promise<StoredProject | null> {
    const file = this.fileFor(assertProjectId(id));
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const config = parseProjectConfig(JSON.parse(text) as unknown);
    return { config, hash: configHash(config) };
  }

  /** Atomically persist a validated config as canonical JSON. */
  async save(config: ProjectConfig): Promise<StoredProject> {
    await this.init();
    // Re-validate defensively so callers cannot persist a malformed object.
    const validated = parseProjectConfig(projectConfigToJson(config));
    const json = projectConfigToJson(validated) as JsonValue;
    const body = `${canonicalize(json)}\n`;
    const file = this.fileFor(validated.id);
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await fs.open(tmp, "wx");
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    return { config: validated, hash: configHash(validated) };
  }

  /** Remove a project's file. Returns true if a file was deleted. */
  async remove(id: ProjectId): Promise<boolean> {
    const file = this.fileFor(assertProjectId(id));
    try {
      await fs.unlink(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}
