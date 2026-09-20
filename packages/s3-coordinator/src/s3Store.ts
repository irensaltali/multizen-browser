/**
 * AWS S3 / Cloudflare R2 implementation of {@link ConditionalObjectStore}.
 *
 * Uses the pinned `@aws-sdk/client-s3` `3.1136.0`. All conditional semantics go
 * through S3 preconditions:
 *   - `putCreate` / `putImmutable` → `IfNoneMatch: "*"`
 *   - `putCompareAndSwap`          → `IfMatch: <opaque etag>`
 *
 * Design notes
 * ------------
 *   - Credentials are held only inside the SDK client config. They are NEVER
 *     logged, and this object defines no enumerable field that exposes them: a
 *     redaction guard keeps `toJSON`/inspection credential-free.
 *   - The server `Date` response header is captured through a per-COMMAND
 *     deserialize-stage middleware. Because every `send()` builds a fresh
 *     command instance and installs the middleware on THAT command's own
 *     `middlewareStack` with a request-scoped holder, there is no shared mutable
 *     capture state across concurrent requests. When the header cannot be
 *     observed (or the command exposes no middleware stack), `serverDateMs` is
 *     null and the coordinator falls back to local time CONSERVATIVELY. We never
 *     reuse another request's captured Date.
 *   - ETags are treated as OPAQUE. We preserve the exact quoted string the SDK
 *     returns and echo it back verbatim into `IfMatch`.
 *   - Provider errors are normalized to {@link StoreError} by HTTP status and
 *     SDK error name (404/NoSuchKey, 412 PreconditionFailed, 409, 401/403).
 *
 * The store compiles against the REAL `@aws-sdk/client-s3` type surface. The
 * SDK client and command constructors are injectable so tests exercise the
 * exact command inputs (IfMatch/IfNoneMatch) and error normalization without
 * touching the network or real credentials.
 */

import type {
  S3ClientConfig,
  GetObjectCommandInput,
  GetObjectCommandOutput,
  PutObjectCommandInput,
  PutObjectCommandOutput,
  HeadObjectCommandInput,
  HeadObjectCommandOutput,
  HeadBucketCommandInput,
  HeadBucketCommandOutput,
  DeleteObjectCommandInput,
  DeleteObjectCommandOutput,
} from "@aws-sdk/client-s3";
import type { MetadataBearer } from "@smithy/types";

import {
  StoreError,
  StoreErrorKind,
  type ConditionalObjectStore,
  type GetResult,
  type HeadResult,
  type PutResult,
} from "./store.js";

/** Static credentials for S3/R2. Held only inside the SDK config. */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3StoreConfig {
  bucket: string;
  region?: string;
  /** Custom endpoint (required for R2, optional for AWS). Normalized. */
  endpoint?: string;
  /** Path-style addressing (R2 and MinIO commonly need this). */
  forcePathStyle?: boolean;
  credentials?: S3Credentials;
  /** SDK retry attempts. Defaults to 3. */
  maxAttempts?: number;
}

/**
 * A command instance as produced by an `@aws-sdk/client-s3` command
 * constructor. We only touch two members: the `input` we handed in and the
 * per-command `middlewareStack` we use to capture the response `Date` header.
 * `Output` is a phantom used to thread the response type through `send`.
 */
export interface S3Command<Input, Output> {
  readonly input: Input;
  /**
   * The command's own middleware stack. Present on real SDK commands; absent on
   * lightweight test doubles (in which case Date capture is skipped and
   * `serverDateMs` is null).
   */
  middlewareStack?: CommandMiddlewareStack;
  /** Phantom type carrier — never read at runtime. */
  readonly __output?: Output;
}

/** The subset of a command's `middlewareStack` we rely on to add a deserializer. */
export interface CommandMiddlewareStack {
  add(middleware: DeserializeMiddlewareLike, options?: MiddlewareAddOptions): void;
}

