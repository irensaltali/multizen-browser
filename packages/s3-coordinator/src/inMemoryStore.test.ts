import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryConditionalObjectStore } from "./inMemoryStore.js";
import { StoreError, StoreErrorKind } from "./store.js";
import { runCapabilityProbe } from "./capability.js";

const enc = new TextEncoder();

test("putCreate then get: read-after-write consistency + opaque quoted etag", async () => {
  const store = new InMemoryConditionalObjectStore({ nowMs: 1000 });
  const put = await store.putCreate("k", enc.encode("v1"));
  assert.match(put.etag, /^".*"$/, "etag is quoted/opaque");
  const got = await store.get("k");
  assert.equal(got.text, "v1");
  assert.equal(got.etag, put.etag);
  assert.equal(got.serverDateMs, 1000);
});

test("putCreate: duplicate precondition-fails (412)", async () => {
  const store = new InMemoryConditionalObjectStore();
  await store.putCreate("k", enc.encode("v1"));
  await assert.rejects(
    () => store.putCreate("k", enc.encode("v2")),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.PreconditionFailed,
  );
});

test("get/head: NotFound for absent key", async () => {
  const store = new InMemoryConditionalObjectStore();
  await assert.rejects(
    () => store.get("missing"),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.NotFound,
  );
  await assert.rejects(
    () => store.head("missing"),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.NotFound,
  );
});

test("CAS: succeeds on match, fails on stale etag, changes etag", async () => {
  const store = new InMemoryConditionalObjectStore();
  const a = await store.putCreate("k", enc.encode("v1"));
  const b = await store.putCompareAndSwap("k", enc.encode("v2"), a.etag);
  assert.notEqual(a.etag, b.etag);
  await assert.rejects(
    () => store.putCompareAndSwap("k", enc.encode("v3"), a.etag),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.PreconditionFailed,
  );
});

test("exposeServerDate=false yields null server date", async () => {
  const store = new InMemoryConditionalObjectStore({ exposeServerDate: false });
  await store.putCreate("k", enc.encode("v"));
  const got = await store.get("k");
  assert.equal(got.serverDateMs, null);
});

test("fault injection: one-shot injected error then recovery", async () => {
  const store = new InMemoryConditionalObjectStore();
  store.injectFault({ op: "put", kind: StoreErrorKind.Conflict });
  await assert.rejects(
    () => store.putCreate("k", enc.encode("v")),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Conflict,
  );
  // fault consumed → next put works
  await store.putCreate("k", enc.encode("v"));
  assert.ok(store.has("k"));
});

test("delete: best-effort swallows injected faults and NotFound", async () => {
  const store = new InMemoryConditionalObjectStore();
  await store.delete("nope"); // no throw
  await store.putCreate("k", enc.encode("v"));
  store.injectFault({ op: "delete", kind: StoreErrorKind.Unreachable });
  await store.delete("k"); // swallowed
});

test("barrier: parks an operation until released (deterministic race)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const gate = store.gate("put", (k) => k === "k");
  const p = store.putCreate("k", enc.encode("v"));
  await gate.reached; // op is parked
  assert.ok(!store.has("k"), "not written while parked");
  gate.release();
  await p;
  assert.ok(store.has("k"));
});

test("capability probe: passes against a compliant store", async () => {  const store = new InMemoryConditionalObjectStore();
  const r = await runCapabilityProbe(store, "control");
  assert.equal(r.ok, true);
  // cleanup happened
  assert.equal(store.keys().filter((k) => k.startsWith("control/capabilities/")).length, 0);
});

test("capability probe: fails when store ignores If-None-Match", async () => {
  // A non-compliant store whose putCreate always succeeds (overwrites),
  // simulating a gateway that ignores If-None-Match.
  const store = new InMemoryConditionalObjectStore();
  const broken = Object.create(store) as typeof store;
  broken.putCreate = async (key: string, body: Uint8Array) => forceWrite(store, key, body);
  const r = await runCapabilityProbe(broken, "control");
  assert.equal(r.ok, false);
  assert.equal(r.failedCheck, "duplicate-create-precondition");
});

