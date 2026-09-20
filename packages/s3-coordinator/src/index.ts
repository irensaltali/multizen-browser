/**
 * `@multizen/s3-coordinator`
 *
 * A strongly-consistent lease + revision coordinator for AI-native profile
 * sync, backed by any conditional object store (AWS S3, Cloudflare R2). It
 * replaces the Worker + Durable Object control plane with atomic conditional
 * object writes — no server-side compute required.
 */

export {
  StoreErrorKind,
  StoreError,
  isStoreError,
  isStoreErrorOfKind,
  type ConditionalObjectStore,
  type GetResult,
  type HeadResult,
  type PutResult,
} from "./store.js";

export {
  STATE_VERSION,
  MAX_STATE_BYTES,
  assertSafeProfileId,
  stateKey,
  revisionKey,
  capabilityKey,
  encodeState,
  decodeState,
  initialState,
  type ProfileState,
  type LastOperation,
} from "./state.js";

export {
  InMemoryConditionalObjectStore,
  type InMemoryStoreOptions,
} from "./inMemoryStore.js";

export {
  S3ConditionalObjectStore,
  createS3Deps,
  normalizeEndpoint,
  type S3Deps,
  type S3StoreConfig,
  type S3Credentials,
} from "./s3Store.js";

export { runCapabilityProbe, type CapabilityProbeResult } from "./capability.js";

export {
  S3Coordinator,
  type S3CoordinatorConfig,
  type BackendState,
  type BackendLease,
  type LeaseResult,
  type PublishResult,
  type ReleaseResult,
  type StateResult,
} from "./coordinator.js";