interface MiddlewareAddOptions {
  step?: string;
  name?: string;
  priority?: string;
  tags?: string[];
  override?: boolean;
}

/**
 * Structural shape of a deserialize-stage middleware: given the `next` handler
 * it returns a handler that awaits `next` and may inspect the low-level
 * `response`. Kept structural so it satisfies the real SDK's
 * `DeserializeMiddleware` type without importing its full generics.
 */
type DeserializeMiddlewareLike = (
  next: (args: { readonly [key: string]: unknown }) => Promise<DeserializeOutputLike>,
  context: { readonly [key: string]: unknown },
) => (args: { readonly [key: string]: unknown }) => Promise<DeserializeOutputLike>;

interface DeserializeOutputLike {
  response?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

/**
 * A minimal S3 client surface: we only ever call `send` with a command built by
 * one of the injected constructors, and (in production) `destroy`.
 */
export interface S3ClientLike {
  send<Output extends MetadataBearer>(
    command: S3Command<unknown, Output>,
  ): Promise<Output>;
  destroy?(): void;
}

/**
 * The subset of `@aws-sdk/client-s3` this store needs. Injectable so tests can
 * supply a mock without the real SDK. In production {@link createS3Deps}
 * dynamically imports the real module and adapts it to this shape.
 */
export interface S3Deps {
  makeClient(config: S3ClientConfig): S3ClientLike;
  GetObjectCommand: new (
    input: GetObjectCommandInput,
  ) => S3Command<GetObjectCommandInput, GetObjectCommandOutput>;
  PutObjectCommand: new (
    input: PutObjectCommandInput,
  ) => S3Command<PutObjectCommandInput, PutObjectCommandOutput>;
  HeadObjectCommand: new (
    input: HeadObjectCommandInput,
  ) => S3Command<HeadObjectCommandInput, HeadObjectCommandOutput>;
  HeadBucketCommand: new (
    input: HeadBucketCommandInput,
  ) => S3Command<HeadBucketCommandInput, HeadBucketCommandOutput>;
  DeleteObjectCommand: new (
    input: DeleteObjectCommandInput,
  ) => S3Command<DeleteObjectCommandInput, DeleteObjectCommandOutput>;
}

/**
 * Lazily import the real SDK and wrap it as {@link S3Deps}. Kept dynamic so the
 * package (and its in-memory-only tests) run without eagerly loading the SDK;
 * the real dependency is resolved on first production use.
 *
 * The real `S3Client.send` and command constructors are structurally
 * compatible with {@link S3Deps} (their command instances carry `.input` and a
 * `.middlewareStack`), so a single well-scoped cast at the module boundary is
 * sufficient — we do not misrepresent the SDK surface anywhere else.
 */
export async function createS3Deps(): Promise<S3Deps> {
  const sdk = await import("@aws-sdk/client-s3");
  return {
    makeClient: (config) => new sdk.S3Client(config) as unknown as S3ClientLike,
    GetObjectCommand: sdk.GetObjectCommand as unknown as S3Deps["GetObjectCommand"],
    PutObjectCommand: sdk.PutObjectCommand as unknown as S3Deps["PutObjectCommand"],
    HeadObjectCommand: sdk.HeadObjectCommand as unknown as S3Deps["HeadObjectCommand"],
    HeadBucketCommand: sdk.HeadBucketCommand as unknown as S3Deps["HeadBucketCommand"],
    DeleteObjectCommand: sdk.DeleteObjectCommand as unknown as S3Deps["DeleteObjectCommand"],
  };
}

/**
 * Normalize a user-supplied endpoint. Ensures a scheme (defaults https),
 * strips trailing slashes and any path, and rejects obviously invalid input.
 * Returns undefined for an empty/omitted endpoint (AWS default resolution).
 */
export function normalizeEndpoint(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new StoreError(StoreErrorKind.Malformed, "invalid S3 endpoint");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StoreError(StoreErrorKind.Malformed, "S3 endpoint must be http(s)");
  }
  // origin drops any path/query/fragment.
  return url.origin;
}

