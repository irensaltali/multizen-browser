/**
 * All MCP-gateway IPC handler registrations, with no Electron import.
 *
 * Split from {@link registerGatewayIpc} so the wiring itself is testable: a test
 * registers against a recorder and asserts the channels registered are exactly
 * {@link GATEWAY_IPC_CHANNELS}. That check is what makes the channel list a real
 * allowlist rather than a stale comment — and for the credential channels the
 * security property IS the absence of a reader, which only an exhaustive list can
 * express.
 *
 * The {@link GatewayController} already returns serializable
 * {@link GatewayOpResult} envelopes (never throwing across IPC) and enforces the
 * redaction invariants (no expanded env/header/token/private-key material). This
 * module only maps each controller method to a channel.
 *
 * The one-shot token reveal (`gateway:generateToken`) is the ONLY channel that
 * returns a secret, and it returns a freshly generated value exactly once at the
 * operator's explicit request. The credential-backup channels accept a passphrase
 * but none returns one.
 */

import type { GatewayController } from "./GatewayController.ts";
import type { DeviceSetupInput } from "./DeviceSetup.ts";
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

/** The `ipcMain.handle` shape this module needs, so tests can substitute one. */
export interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: never[]) => unknown): void;
}

export function registerGatewayHandlers(
  ipcMain: IpcRegistrar,
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
  ipcMain.handle("gateway:setServerEnabled", (_e, id: string, serverId: string, enabled: boolean) =>
    controller.setServerEnabled(id, serverId, enabled),
  );
  ipcMain.handle("gateway:restartServer", (_e, id: string, serverId: string) =>
    controller.restartServer(id, serverId),
  );
  // A null project id is legitimate: the creation wizard tests a definition
  // before the project it belongs to exists.
  ipcMain.handle("gateway:testServer", (_e, id: string | null, input: ServerInput) =>
    controller.testServer(id, input),
  );

  // ── auth ──────────────────────────────────────────────────────────────
  ipcMain.handle("gateway:setAuthEnabled", (_e, id: string, enabled: boolean) =>
    controller.setAuthEnabled(id, enabled),
  );
  ipcMain.handle("gateway:generateToken", (_e, id: string) => controller.generateToken(id));
  ipcMain.handle("gateway:authStatus", (_e, id: string) => controller.authStatus(id));

  // ── `${NAME}` references (names + presence only; saves are write-only) ───
  ipcMain.handle("gateway:secretRefs", (_e, id: string) => controller.secretRefs(id));
  ipcMain.handle("gateway:approveEnvName", (_e, name: string) => controller.approveEnvName(name));
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
  ipcMain.handle("gateway:renameDevice", (_e, name: string) => controller.renameDevice(name));

  // ── conflicts / quarantine / sync ────────────────────────────────────────
  ipcMain.handle("gateway:conflicts", () => controller.conflicts());
  ipcMain.handle("gateway:resolveConflicts", (_e, id: string, keep: "mine" | "theirs") =>
    controller.resolveConflicts(id, keep),
  );
  ipcMain.handle("gateway:quarantine", () => controller.quarantine());
  ipcMain.handle("gateway:releaseQuarantine", (_e, id: string) => controller.releaseQuarantine(id));
  ipcMain.handle("gateway:syncStatus", () => controller.syncStatus());
  ipcMain.handle("gateway:syncRetry", () => controller.syncRetry());

  // ── credential backup (opt-in) ─────────────────────────────────────────
  // The passphrase channels are WRITE-ONLY: a passphrase travels renderer → main
  // and there is no channel that returns one. `credentialBackup` reports state
  // only (enabled, counts, the minimum length the main process enforces).
  // ── configuration history ──────────────────────────────────────────────
  ipcMain.handle("gateway:projectHistory", (_e, id: string) => controller.projectHistory(id));
  ipcMain.handle("gateway:restoreProjectRevision", (_e, id: string, revision: number) =>
    controller.restoreProjectRevision(id, revision),
  );

  // Set-up-from-backup. Carries secrets INWARD only; the result is a per-stage
  // report with no secret in it.
  ipcMain.handle("gateway:setupFromBackup", (_e, input: DeviceSetupInput) =>
    controller.setupFromBackup(input),
  );

  ipcMain.handle("gateway:credentialBackup", () => controller.credentialBackup());
  ipcMain.handle("gateway:enableCredentialBackup", (_e, passphrase: string) =>
    controller.enableCredentialBackup(passphrase),
  );
  ipcMain.handle("gateway:disableCredentialBackup", () => controller.disableCredentialBackup());
  ipcMain.handle("gateway:replaceCredentialBackup", () => controller.replaceCredentialBackup());
  ipcMain.handle("gateway:restoreCredentials", (_e, passphrase: string) =>
    controller.restoreCredentials(passphrase),
  );

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
