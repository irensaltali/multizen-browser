import type { CredentialSync } from "./CredentialSync.ts";
import type { GatewayService } from "./GatewayService.ts";

type ReconcileOutcome = Awaited<ReturnType<CredentialSync["reconcile"]>>;

export interface CredentialSyncStartupDeps {
  readonly credentials: Pick<CredentialSync, "reconcile">;
  readonly gateway: Pick<GatewayService, "composeSyncIfReady" | "syncNow">;
  readonly cloud: {
    autoBootstrap(): Promise<unknown>;
  };
  readonly logger?: Pick<Console, "info" | "error">;
}

export interface CredentialSyncStartupResult {
  readonly initial: ReconcileOutcome | null;
  /** Background retry started only when the first pass ran before Cloud Sync. */
  readonly retry: Promise<void> | null;
}

function needsCloudReadyRetry(outcome: ReconcileOutcome | null): boolean {
  return (
    outcome?.restore.reason === "not-syncing" ||
    outcome?.push.reason === "not-syncing"
  );
}

/**
 * Reconcile the optional credential backup during startup.
 *
 * Cloud profile bootstrap begins before the MCP gateway exists. If the first
 * credential pass lands in that window, join bootstrap, compose the shared
 * document channel, pull its signed documents, and retry once.
 */
export async function reconcileCredentialBackupAtStartup(
  deps: CredentialSyncStartupDeps,
): Promise<CredentialSyncStartupResult> {
  const logger = deps.logger ?? console;
  const reconcile = async (stage: "startup" | "cloud-ready"): Promise<ReconcileOutcome | null> => {
    try {
      const outcome = await deps.credentials.reconcile();
      logger.info(`[MCP credential backup] ${stage} reconcile`, {
        restore: {
          restored: outcome.restore.restored,
          reason: outcome.restore.reason ?? "ok",
          ...(outcome.restore.rejection
            ? {
                rejection: {
                  code: outcome.restore.rejection.code,
                  reason: outcome.restore.rejection.reason,
                },
              }
            : {}),
        },
        push: {
          pushed: outcome.push.pushed,
          entryCount: outcome.push.entryCount,
          reason: outcome.push.reason ?? "ok",
          ...(outcome.push.rejection
            ? {
                rejection: {
                  code: outcome.push.rejection.code,
                  reason: outcome.push.rejection.reason,
                },
              }
            : {}),
        },
      });
      return outcome;
    } catch {
      // Credential errors are deliberately not interpolated into logs because
      // an upstream error could contain secret material.
      logger.error(`[MCP credential backup] ${stage} reconcile failed`);
      return null;
    }
  };

  const initial = await reconcile("startup");
  if (!needsCloudReadyRetry(initial)) return { initial, retry: null };

  const retry = deps.cloud
    .autoBootstrap()
    .then(async () => {
      const composed = await deps.gateway.composeSyncIfReady();
      if (!composed) return;
      await deps.gateway.syncNow();
      await reconcile("cloud-ready");
    })
    .catch(() => {
      logger.error("[MCP credential backup] cloud-ready reconcile failed");
    });

  return { initial, retry };
}
