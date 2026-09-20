export { SyncErrorCode, syncError, isSyncError, type SyncError } from "./errors.js";
export {
  NO_REVISION,
  type ProfileId,
  type DeviceId,
  type Revision,
  type SnapshotId,
  type ProfileSyncState,
  type DeviceIdentity,
  type Lease,
  type LeaseRequest,
  type LeaseDecision,
  type ProfileCoordinationState,
} from "./types.js";
export {
  decideLaunch,
  decideRestore,
  classifyConflict,
  conflictCopyName,
  decidePublish,
  evaluateLease,
  isFencingTokenValid,
  isLeaseExpired,
  type LaunchDecision,
  type RestoreDecision,
  type ConflictOutcome,
  type PublishDecision,
} from "./decisions.js";
export {
  MANIFEST_VERSION,
  sanitizeProxy,
  toManifest,
  assertManifestSafe,
  type ManifestProxyInput,
  type SanitizedProxy,
  type ProfileManifestInput,
  type ProfileManifest,
} from "./manifest.js";
