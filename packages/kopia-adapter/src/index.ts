/**
 * @multizen/kopia-adapter
 *
 * Storage foundation for MultiZen Cloud Sync. Provides a shell-free, testable
 * wrapper around the Kopia CLI plus the supporting primitives: minimal-env
 * secret injection, command construction, JSON parsing, a quiescence guard, a
 * sanitized manifest store, and an atomic same-volume swap helper.
 *
 * Node built-ins only. No runtime dependencies.
 */

export {
  NodeProcessRunner,
  UnsafeSpawnError,
  redactString,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from "./process-runner.js";

export {
  SECRET_ENV_KEYS,
  buildChildEnv,
  secretValues,
  type BuildEnvOptions,
  type KopiaSecrets,
  type SecretEnvKey,
} from "./env.js";

export {
  ALLOWED_TAG_KEYS,
  TagValidationError,
  SnapshotIdValidationError,
  buildConnectArgs,
  buildCreateArgs,
  buildMaintenanceRunArgs,
  buildSnapshotCreateArgs,
  buildSnapshotDeleteArgs,
  buildSnapshotListArgs,
  buildSnapshotRestoreArgs,
  validateSnapshotId,
  validateTags,
  type AllowedTagKey,
  type FilesystemRepository,
  type GlobalKopiaOptions,
  type MaintenanceRunOptions,
  type RepositoryTarget,
  type S3Repository,
  type SnapshotCreateOptions,
  type SnapshotDeleteOptions,
  type SnapshotListOptions,
  type SnapshotRestoreOptions,
  type SnapshotTags,
} from "./commands.js";

export {
  KopiaJsonParseError,
  parseJson,
  parseJsonArray,
} from "./json.js";

export {
  ResourceBusyError,
  alwaysQuiescentGuard,
  assertQuiescent,
  type QuiescenceGuard,
  type QuiescenceStatus,
} from "./quiescence.js";

export {
  MANIFEST_VERSION,
  ManifestValidationError,
  readManifest,
  validateId,
  validateManifest,
  validateSafePath,
  writeManifest,
  type ManifestEntry,
  type SyncManifest,
} from "./manifest.js";

export {
  SwapError,
  atomicSwap,
  nodeSwapFs,
  sameVolumeSync,
  type SwapFs,
  type SwapPlan,
  type SwapResult,
} from "./swap.js";

export {
  KopiaAdapter,
  KopiaCommandError,
  type DeleteProfileSnapshotsResult,
  type EnsureRepositoryResult,
  type KopiaAdapterOptions,
  type ProfileSnapshot,
  type RunOptions,
} from "./adapter.js";

export { isRepositoryNotInitialized } from "./ensure-repository.js";
