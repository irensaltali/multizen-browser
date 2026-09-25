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
  DEFAULT_ARGON2ID_KDF,
  DEFAULT_KDF,
  generateSaltHex,
  kdfJson,
  MAX_ARGON2ID_ITERATIONS,
  MAX_ARGON2ID_MEMORY_KIB,
  MAX_ARGON2ID_PARALLELISM,
  open,
  openAsync,
  seal,
  sealAsync,
  type Argon2idKdfParams,
  type CryptoEnvelope,
  type EnvelopeHeader,
  type KdfParams,
  type ScryptKdfParams,
  type SealOptions,
} from "./crypto.js";

// Passphrase-sealed credential bundle (opt-in secret backup).
export {
  assertBundleable,
  assertNotExcluded,
  assertPassphraseAcceptable,
  BUNDLEABLE_CREDENTIAL_PREFIXES,
  CREDENTIAL_BUNDLE_CONTEXT,
  CREDENTIAL_BUNDLE_VERSION,
  CredentialBundleError,
  CREDENTIAL_SECRET_PREFIX,
  CREDENTIAL_TOKEN_PREFIX,
  CREDENTIALS_DOCUMENT_VERSION,
  credentialBundleToJson,
  credentialProjectId,
  credentialsDocumentToJson,
  isBundleableCredentialName,
  MAX_CREDENTIAL_BUNDLE_BYTES,
  MAX_CREDENTIAL_NAME_LENGTH,
  MIN_BUNDLE_PASSPHRASE_LENGTH,
  NEVER_BUNDLED_CREDENTIAL_NAMES,
  openCredentialBundle,
  parseCredentialBundle,
  parseCredentialsDocument,
  sealCredentialBundle,
  selectBundleableNames,
  type BundleScope,
  type CredentialBundle,
  type CredentialBundleErrorCode,
  type CredentialEntry,
  type CredentialsDocument,
  type OpenedCredentialBundle,
  type SealBundleOptions,
} from "./credentialBundle.js";

// Reserved control-namespace key layout + strict parsing.
export {
  deviceDocumentsPrefix,
  documentKey,
  isMcpControlKey,
  MCP_NAMESPACE,
  mcpProjectsPrefix,
  mcpRoot,
  parseDocumentKey,
  parsePendingDeviceKey,
  parseProjectRevisionKey,
  parseProjectStateKey,
  parseProjectTombstoneKey,
  pendingDeviceKey,
  pendingDevicesPrefix,
  projectRevisionKey,
  projectRevisionsPrefix,
  projectStateKey,
  projectTombstoneKey,
  sharedDocumentsPrefix,
  trustRegistryKey,
  type DocumentScope,
  type ParsedDocumentKey,
} from "./keys.js";

// Generic encrypted + signed + revisioned JSON documents.
export {
  DOCUMENT_RECORD_VERSION,
  DocumentStoreError,
  MAX_DOCUMENT_BYTES,
  SyncedDocumentStore,
  type DocumentBody,
  type DocumentConflict,
  type DocumentEnvelope,
  type DocumentPublishResult,
  type DocumentPublished,
  type DocumentReadResult,
  type DocumentRecord,
  type LoadedDocument,
  type RejectedDocument,
  type SyncedDocumentStoreConfig,
} from "./documentStore.js";

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
  ARCHIVE_RECORD_VERSION,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_MAX_SCAN_KEYS,
  ProjectSyncCoordinator,
  selectRevisionAt,
  SyncCoordinatorError,
  type AppliedProject,
  type ArchivedRevision,
  type HistoryEntry,
  type PruneResult,
  type ConflictMetadata,
  type DeletedProject,
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
  type PendingDevice,
} from "./trustSync.js";
