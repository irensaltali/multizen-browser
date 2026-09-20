import { test } from "node:test";
import assert from "node:assert/strict";
import {
  S3ConditionalObjectStore,
  normalizeEndpoint,
  createS3Deps,
  type S3Deps,
  type S3Command,
  type CommandMiddlewareStack,
} from "./s3Store.js";
import { StoreError, StoreErrorKind } from "./store.js";

// ── mock SDK ────────────────────────────────────────────────────────────────
//
// The mock mirrors the honest S3Deps contract: command constructors produce
// instances carrying `.input` and a `.middlewareStack`; the client exposes
// `send`. This lets tests assert the EXACT command inputs the store issues and
// exercise the request-scoped Date-capture middleware without the real SDK.

interface RecordedCommand {
  type: string;
  input: Record<string, unknown>;
}

interface MockBehavior {
  /** Produce a response (or throw) for a recorded command. */
  onSend: (cmd: RecordedCommand) => Promise<unknown>;
  /**
   * Optional low-level `response` (with headers) surfaced to the deserialize
   * middleware, letting tests assert server-Date capture.
   */
  responseFor?: (cmd: RecordedCommand) => { headers?: Record<string, string> } | undefined;
}

/** A per-command middleware stack that runs installed deserializers over the response. */
class MockMiddlewareStack implements CommandMiddlewareStack {
  readonly middlewares: Array<
    (
      next: (a: Record<string, unknown>) => Promise<Record<string, unknown>>,
      ctx: Record<string, unknown>,
    ) => (a: Record<string, unknown>) => Promise<Record<string, unknown>>
  > = [];
  add(mw: unknown): void {
    this.middlewares.push(mw as (typeof this.middlewares)[number]);
  }
}

function makeMockDeps(behavior: MockBehavior): {
  deps: S3Deps;
  commands: RecordedCommand[];
  clientConfigs: Record<string, unknown>[];
} {
  const commands: RecordedCommand[] = [];
  const clientConfigs: Record<string, unknown>[] = [];

  const mkCmd = <Input, Output>(type: string) =>
    class implements S3Command<Input, Output> {
      readonly input: Input;
      readonly __type = type;
      readonly middlewareStack = new MockMiddlewareStack();
      constructor(input: Input) {
        this.input = input;
      }
    } as unknown as new (input: Input) => S3Command<Input, Output>;

  const client = {
    async send<Output>(cmd: S3Command<unknown, Output> & { __type?: string }) {
      const type = (cmd as { __type?: string }).__type ?? "?";
      const rec: RecordedCommand = {
        type,
        input: (cmd.input as Record<string, unknown>) ?? {},
      };
      commands.push(rec);
      // Run the installed deserialize middlewares so Date capture is exercised.
      const stack = cmd.middlewareStack as unknown as MockMiddlewareStack | undefined;
      const response = behavior.responseFor?.(rec);
      const terminal = async (): Promise<Record<string, unknown>> => {
        const output = (await behavior.onSend(rec)) as Record<string, unknown>;
        return { output, response };
      };
      let handler = terminal;
      if (stack) {
        for (const mw of stack.middlewares) {
          const next = handler;
          handler = () => mw((a) => next(), {})({});
        }
      }
      const result = await handler();
      return (result.output ?? result) as Output;
    },
    destroy() {},
  };

  const deps: S3Deps = {
    makeClient: (config) => {
      clientConfigs.push(config as unknown as Record<string, unknown>);
      return client as unknown as ReturnType<S3Deps["makeClient"]>;
    },
    GetObjectCommand: mkCmd<
      import("@aws-sdk/client-s3").GetObjectCommandInput,
      import("@aws-sdk/client-s3").GetObjectCommandOutput
    >("GetObject"),
    PutObjectCommand: mkCmd<
      import("@aws-sdk/client-s3").PutObjectCommandInput,
      import("@aws-sdk/client-s3").PutObjectCommandOutput
    >("PutObject"),
    HeadObjectCommand: mkCmd<
      import("@aws-sdk/client-s3").HeadObjectCommandInput,
      import("@aws-sdk/client-s3").HeadObjectCommandOutput
    >("HeadObject"),
    HeadBucketCommand: mkCmd<
      import("@aws-sdk/client-s3").HeadBucketCommandInput,
      import("@aws-sdk/client-s3").HeadBucketCommandOutput
    >("HeadBucket"),
    DeleteObjectCommand: mkCmd<
      import("@aws-sdk/client-s3").DeleteObjectCommandInput,
      import("@aws-sdk/client-s3").DeleteObjectCommandOutput
    >("DeleteObject"),
  };
  return { deps, commands, clientConfigs };
}

