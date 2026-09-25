/**
 * @multizen/mcp-gateway
 *
 * Core of the local MCP gateway: strict versioned project config with an atomic
 * store, Ed25519 device trust (signing, verification, revocation, rollback and
 * quarantine) over a private-key vault abstraction, an env-reference resolver,
 * a security router (loopback Host/Origin, body limits, per-project bearer auth
 * default-off), a shell-free stdio supervisor with backoff/circuit-breaker, a
 * streamable-http upstream connector, a full MCP JSON-RPC relay, and a stateful
 * downstream Streamable HTTP session manager.
 *
 * No desktop, Electron, or S3 integration lives here — this package is the pure,
 * testable core those layers compose.
 */

// Canonical JSON (hashing + signing input).
export {
  canonicalize,
  canonicalBytes,
  CanonicalJsonError,
  type JsonPrimitive,
  type JsonValue,
} from "./canonicalJson.js";

// Identifiers and environment-reference grammar.
export {
  assertProjectId,
  assertServerId,
  hasNoEnvRef,
  InvalidIdError,
  isEnvName,
  isPureEnvRef,
  isSafeId,
  pureEnvRefName,
  referencedEnvNames,
  type ProjectId,
  type ServerId,
} from "./ids.js";

// Env resolution.
export {
  buildBaseEnv,
  DEFAULT_BASE_ENV_ALLOW,
  EnvResolutionError,
  EnvResolver,
  type EnvResolverOptions,
} from "./env.js";

// Versioned project config schema.
export {
  CONFIG_VERSION,
  ConfigValidationError,
  migrate,
  parseProjectConfig,
  projectConfigToJson,
  type HttpServerConfig,
  type LocalAuthConfig,
  type ProjectConfig,
  type ServerConfig,
  type StdioServerConfig,
} from "./projectConfig.js";

// Atomic config store.
export {
  configHash,
  ProjectConfigStore,
  type LoadResult,
  type RejectedProject,
  type StoredProject,
} from "./projectConfigStore.js";

// Private-key vault + device identity.
export {
  deviceIdFromPublicKey,
  InMemoryVault,
  publicKeyHexFrom,
  type KeyVault,
  type PublicKeyHex,
  type SigningKey,
} from "./vault.js";

// Trust registry, signing, verification.
export {
  ARCHIVE_STAMP_VERSION,
  ENVELOPE_VERSION,
  TOMBSTONE_VERSION,
  TRUST_REGISTRY_VERSION,
  assertTrustedSigner,
  evaluateProject,
  hashConfig,
  signArchiveStamp,
  signProject,
  signTombstone,
  signTrustRegistry,
  verifyArchiveStamp,
  verifyProject,
  verifyTombstone,
  verifyTrustRegistry,
  VerificationError,
  type ArchiveStamp,
  type ArchiveStampBody,
  type EnvelopeBody,
  type ProjectEnvelope,
  type ProjectTombstone,
  type QuarantineDecision,
  type TombstoneBody,
  type TrustEntry,
  type TrustRegistry,
  type TrustRegistryBody,
  type TrustRole,
  type VerifiedProject,
  type VerifiedTombstone,
  type VerifyOptions,
} from "./trust.js";

// JSON-RPC model + transport contract + error codes.
export {
  isError,
  isNotification,
  isRequest,
  isResponse,
  JSON_RPC,
  MCP_ERROR,
  type GatewayTransport,
  type JsonRpcError,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
} from "./jsonrpc.js";

// Security router.
export {
  constantTimeEquals,
  isLoopbackHost,
  parseBearer,
  Router,
  type BrowserRoute,
  type DenyReason,
  type ProjectAuthPolicy,
  type ProxyRoute,
  type Route,
  type RouteAllowed,
  type RouteDenied,
  type RouteKind,
  type RouteResult,
  type RouterOptions,
  type RouterRequest,
} from "./router.js";

// stdio supervisor.
export {
  DEFAULT_BACKOFF,
  StdioSupervisor,
  systemClock,
  type BackoffPolicy,
  type Clock,
  type RuntimeState,
  type StdioTransportFactory,
  type StdioTransportSpec,
  type SupervisorOptions,
  type SupervisorPhase,
} from "./stdioSupervisor.js";

// Production stdio transport factory (wraps the SDK).
export { createStdioTransportFactory } from "./stdioTransportFactory.js";

// streamable-http upstream connector.
export {
  HttpConnector,
  type FetchLike,
  type HttpConnectorOptions,
  type HttpConnectorPhase,
  type HttpTransportFactory,
  type HttpTransportSpec,
} from "./httpConnector.js";