test("capability probe: fails when store ignores If-Match (stale CAS succeeds)", async () => {
  const store = new InMemoryConditionalObjectStore();
  const broken = Object.create(store) as typeof store;
  // CAS always succeeds regardless of etag → stale CAS won't precondition-fail.
  broken.putCompareAndSwap = async (key: string, body: Uint8Array) => forceWrite(store, key, body);
  const r = await runCapabilityProbe(broken, "control");
  assert.equal(r.ok, false);
  assert.equal(r.failedCheck, "stale-cas-precondition");
});

test("capability probe: reports unreachable without failing capability semantics", async () => {
  const store = new InMemoryConditionalObjectStore();
  store.injectFault({ op: "put", kind: StoreErrorKind.Unreachable });
  const r = await runCapabilityProbe(store, "control");
  assert.equal(r.ok, false);
  assert.equal(r.failedCheck, "unreachable");
  assert.match(r.message ?? "", /^Unreachable:/);
});

// helper: force an unconditional write bypassing preconditions
function forceWrite(
  store: InMemoryConditionalObjectStore,
  key: string,
  body: Uint8Array,
): { etag: string; serverDateMs: number | null } {
  const objects = (store as unknown as { objects: Map<string, { bytes: Uint8Array; etag: string }> })
    .objects;
  const etag = `"forced-${Math.random()}"`;
  objects.set(key, { bytes: body.slice(), etag });
  return { etag, serverDateMs: store.now() };
}

// ── list (prefix pagination) ────────────────────────────────────────────────

test("list: returns keys under prefix in lexical order, ignores others", async () => {
  const store = new InMemoryConditionalObjectStore();
  await store.putCreate("p/b", enc.encode("1"));
  await store.putCreate("p/a", enc.encode("1"));
  await store.putCreate("other/x", enc.encode("1"));
  const page = await store.list("p/");
  assert.deepEqual(page.keys, ["p/a", "p/b"]);
  assert.equal(page.nextContinuationToken, null);
});

test("list: empty prefix yields empty page + null token", async () => {
  const store = new InMemoryConditionalObjectStore();
  const page = await store.list("nothing/");
  assert.deepEqual(page.keys, []);
  assert.equal(page.nextContinuationToken, null);
});

test("list: paginates via continuation token, covers all keys once", async () => {
  const store = new InMemoryConditionalObjectStore();
  for (let i = 0; i < 5; i++) await store.putCreate(`p/${i}`, enc.encode("x"));
  const seen: string[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const page = await store.list("p/", { maxKeys: 2, continuationToken: token });
    seen.push(...page.keys);
    token = page.nextContinuationToken ?? undefined;
    pages += 1;
    assert.ok(pages <= 10, "pagination must terminate");
  } while (token);
  assert.deepEqual(seen.sort(), ["p/0", "p/1", "p/2", "p/3", "p/4"]);
  assert.equal(new Set(seen).size, seen.length, "no key returned twice");
  assert.ok(pages >= 3, "should have taken multiple pages");
});

test("list: maxKeys clamps to hard cap and truncation is reported", async () => {
  const store = new InMemoryConditionalObjectStore();
  for (let i = 0; i < 4; i++) await store.putCreate(`p/${i}`, enc.encode("x"));
  const page = await store.list("p/", { maxKeys: 2 });
  assert.equal(page.keys.length, 2);
  assert.notEqual(page.nextContinuationToken, null, "truncated → token present");
});

test("list: injected fault propagates as StoreError", async () => {
  const store = new InMemoryConditionalObjectStore();
  store.injectFault({ op: "list", kind: StoreErrorKind.Unreachable });
  await assert.rejects(
    () => store.list("p/"),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Unreachable,
  );
});

// ── deleteStrict ─────────────────────────────────────────────────────────────

test("deleteStrict: removes existing key, idempotent on missing", async () => {
  const store = new InMemoryConditionalObjectStore();
  await store.putCreate("k", enc.encode("v"));
  await store.deleteStrict("k");
  assert.ok(!store.has("k"));
  await store.deleteStrict("k"); // idempotent, no throw
});

test("deleteStrict: injected fault propagates (unlike best-effort delete)", async () => {
  const store = new InMemoryConditionalObjectStore();
  await store.putCreate("k", enc.encode("v"));
  store.injectFault({ op: "delete", kind: StoreErrorKind.Unreachable });
  await assert.rejects(
    () => store.deleteStrict("k"),
    (e: unknown) => e instanceof StoreError && e.kind === StoreErrorKind.Unreachable,
  );
});
