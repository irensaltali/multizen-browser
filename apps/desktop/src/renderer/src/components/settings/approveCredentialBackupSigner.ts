import type { CredentialBackupView } from "../../types";

function resultError(result: { ok: boolean; error?: { message: string } }): string {
  return result.error?.message ?? "The device could not be approved.";
}

/**
 * Promote the pending signer through the normal trust-registry API, retry the
 * document sync, and return the refreshed non-secret credential backup view.
 */
export async function approveCredentialBackupSigner(
  deviceId: string,
): Promise<CredentialBackupView> {
  const gateway = window.multizen.gateway;
  const listed = await gateway.trustList();
  if (!listed.ok) throw new Error(resultError(listed));

  const device = listed.value.find((candidate) => candidate.deviceId === deviceId);
  if (!device) {
    throw new Error(`The signing device ${deviceId} has not announced itself yet.`);
  }
  if (device.role === "revoked") {
    throw new Error(`The signing device ${deviceId} is revoked. Re-approve it in Devices.`);
  }
  if (device.role === "pending") {
    const approved = await gateway.approveDevice(device.deviceId, device.publicKeyHex);
    if (!approved.ok) throw new Error(resultError(approved));
  }

  const synced = await gateway.syncRetry();
  if (!synced.ok) throw new Error(resultError(synced));
  const refreshed = await gateway.credentialBackup();
  if (!refreshed.ok) throw new Error(resultError(refreshed));
  if (refreshed.value.remoteIssue !== null) {
    throw new Error(`The backup is still blocked: ${refreshed.value.remoteIssue.message}`);
  }
  return refreshed.value;
}