// Production streamable-http transport factory (wraps the SDK).
export { createHttpTransportFactory } from "./httpTransportFactory.js";

// MCP JSON-RPC relay.
export {
  RelaySession,
  SERVER_INITIATED_METHODS,
  type ClientSink,
  type RelaySessionOptions,
} from "./relay.js";

// Downstream Streamable HTTP session manager.
export {
  PROTOCOL_VERSION_HEADER,
  SESSION_ID_HEADER,
  SessionManager,
  SUPPORTED_PROTOCOL_VERSIONS,
  type HttpVerb,
  type SessionDecision,
  type SessionDecisionKind,
  type SessionManagerOptions,
  type SessionRequest,
  type SessionState,
} from "./sessionManager.js";

// Project-config synchronization foundation (reserved control namespace,
// authenticated payload envelope, monotonic revision + CAS publish, signed
// envelope verification/quarantine, fresh-device restore, trust-registry sync).
export {
  assertBundleable,
  assertNotExcluded,
  assertPassphraseAcceptable,
  BUNDLEABLE_CREDENTIAL_PREFIXES,
  constantTimeEqualBytes,
  CREDENTIAL_BUNDLE_CONTEXT,
  CREDENTIAL_BUNDLE_VERSION,
  CREDENTIAL_SECRET_PREFIX,
  CREDENTIAL_TOKEN_PREFIX,
  CREDENTIALS_DOCUMENT_VERSION,
  CredentialBundleError,
  credentialBundleToJson,
  credentialProjectId,
  credentialsDocumentToJson,
  CRYPTO_ENVELOPE_VERSION,
  CryptoError,
  DEFAULT_ARGON2ID_KDF,
  DEFAULT_KDF,
  ARCHIVE_RECORD_VERSION,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_MAX_SCAN_KEYS,
  decodeRecord,
  encodeRecord,
  generateSaltHex,
  deviceDocumentsPrefix,
  documentKey,
  DOCUMENT_RECORD_VERSION,
  DocumentStoreError,
  isBundleableCredentialName,
  isMcpControlKey,
  isStoreErrorKind,
  kdfJson,
  MAX_ARGON2ID_ITERATIONS,
  MAX_ARGON2ID_MEMORY_KIB,
  MAX_ARGON2ID_PARALLELISM,
  MAX_CREDENTIAL_BUNDLE_BYTES,
  MAX_CREDENTIAL_NAME_LENGTH,
  MAX_RECORD_BYTES,
  MCP_NAMESPACE,
  mcpProjectsPrefix,
  mcpRoot,
  MIN_BUNDLE_PASSPHRASE_LENGTH,
  NEVER_BUNDLED_CREDENTIAL_NAMES,
  open as openEnvelope,
  openAsync as openEnvelopeAsync,
  openCredentialBundle,
  parseCredentialBundle,
  parseCredentialsDocument,
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
  ProjectSyncCoordinator,
  selectRevisionAt,
  PROJECT_RECORD_VERSION,
  RecordError,
  seal as sealEnvelope,
  sealAsync as sealEnvelopeAsync,
  sealCredentialBundle,
  selectBundleableNames,
  sharedDocumentsPrefix,
  storeErrorKind,
  SyncCoordinatorError,
  SyncedDocumentStore,
  TrustRegistrySync,
  trustRegistryKey,
  TrustSyncError,
  type AppliedProject,
  type ArchivedRevision,
  type HistoryEntry,
  type PruneResult,
  type Argon2idKdfParams,
  type BundleScope,
  type ConflictMetadata,
  type ConflictOutcome,
  type CredentialBundle,
  type CredentialBundleErrorCode,
  type CredentialEntry,
  type CredentialsDocument,
  type DeletedProject,
  type DocumentConflict,
  type DocumentPublishResult,
  type DocumentReadResult,
  type DocumentScope,
  type LoadedDocument,
  type OpenedCredentialBundle,
  type RejectedDocument,
  type CryptoEnvelope,
  type EnvelopeHeader,
  type FetchResult,
  type KdfParams,
  type PendingDevice,
  type ProjectRecord,
  type PublishOutcome,
  type PublishResult,
  type QuarantinedProject,
  type RestoreResult,
  type ScryptKdfParams,
  type SealBundleOptions,
  type SealOptions,
  type SyncCoordinatorConfig,
  type SyncGetResult,
  type SyncListOptions,
  type SyncListPage,
  type SyncObjectStore,
  type SyncPutResult,
  type SyncStoreErrorKind,
} from "./sync/index.js";
