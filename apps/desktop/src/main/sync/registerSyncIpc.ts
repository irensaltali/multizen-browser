/**
 * Focused registration of all sync-related IPC handlers.
 *
 * Every handler returns a serializable {@link SyncOpResult} envelope (never
 * throws across IPC) so the renderer can branch on `ok`. Errors are converted
 * to redacted {@link SyncErrorView}s. Secret values are ONLY ever accepted as
 * inputs (save) and never read back.
 */

import { ipcMain } from "electron";
import { isSyncError, SyncErrorCode } from "@multizen/sync-core";
import type { SyncController } from "./SyncController.ts";
import type {
  ProfileSyncStatusView,
  RepositoryInitResult,
  SecretKind,
  SyncConfigView,
  SyncDiagnostics,
  SyncDiagnosticsExport,
  SyncErrorView,
  SyncOpResult,
} from "./types.ts";

function toErrorView(err: unknown): SyncErrorView {
  if (isSyncError(err)) return { code: err.code, message: err.message };
  return {
    code: SyncErrorCode.Internal,
    message: err instanceof Error ? err.message : String(err),
  };
}

async function wrap<T>(fn: () => Promise<T> | T): Promise<SyncOpResult<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: toErrorView(err) };
  }
}

export function registerSyncIpc(controller: SyncController): void {
  ipcMain.handle("sync:diagnostics", (): Promise<SyncOpResult<SyncDiagnostics>> =>
    wrap(() => controller.diagnostics()),
  );
  ipcMain.handle(
    "sync:exportDiagnostics",
    (_e, profileId?: string): Promise<SyncOpResult<SyncDiagnosticsExport>> =>
      wrap(() => controller.exportDiagnostics(profileId)),
  );
  ipcMain.handle("sync:getConfig", (): SyncConfigView => controller.configView());
  ipcMain.handle(
    "sync:updateConfig",
    (_e, patch: Partial<SyncConfigView>): Promise<SyncOpResult<SyncConfigView>> =>
      wrap(() => controller.updateConfig(patch)),
  );
  ipcMain.handle(
    "sync:saveSecret",
    (_e, kind: SecretKind, value: string): Promise<SyncOpResult> =>
      wrap(async () => {
        await controller.saveSecret(kind, value);
        return undefined;
      }),
  );
  ipcMain.handle(
    "sync:deleteSecret",
    (_e, kind: SecretKind): Promise<SyncOpResult> =>
      wrap(async () => {
        await controller.deleteSecret(kind);
        return undefined;
      }),
  );
  ipcMain.handle("sync:checkBackend", (): Promise<SyncOpResult<boolean>> =>
    wrap(() => controller.checkBackend()),
  );
  // First-run, primary-device-only repository creation. Guarded in the UI with
  // a strong warning; the controller returns deterministic, secret-free errors.
  ipcMain.handle(
    "sync:initializeRepository",
    (): Promise<SyncOpResult<RepositoryInitResult>> =>
      wrap(() => controller.initializeRepository()),
  );

  // Per-profile
  ipcMain.handle(
    "sync:status",
    (_e, profileId: string): SyncOpResult<ProfileSyncStatusView> => {
      try {
        return { ok: true, value: controller.status(profileId) };
      } catch (err) {
        return { ok: false, error: toErrorView(err) };
      }
    },
  );
  ipcMain.handle(
    "sync:enable",
    (_e, profileId: string, enabled: boolean): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      wrap(() => controller.enable(profileId, enabled)),
  );
  ipcMain.handle(
    "sync:acquire",
    (_e, profileId: string): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      wrap(() => controller.acquire(profileId)),
  );
  ipcMain.handle(
    "sync:release",
    (_e, profileId: string): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      wrap(() => controller.release(profileId)),
  );
  ipcMain.handle(
    "sync:backup",
    (_e, profileId: string): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      wrap(() => controller.backupAndPublish(profileId)),
  );
  ipcMain.handle(
    "sync:restore",
    (
      _e,
      profileId: string,
      keepLocalAsConflict: boolean,
    ): Promise<SyncOpResult<ProfileSyncStatusView>> =>
      wrap(() => controller.restoreLatest(profileId, { keepLocalAsConflict })),
  );
  ipcMain.handle(
    "sync:connectExisting",
    (_e, profileId: string): Promise<SyncOpResult<{ profileId: string }>> =>
      wrap(() => controller.connectExisting(profileId)),
  );
}

/** Channel names the controller emits progress on (for preload subscription). */
export const SYNC_PROGRESS_CHANNEL = "sync:progress";