const enc = new TextEncoder();

// ── endpoint normalization ────────────────────────────────────────────────

test("normalizeEndpoint: adds scheme, strips path/trailing slash", () => {
  assert.equal(normalizeEndpoint("r2.example.com"), "https://r2.example.com");
  assert.equal(normalizeEndpoint("https://r2.example.com/"), "https://r2.example.com");
  assert.equal(normalizeEndpoint("https://r2.example.com/bucket/x"), "https://r2.example.com");
  assert.equal(normalizeEndpoint("http://localhost:9000"), "http://localhost:9000");
  assert.equal(normalizeEndpoint(""), undefined);
  assert.equal(normalizeEndpoint(undefined), undefined);
});

test("normalizeEndpoint: rejects invalid scheme", () => {
  assert.throws(
    () => normalizeEndpoint("ftp://x"),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Malformed,
  );
});

// ── command inputs carry conditional headers ────────────────────────────────

test("putCreate issues PutObject with exact input {Bucket,Key,ContentType,IfNoneMatch,Body}", async () => {
  const { deps, commands } = makeMockDeps({
    onSend: async () => ({ $metadata: { httpStatusCode: 200 }, ETag: '"new"' }),
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  const r = await store.putCreate("k", enc.encode("v"));
  assert.equal(r.etag, '"new"');
  const put = commands.find((c) => c.type === "PutObject")!;
  assert.equal(put.input.IfNoneMatch, "*");
  assert.equal(put.input.IfMatch, undefined);
  assert.equal(put.input.Bucket, "b");
  assert.equal(put.input.Key, "k");
  assert.equal(put.input.ContentType, "application/json");
  assert.deepEqual(put.input.Body, enc.encode("v"));
});

test("putImmutable also uses IfNoneMatch:*", async () => {
  const { deps, commands } = makeMockDeps({
    onSend: async () => ({ $metadata: { httpStatusCode: 200 }, ETag: '"x"' }),
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  await store.putImmutable("k", enc.encode("v"));
  const put = commands.find((c) => c.type === "PutObject")!;
  assert.equal(put.input.IfNoneMatch, "*");
});

test("putCompareAndSwap issues PutObject with IfMatch:<opaque etag> preserving quotes", async () => {
  const { deps, commands } = makeMockDeps({
    onSend: async () => ({ $metadata: { httpStatusCode: 200 }, ETag: '"v2"' }),
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  await store.putCompareAndSwap("k", enc.encode("v"), '"v1-quoted"');
  const put = commands.find((c) => c.type === "PutObject")!;
  assert.equal(put.input.IfMatch, '"v1-quoted"', "etag echoed back verbatim (quoted)");
  assert.equal(put.input.IfNoneMatch, undefined);
});

test("get issues GetObject with exact {Bucket,Key} and returns bytes/text + opaque ETag", async () => {
  const { deps, commands } = makeMockDeps({
    onSend: async () => ({
      $metadata: { httpStatusCode: 200 },
      ETag: '"abc"',
      Body: {
        transformToByteArray: async () => enc.encode("hello"),
        transformToString: async () => "hello",
      },
    }),
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  const got = await store.get("k");
  assert.equal(got.text, "hello");
  assert.equal(got.etag, '"abc"');
  const get = commands.find((c) => c.type === "GetObject")!;
  assert.deepEqual(get.input, { Bucket: "b", Key: "k" });
});

test("head issues HeadObject with exact {Bucket,Key}", async () => {
  const { deps, commands } = makeMockDeps({
    onSend: async () => ({ $metadata: { httpStatusCode: 200 }, ETag: '"h"' }),
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  const r = await store.head("k");
  assert.equal(r.etag, '"h"');
  const head = commands.find((c) => c.type === "HeadObject")!;
  assert.deepEqual(head.input, { Bucket: "b", Key: "k" });
});

test("health issues HeadBucket and maps success/failure", async () => {
  let fail = false;
  const { deps, commands } = makeMockDeps({
    onSend: async () => {
      if (fail) {
        const err = Object.assign(new Error("no"), { $metadata: { httpStatusCode: 403 } });
        throw err;
      }
      return { $metadata: { httpStatusCode: 200 } };
    },
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  assert.equal(await store.health(), true);
  assert.equal(commands.some((c) => c.type === "HeadBucket"), true);
  fail = true;
  assert.equal(await store.health(), false);
});

// ── request-scoped server-Date capture ──────────────────────────────────────

test("Date-capture middleware records the server Date header (request-scoped)", async () => {
  const when = "Tue, 15 Nov 1994 08:12:31 GMT";
  const { deps } = makeMockDeps({
    onSend: async () => ({ $metadata: { httpStatusCode: 200 }, ETag: '"e"' }),
    responseFor: () => ({ headers: { date: when } }),
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  const r = await store.putCreate("k", enc.encode("v"));
  assert.equal(r.serverDateMs, Date.parse(when));
});

test("Date-capture is case-insensitive and null when header absent", async () => {
  const when = "Tue, 15 Nov 1994 08:12:31 GMT";
  const { deps } = makeMockDeps({
    onSend: async () => ({ $metadata: { httpStatusCode: 200 }, ETag: '"e"' }),
    responseFor: (c): { headers?: Record<string, string> } =>
      c.type === "HeadObject" ? { headers: { DATE: when } } : { headers: {} },
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  const withDate = await store.head("k");
  assert.equal(withDate.serverDateMs, Date.parse(when));
  const put = await store.putCreate("k", enc.encode("v"));
  assert.equal(put.serverDateMs, null, "no Date header → null (conservative fallback)");
});

test("concurrent sends do not cross-contaminate captured Date", async () => {
  const d1 = "Tue, 15 Nov 1994 08:12:31 GMT";
  const d2 = "Wed, 16 Nov 1994 09:13:32 GMT";
  const { deps } = makeMockDeps({
    onSend: async () => ({ $metadata: { httpStatusCode: 200 }, ETag: '"e"' }),
    responseFor: (c) =>
      c.input.Key === "a" ? { headers: { date: d1 } } : { headers: { date: d2 } },
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  const [ra, rb] = await Promise.all([
    store.head("a"),
    store.head("bb"),
  ]);
  assert.equal(ra.serverDateMs, Date.parse(d1));
  assert.equal(rb.serverDateMs, Date.parse(d2));
});

// ── error normalization ─────────────────────────────────────────────────────

async function expectKind(fn: () => Promise<unknown>, kind: StoreErrorKind) {
  await assert.rejects(fn, (e: unknown) => e instanceof StoreError && e.kind === kind);
}

test("error normalization: 404 → NotFound, 412 → PreconditionFailed, 409 → Conflict, 403 → AuthFailed, 500 → Unreachable", async () => {
  const cases: Array<[number, StoreErrorKind]> = [
    [404, StoreErrorKind.NotFound],
    [412, StoreErrorKind.PreconditionFailed],
    [409, StoreErrorKind.Conflict],
    [403, StoreErrorKind.AuthFailed],
    [401, StoreErrorKind.AuthFailed],
    [500, StoreErrorKind.Unreachable],
    [503, StoreErrorKind.Unreachable],
  ];
  for (const [status, kind] of cases) {
    const { deps } = makeMockDeps({
      onSend: async () => {
        throw Object.assign(new Error("x"), { $metadata: { httpStatusCode: status } });
      },
    });
    const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
    await expectKind(() => store.get("k"), kind);
  }
});

test("error normalization: SDK error names without status map correctly", async () => {
  const cases: Array<[string, StoreErrorKind]> = [
    ["NoSuchKey", StoreErrorKind.NotFound],
    ["NotFound", StoreErrorKind.NotFound],
    ["PreconditionFailed", StoreErrorKind.PreconditionFailed],
    ["ConditionalRequestConflict", StoreErrorKind.Conflict],
    ["AccessDenied", StoreErrorKind.AuthFailed],
    ["InvalidAccessKeyId", StoreErrorKind.AuthFailed],
    ["SignatureDoesNotMatch", StoreErrorKind.AuthFailed],
  ];
  for (const [name, kind] of cases) {
    const { deps } = makeMockDeps({
      onSend: async () => {
        throw Object.assign(new Error("x"), { name, $metadata: {} });
      },
    });
    const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
    await expectKind(() => store.get("k"), kind);
  }
});

test("error normalization: network error (no status) → Unreachable", async () => {
  const { deps } = makeMockDeps({
    onSend: async () => {
      throw Object.assign(new Error("ECONNREFUSED"), { $metadata: {} });
    },
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  await expectKind(() => store.head("k"), StoreErrorKind.Unreachable);
});

test("get with empty body → Malformed", async () => {
  const { deps } = makeMockDeps({
    onSend: async () => ({ $metadata: { httpStatusCode: 200 }, ETag: '"e"' }),
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  await expectKind(() => store.get("k"), StoreErrorKind.Malformed);
});

test("get missing ETag → Malformed", async () => {
  const { deps } = makeMockDeps({
    onSend: async () => ({
      $metadata: { httpStatusCode: 200 },
      Body: { transformToByteArray: async () => enc.encode("x"), transformToString: async () => "x" },
    }),
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  await expectKind(() => store.get("k"), StoreErrorKind.Malformed);
});

test("delete swallows NotFound and transient failures", async () => {
  const { deps } = makeMockDeps({
    onSend: async () => {
      throw Object.assign(new Error("gone"), { $metadata: { httpStatusCode: 404 } });
    },
  });
  const store = new S3ConditionalObjectStore({ bucket: "b" }, deps);
  await store.delete("k"); // must not throw
});

// ── credential handling ──────────────────────────────────────────────────────

test("credentials are passed to the SDK client config (with session token) but never exposed via toJSON", () => {
  const { deps, clientConfigs } = makeMockDeps({ onSend: async () => ({ $metadata: {} }) });
  const store = new S3ConditionalObjectStore(
    {
      bucket: "b",
      region: "auto",
      endpoint: "r2.example.com",
      forcePathStyle: true,
      credentials: {
        accessKeyId: "AKIA_SECRET_ID",
        secretAccessKey: "SUPER_SECRET_KEY",
        sessionToken: "SESSION_TOKEN",
      },
    },
    deps,
  );
  // Config forwarded to SDK carries creds.
  const cfg = clientConfigs[0]!;
  assert.equal((cfg.credentials as { accessKeyId: string }).accessKeyId, "AKIA_SECRET_ID");
  assert.equal((cfg.credentials as { sessionToken: string }).sessionToken, "SESSION_TOKEN");
  assert.equal(cfg.forcePathStyle, true);
  assert.equal(cfg.endpoint, "https://r2.example.com");

  // toJSON never surfaces credentials.
  const json = JSON.stringify(store);
  assert.ok(!json.includes("SUPER_SECRET_KEY"));
  assert.ok(!json.includes("AKIA_SECRET_ID"));
  assert.ok(!json.includes("SESSION_TOKEN"));

  // No own-enumerable property holds the credentials either.
  const dump = JSON.stringify(Object.entries(store as unknown as Record<string, unknown>));
  assert.ok(!dump.includes("SUPER_SECRET_KEY"));
});

test("endpoint isolation: two stores with different endpoints/credentials do not share client config", () => {
  const { deps, clientConfigs } = makeMockDeps({ onSend: async () => ({ $metadata: {} }) });
  new S3ConditionalObjectStore(
    { bucket: "b1", endpoint: "one.example.com", credentials: { accessKeyId: "A", secretAccessKey: "s1" } },
    deps,
  );
  new S3ConditionalObjectStore(
    { bucket: "b2", endpoint: "two.example.com", credentials: { accessKeyId: "B", secretAccessKey: "s2" } },
    deps,
  );
  assert.equal(clientConfigs[0]!.endpoint, "https://one.example.com");
  assert.equal(clientConfigs[1]!.endpoint, "https://two.example.com");
  assert.equal((clientConfigs[0]!.credentials as { accessKeyId: string }).accessKeyId, "A");
  assert.equal((clientConfigs[1]!.credentials as { accessKeyId: string }).accessKeyId, "B");
});

test("constructor rejects missing bucket", () => {
  const { deps } = makeMockDeps({ onSend: async () => ({ $metadata: {} }) });
  assert.throws(
    () => new S3ConditionalObjectStore({ bucket: "" }, deps),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Malformed,
  );
});

// ── runtime smoke: real SDK resolves and constructs without network ──────────

test("runtime smoke: createS3Deps dynamically imports real @aws-sdk/client-s3 and constructs a store", async () => {
  const deps = await createS3Deps();
  assert.equal(typeof deps.makeClient, "function");
  assert.equal(typeof deps.PutObjectCommand, "function");
  // Construct against the REAL SDK client with dummy creds — no network I/O.
  const store = new S3ConditionalObjectStore(
    {
      bucket: "smoke-bucket",
      region: "us-east-1",
      endpoint: "https://s3.example.invalid",
      forcePathStyle: true,
      credentials: { accessKeyId: "AKIA_DUMMY", secretAccessKey: "dummy-secret" },
    },
    deps,
  );
  // Building a real command exercises the real constructor + input typing.
  const cmd = new deps.PutObjectCommand({
    Bucket: "smoke-bucket",
    Key: "k",
    Body: enc.encode("v"),
    IfNoneMatch: "*",
  });
  assert.equal(cmd.input.IfNoneMatch, "*");
  assert.ok(cmd.middlewareStack, "real command exposes a middleware stack");
  // toJSON stays credential-free even with the real client wired up.
  assert.ok(!JSON.stringify(store).includes("dummy-secret"));
});
