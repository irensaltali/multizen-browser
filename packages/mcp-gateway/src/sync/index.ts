/**
 * Project-config synchronization foundation.
 *
 * Composes the reserved MCP control namespace, an authenticated-at-rest payload
 * envelope, per-project monotonic revision + CAS publish, signed-envelope
 * verification with quarantine, whole-library fresh-device restore, and signed
 * trust-registry synchronization — all over a narrow structural conditional
 * object store so no circular package dependency is introduced.
 */

// Narrow structural store contract (avoids a hard dep on @multizen/s3-coordinator).
export {
  isStoreErrorKind,
  storeErrorKind,
  type SyncGetResult,
  type SyncListOptions,
  type SyncListPage,
  type SyncObjectStore,
  type SyncPutResult,
  type SyncStoreErrorKind,
} from "./objectStore.js";

// Authenticated AES-256-GCM envelope.
export {
  constantTimeEqualBytes,
  CRYPTO_ENVELOPE_VERSION,
  CryptoError,
  DEFAULT_KDF,
  generateSaltHex,
  open,
  seal,
  type CryptoEnvelope,
  type EnvelopeHeader,
  type KdfParams,
  type SealOptions,
} from "./crypto.js";

// Reserved control-namespace key layout + strict parsing.
export {
  isMcpControlKey,
  MCP_NAMESPACE,
  mcpProjectsPrefix,
  mcpRoot,
  parseProjectStateKey,
  projectRevisionKey,
  projectStateKey,
  trustRegistryKey,
} from "./keys.js";

// On-store project record schema.
export {
  decodeRecord,
  encodeRecord,
  MAX_RECORD_BYTES,
  PROJECT_RECORD_VERSION,
  RecordError,
  type ProjectRecord,
} from "./projectRecord.js";

// Project sync coordinator.
export {
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_MAX_SCAN_KEYS,
  ProjectSyncCoordinator,
  SyncCoordinatorError,
  type AppliedProject,
  type ConflictMetadata,
  type ConflictOutcome,
  type PublishOutcome,
  type PublishResult,
  type QuarantinedProject,
  type RestoreResult,
  type SyncCoordinatorConfig,
} from "./syncCoordinator.js";

// Trust-registry synchronization + first-device bootstrap.
export {
  TrustRegistrySync,
  TrustSyncError,
  type FetchResult,
} from "./trustSync.js";
