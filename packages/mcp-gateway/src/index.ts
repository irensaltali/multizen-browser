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
  ENVELOPE_VERSION,
  TRUST_REGISTRY_VERSION,
  evaluateProject,
  hashConfig,
  signProject,
  signTrustRegistry,
  verifyProject,
  verifyTrustRegistry,
  VerificationError,
  type EnvelopeBody,
  type ProjectEnvelope,
  type QuarantineDecision,
  type TrustEntry,
  type TrustRegistry,
  type TrustRegistryBody,
  type TrustRole,
  type VerifiedProject,
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
  constantTimeEqualBytes,
  CRYPTO_ENVELOPE_VERSION,
  CryptoError,
  DEFAULT_KDF,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_MAX_SCAN_KEYS,
  decodeRecord,
  encodeRecord,
  generateSaltHex,
  isMcpControlKey,
  isStoreErrorKind,
  MAX_RECORD_BYTES,
  MCP_NAMESPACE,
  mcpProjectsPrefix,
  mcpRoot,
  open as openEnvelope,
  parseProjectStateKey,
  projectRevisionKey,
  projectStateKey,
  ProjectSyncCoordinator,
  PROJECT_RECORD_VERSION,
  RecordError,
  seal as sealEnvelope,
  storeErrorKind,
  SyncCoordinatorError,
  TrustRegistrySync,
  trustRegistryKey,
  TrustSyncError,
  type AppliedProject,
  type ConflictMetadata,
  type ConflictOutcome,
  type CryptoEnvelope,
  type EnvelopeHeader,
  type FetchResult,
  type KdfParams,
  type ProjectRecord,
  type PublishOutcome,
  type PublishResult,
  type QuarantinedProject,
  type RestoreResult,
  type SealOptions,
  type SyncCoordinatorConfig,
  type SyncGetResult,
  type SyncListOptions,
  type SyncListPage,
  type SyncObjectStore,
  type SyncPutResult,
  type SyncStoreErrorKind,
} from "./sync/index.js";