/** Parse an RFC 1123 `Date` header value to epoch ms, or null. */
function parseServerDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Case-insensitively read the `Date` header from a captured header bag. */
function readDateHeader(headers: Record<string, string> | undefined): number | null {
  if (!headers) return null;
  const direct = headers["date"] ?? headers["Date"];
  if (direct !== undefined) return parseServerDate(direct);
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "date") return parseServerDate(v);
  }
  return null;
}

/** Request-scoped holder written by a single command's deserialize middleware. */
interface DateHolder {
  serverDateMs: number | null;
}

/**
 * Install a request-scoped Date-capture middleware onto a single command's own
 * middleware stack. The middleware writes into `holder`, which belongs to this
 * one `send()` only — no cross-request sharing. Returns silently if the command
 * exposes no usable middleware stack (Date capture then yields null).
 */
function installDateCapture(
  command: S3Command<unknown, MetadataBearer>,
  holder: DateHolder,
): void {
  const stack = command.middlewareStack;
  if (!stack || typeof stack.add !== "function") return;
  const middleware: DeserializeMiddlewareLike = (next) => async (args) => {
    const result = await next(args);
    const response = result?.response as
      | { headers?: Record<string, string> }
      | undefined;
    holder.serverDateMs = readDateHeader(response?.headers);
    return result;
  };
  try {
    stack.add(middleware, {
      step: "deserialize",
      name: "multizenDateCapture",
      priority: "low",
      override: true,
    });
  } catch {
    // Stack rejected the middleware — leave holder null (conservative fallback).
  }
}

function normalizeError(err: unknown): StoreError {
  if (err instanceof StoreError) return err;
  const e = err as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
    Code?: string;
  };
  const status = e?.$metadata?.httpStatusCode;
  const name = e?.name ?? e?.Code ?? "";
  if (status === 404 || name === "NoSuchKey" || name === "NotFound" || name === "NoSuchBucket") {
    return new StoreError(StoreErrorKind.NotFound, "object not found", status ?? 404);
  }
  if (status === 412 || name === "PreconditionFailed") {
    return new StoreError(StoreErrorKind.PreconditionFailed, "precondition failed", status ?? 412);
  }
  if (status === 409 || name === "OperationAborted" || name === "ConditionalRequestConflict") {
    return new StoreError(StoreErrorKind.Conflict, "conflict", status ?? 409);
  }
  if (
    status === 401 ||
    status === 403 ||
    name === "AccessDenied" ||
    name === "InvalidAccessKeyId" ||
    name === "SignatureDoesNotMatch"
  ) {
    return new StoreError(StoreErrorKind.AuthFailed, "authorization failed", status);
  }
  if (typeof status === "number" && status >= 500) {
    return new StoreError(StoreErrorKind.Unreachable, "store server error", status);
  }
  // Network/timeout/DNS: no HTTP status.
  const msg = typeof e?.message === "string" ? e.message : "store unreachable";
  return new StoreError(StoreErrorKind.Unreachable, msg, status);
}

export class S3ConditionalObjectStore implements ConditionalObjectStore {
  readonly #client: S3ClientLike;
  readonly #deps: S3Deps;
  readonly #bucket: string;

  constructor(config: S3StoreConfig, deps: S3Deps) {
    if (!config.bucket || typeof config.bucket !== "string") {
      throw new StoreError(StoreErrorKind.Malformed, "bucket is required");
    }
    this.#bucket = config.bucket;
    this.#deps = deps;

    const clientConfig: S3ClientConfig = {
      region: config.region ?? "auto",
      forcePathStyle: config.forcePathStyle ?? false,
      maxAttempts: config.maxAttempts ?? 3,
    };
    const endpoint = normalizeEndpoint(config.endpoint);
    if (endpoint) clientConfig.endpoint = endpoint;
    if (config.credentials) {
      clientConfig.credentials = {
        accessKeyId: config.credentials.accessKeyId,
        secretAccessKey: config.credentials.secretAccessKey,
        ...(config.credentials.sessionToken
          ? { sessionToken: config.credentials.sessionToken }
          : {}),
      };
    }
    this.#client = deps.makeClient(clientConfig);
  }

