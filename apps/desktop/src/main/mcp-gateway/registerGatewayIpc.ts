/**
 * Focused registration of all MCP-gateway IPC handlers.
 *
 * The {@link GatewayController} already returns serializable
 * {@link GatewayOpResult} envelopes (never throwing across IPC) and enforces the
 * redaction invariants (no expanded env/header/token/private-key material). This
 * module maps each controller method to a channel. It can be registered now,
 * before any renderer UI exists.
 *
 * The one-shot token reveal (`gateway:generateToken`) is the ONLY channel that
 * returns a secret, and it returns a freshly generated value exactly once at the
 * operator's explicit request — it is never persisted in a view.
 */

import { ipcMain } from "electron";

import type { GatewayController } from "./GatewayController.ts";
import type {
  AgentKind,
  CreateProjectInput,
  ProjectSetupInput,
  ServerInput,
  UpdateProjectInput,
} from "./types.ts";

/**
 * Host capabilities the gateway IPC needs from the Electron main process. Kept
 * as injected callbacks so the controller and its tests stay Electron-free.
 */
export interface GatewayIpcHost {
  /** Native directory chooser; resolves to an absolute path or null. */
  readonly pickDirectory: () => Promise<string | null>;
  /** Reveal a path in the OS file manager. */
  readonly revealPath: (target: string) => void;
}

export function registerGatewayIpc(
  controller: GatewayController,
  host: GatewayIpcHost,
): void {
  // ── projects ──────────────────────────────────────────────────────────
  ipcMain.handle("gateway:listProjects", () => controller.listProjects());
  ipcMain.handle("gateway:getProject", (_e, id: string) => controller.getProject(id));
  ipcMain.handle("gateway:createProject", (_e, input: CreateProjectInput) =>
    controller.createProject(input),
  );
  ipcMain.handle("gateway:updateProject", (_e, id: string, patch: UpdateProjectInput) =>
    controller.updateProject(id, patch),
  );
  ipcMain.handle("gateway:deleteProject", (_e, id: string) => controller.deleteProject(id));
  ipcMain.handle("gateway:setupProject", (_e, input: ProjectSetupInput) =>
    controller.setupProject(input),
  );
  ipcMain.handle("gateway:bindProfile", (_e, id: string, profileId: string | null) =>
    controller.bindProfile(id, profileId),
  );
  ipcMain.handle("gateway:bindableProfiles", (_e, forProjectId?: string) =>
    controller.bindableProfiles(forProjectId),
  );

  // ── servers ───────────────────────────────────────────────────────────
  ipcMain.handle("gateway:addServer", (_e, id: string, input: ServerInput) =>
    controller.addServer(id, input),
  );
  ipcMain.handle("gateway:updateServer", (_e, id: string, input: ServerInput) =>
    controller.updateServer(id, input),
  );
  ipcMain.handle("gateway:removeServer", (_e, id: string, serverId: string) =>
    controller.removeServer(id, serverId),
  );
  ipcMain.handle(
    "gateway:setServerEnabled",
    (_e, id: string, serverId: string, enabled: boolean) =>
      controller.setServerEnabled(id, serverId, enabled),
  );
  ipcMain.handle("gateway:restartServer", (_e, id: string, serverId: string) =>
    controller.restartServer(id, serverId),
  );
  // A null project id is legitimate: the creation wizard tests a definition
  // before the project it belongs to exists.
  ipcMain.handle(
    "gateway:testServer",
    (_e, id: string | null, input: ServerInput) => controller.testServer(id, input),
  );

  // ── auth ──────────────────────────────────────────────────────────────
  ipcMain.handle("gateway:setAuthEnabled", (_e, id: string, enabled: boolean) =>
    controller.setAuthEnabled(id, enabled),
  );
  ipcMain.handle("gateway:generateToken", (_e, id: string) => controller.generateToken(id));
  ipcMain.handle("gateway:authStatus", (_e, id: string) => controller.authStatus(id));

  // ── `${NAME}` references (names + presence only; saves are write-only) ───
  ipcMain.handle("gateway:secretRefs", (_e, id: string) => controller.secretRefs(id));
  ipcMain.handle("gateway:approveEnvName", (_e, name: string) =>
    controller.approveEnvName(name),
  );
  ipcMain.handle("gateway:revokeEnvName", (_e, name: string) => controller.revokeEnvName(name));
  ipcMain.handle("gateway:saveManagedSecret", (_e, id: string, name: string, value: string) =>
    controller.saveManagedSecret(id, name, value),
  );
  ipcMain.handle("gateway:deleteManagedSecret", (_e, id: string, name: string) =>
    controller.deleteManagedSecret(id, name),
  );

  // ── endpoints / runtime / logs ─────────────────────────────────────────
  ipcMain.handle("gateway:endpoints", (_e, id: string) => controller.endpoints(id));
  ipcMain.handle("gateway:runtime", (_e, id: string) => controller.runtime(id));
  ipcMain.handle("gateway:logs", (_e, id: string, serverId: string) =>
    controller.logs(id, serverId),
  );

  // ── trust ─────────────────────────────────────────────────────────────
  ipcMain.handle("gateway:trustList", () => controller.trustList());
  ipcMain.handle("gateway:approveDevice", (_e, deviceId: string, publicKeyHex: string) =>
    controller.approveDevice(deviceId, publicKeyHex),
  );
  ipcMain.handle("gateway:revokeDevice", (_e, deviceId: string) =>
    controller.revokeDevice(deviceId),
  );

  // ── conflicts / quarantine / sync ────────────────────────────────────────
  ipcMain.handle("gateway:conflicts", () => controller.conflicts());
  ipcMain.handle("gateway:resolveConflicts", (_e, id: string) =>
    controller.resolveConflicts(id),
  );
  ipcMain.handle("gateway:quarantine", () => controller.quarantine());
  ipcMain.handle("gateway:releaseQuarantine", (_e, id: string) =>
    controller.releaseQuarantine(id),
  );
  ipcMain.handle("gateway:syncStatus", () => controller.syncStatus());
  ipcMain.handle("gateway:syncRetry", () => controller.syncRetry());

  // ── local directories + agent configuration ────────────────────────────
  ipcMain.handle("gateway:pickDirectory", () => host.pickDirectory());
  ipcMain.handle("gateway:directories", (_e, id: string) => controller.directories(id));
  ipcMain.handle(
    "gateway:setDirectoryAgents",
    (_e, id: string, directory: string, agents: AgentKind[]) =>
      controller.setDirectoryAgents(id, directory, agents),
  );
  ipcMain.handle("gateway:removeDirectory", (_e, id: string, directory: string) =>
    controller.removeDirectory(id, directory),
  );
  ipcMain.handle("gateway:reconcileDirectories", (_e, id: string) =>
    controller.reconcileDirectories(id),
  );
  ipcMain.handle(
    "gateway:retryDirectoryAgent",
    (_e, id: string, directory: string, agent: AgentKind) =>
      controller.retryDirectoryAgent(id, directory, agent),
  );
  ipcMain.handle("gateway:revealPath", (_e, target: string) => {
    host.revealPath(target);
    return { ok: true as const, value: undefined };
  });
}

