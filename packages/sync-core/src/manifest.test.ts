import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeProxy,
  toManifest,
  assertManifestSafe,
  MANIFEST_VERSION,
  type ProfileManifestInput,
} from "./manifest.js";

function input(over: Partial<ProfileManifestInput> = {}): ProfileManifestInput {
  return {
    id: "p1",
    name: "Amazon US",
    tags: ["shopping"],
    proxy: {
      type: "socks5",
      host: "1.2.3.4",
      port: 1080,
      username: "user",
      password: "s3cr3t",
    },
    fingerprint: { device: "macbook-air-13-m3", seed: "abc" },
    icon: "🛒",
    startUrl: "https://amazon.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    dataDir: "/Users/alice/Library/Application Support/MultiZen/profiles/p1",
    proxyCountry: "US",
    ...over,
  };
}

test("sanitizeProxy: strips username & password, records requiresCredentials", () => {
  const s = sanitizeProxy(input().proxy);
  assert.deepEqual(s, {
    type: "socks5",
    host: "1.2.3.4",
    port: 1080,
    requiresCredentials: true,
  });
});

test("sanitizeProxy: no creds → requiresCredentials false", () => {
  const s = sanitizeProxy({ type: "http", host: "h", port: 8080 });
  assert.equal(s?.requiresCredentials, false);
});

test("sanitizeProxy: undefined proxy → undefined", () => {
  assert.equal(sanitizeProxy(undefined), undefined);
});

test("toManifest: sets manifestVersion and copies non-secret fields", () => {
  const m = toManifest(input());
  assert.equal(m.manifestVersion, MANIFEST_VERSION);
  assert.equal(m.id, "p1");
  assert.equal(m.name, "Amazon US");
  assert.deepEqual(m.tags, ["shopping"]);
  assert.equal(m.icon, "🛒");
  assert.equal(m.startUrl, "https://amazon.com");
  assert.equal(m.proxyCountry, "US");
  assert.deepEqual(m.fingerprint, { device: "macbook-air-13-m3", seed: "abc" });
});

test("toManifest: removes proxy password and username", () => {
  const m = toManifest(input());
  assert.ok(m.proxy);
  const proxyRec = m.proxy as unknown as Record<string, unknown>;
  assert.equal(proxyRec.password, undefined);
  assert.equal(proxyRec.username, undefined);
  assert.equal(m.proxy?.requiresCredentials, true);
});

test("toManifest: never includes dataDir", () => {
  const m = toManifest(input());
  assert.ok(!("dataDir" in m));
  assert.equal(JSON.stringify(m).includes("Library/Application Support"), false);
});

test("toManifest: password value does not appear anywhere in serialized output", () => {
  const m = toManifest(input());
  assert.equal(JSON.stringify(m).includes("s3cr3t"), false);
});

test("toManifest: defaults tags to empty array when absent", () => {
  const m = toManifest(input({ tags: undefined }));
  assert.deepEqual(m.tags, []);
});

test("toManifest: omits optional fields when undefined", () => {
  const m = toManifest(input({ icon: undefined, startUrl: undefined, notes: undefined }));
  assert.ok(!("icon" in m));
  assert.ok(!("startUrl" in m));
  assert.ok(!("notes" in m));
});

test("assertManifestSafe: passes on a clean manifest", () => {
  const m = toManifest(input());
  assert.equal(assertManifestSafe(m), m);
});

test("assertManifestSafe: throws if a password key is present", () => {
  const m = toManifest(input());
  // Tamper: inject a forbidden key into the fingerprint blob.
  (m.fingerprint as Record<string, unknown>).password = "leak";
  assert.throws(() => assertManifestSafe(m), /forbidden key "password"/);
});

test("assertManifestSafe: throws if a dataDir key is present", () => {
  const m = toManifest(input());
  (m as unknown as Record<string, unknown>).dataDir = "/abs/path";
  assert.throws(() => assertManifestSafe(m), /forbidden key "dataDir"/);
});

test("assertManifestSafe: throws if a proxy username leaks", () => {
  const m = toManifest(input());
  (m.proxy as unknown as Record<string, unknown>).username = "user";
  assert.throws(() => assertManifestSafe(m), /username leaked/);
});

test("assertManifestSafe: tolerates cyclic structures without infinite loop", () => {
  const m = toManifest(input());
  const cyc = m.fingerprint as Record<string, unknown>;
  cyc.self = cyc;
  assert.equal(assertManifestSafe(m), m);
});