  /** Redaction: never expose credentials via inspection/serialization. */
  toJSON(): Record<string, unknown> {
    return { store: "S3ConditionalObjectStore", bucket: this.#bucket };
  }

  /**
   * Build the command, attach a request-scoped Date-capture middleware, send it,
   * and return the output alongside the Date observed for THIS request only.
   */
  async #send<Output extends MetadataBearer>(
    command: S3Command<unknown, Output>,
  ): Promise<{ output: Output; serverDateMs: number | null }> {
    const holder: DateHolder = { serverDateMs: null };
    installDateCapture(command as S3Command<unknown, MetadataBearer>, holder);
    try {
      const output = await this.#client.send<Output>(command);
      return { output, serverDateMs: holder.serverDateMs };
    } catch (err) {
      throw normalizeError(err);
    }
  }

  async get(key: string): Promise<GetResult> {
    const cmd = new this.#deps.GetObjectCommand({ Bucket: this.#bucket, Key: key });
    const { output, serverDateMs } = await this.#send<GetObjectCommandOutput>(cmd);
    const body = output.Body;
    if (!body) {
      throw new StoreError(StoreErrorKind.Malformed, "empty GET body");
    }
    const bytes = await body.transformToByteArray();
    const text = new TextDecoder("utf-8").decode(bytes);
    const etag = output.ETag;
    if (typeof etag !== "string" || etag.length === 0) {
      throw new StoreError(StoreErrorKind.Malformed, "missing ETag on GET");
    }
    return { bytes, text, etag, serverDateMs };
  }

  async head(key: string): Promise<HeadResult> {
    const cmd = new this.#deps.HeadObjectCommand({ Bucket: this.#bucket, Key: key });
    const { output, serverDateMs } = await this.#send<HeadObjectCommandOutput>(cmd);
    const etag = output.ETag;
    if (typeof etag !== "string" || etag.length === 0) {
      throw new StoreError(StoreErrorKind.Malformed, "missing ETag on HEAD");
    }
    return { etag, serverDateMs };
  }

  async putCreate(key: string, body: Uint8Array): Promise<PutResult> {
    const cmd = new this.#deps.PutObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      IfNoneMatch: "*",
    });
    const { output, serverDateMs } = await this.#send<PutObjectCommandOutput>(cmd);
    return { etag: output.ETag ?? "", serverDateMs };
  }

  async putImmutable(key: string, body: Uint8Array): Promise<PutResult> {
    return this.putCreate(key, body);
  }

  async putCompareAndSwap(key: string, body: Uint8Array, etag: string): Promise<PutResult> {
    const cmd = new this.#deps.PutObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      IfMatch: etag,
    });
    const { output, serverDateMs } = await this.#send<PutObjectCommandOutput>(cmd);
    return { etag: output.ETag ?? "", serverDateMs };
  }

  async delete(key: string): Promise<void> {
    try {
      const cmd = new this.#deps.DeleteObjectCommand({ Bucket: this.#bucket, Key: key });
      await this.#send<DeleteObjectCommandOutput>(cmd);
    } catch (err) {
      if (err instanceof StoreError && err.kind === StoreErrorKind.NotFound) return;
      // best-effort: swallow all delete failures
      return;
    }
  }

  async health(): Promise<boolean> {
    try {
      const cmd = new this.#deps.HeadBucketCommand({ Bucket: this.#bucket });
      await this.#send<HeadBucketCommandOutput>(cmd);
      return true;
    } catch {
      return false;
    }
  }
}