/** All gateway IPC channel names (for preload allowlisting / teardown). */
export const GATEWAY_IPC_CHANNELS: readonly string[] = [
  "gateway:listProjects",
  "gateway:getProject",
  "gateway:createProject",
  "gateway:updateProject",
  "gateway:deleteProject",
  "gateway:setupProject",
  "gateway:bindProfile",
  "gateway:bindableProfiles",
  "gateway:addServer",
  "gateway:updateServer",
  "gateway:removeServer",
  "gateway:setServerEnabled",
  "gateway:restartServer",
  "gateway:testServer",
  "gateway:setAuthEnabled",
  "gateway:generateToken",
  "gateway:authStatus",
  "gateway:secretRefs",
  "gateway:approveEnvName",
  "gateway:revokeEnvName",
  "gateway:saveManagedSecret",
  "gateway:deleteManagedSecret",
  "gateway:endpoints",
  "gateway:runtime",
  "gateway:logs",
  "gateway:trustList",
  "gateway:approveDevice",
  "gateway:revokeDevice",
  "gateway:conflicts",
  "gateway:resolveConflicts",
  "gateway:quarantine",
  "gateway:releaseQuarantine",
  "gateway:syncStatus",
  "gateway:syncRetry",
  "gateway:pickDirectory",
  "gateway:directories",
  "gateway:setDirectoryAgents",
  "gateway:removeDirectory",
  "gateway:reconcileDirectories",
  "gateway:retryDirectoryAgent",
  "gateway:revealPath",
];
