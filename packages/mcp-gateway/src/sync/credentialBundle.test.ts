import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";

import { canonicalize, type JsonValue } from "../canonicalJson.js";
import { signTrustRegistry, type TrustEntry, type TrustRegistry } from "../trust.js";
import { InMemoryVault, type SigningKey } from "../vault.js";
import {
  DEFAULT_KDF,
  generateSaltHex,
  sealAsync,
  type Argon2idKdfParams,
} from "./crypto.js";
import {
  assertBundleable,
  assertNotExcluded,
  CREDENTIAL_BUNDLE_CONTEXT,
  CREDENTIAL_BUNDLE_VERSION,
  CredentialBundleError,
  credentialBundleToJson,
  isBundleableCredentialName,
  MAX_CREDENTIAL_BUNDLE_BYTES,
  MAX_CREDENTIAL_NAME_LENGTH,
  MIN_BUNDLE_PASSPHRASE_LENGTH,
  openCredentialBundle,
  parseCredentialBundle,
  sealCredentialBundle,
  selectBundleableNames,
  type CredentialBundle,
} from "./credentialBundle.js";
import { SyncedDocumentStore } from "./documentStore.js";
import type { SyncObjectStore } from "./objectStore.js";

/** Cheap Argon2id so the suite stays fast; one test exercises the real profile. */
const CHEAP: Argon2idKdfParams = {
  algorithm: "argon2id",
  memoryKib: 64,
  iterations: 1,
  parallelism: 1,
  keyLenBytes: 32,
};

const PASSPHRASE = "a sufficiently long bundle passphrase";
const SECRET_A = "mcp-gateway:project-secret:proj1:OPENAI_API_KEY";
const SECRET_B = "mcp-gateway:project-secret:proj1:STRIPE_KEY";
const TOKEN_A = "mcp-gateway:project-token:proj1";
const SIGNING_KEY_NAME = "mcp-gateway:device-signing-key-pem";

const VALUE_A = "sk-canary-openai-0000";
const VALUE_B = "sk-canary-stripe-1111";

function entries() {
  return [
    { name: SECRET_B, value: VALUE_B },
    { name: SECRET_A, value: VALUE_A },
  ];
}

function seal(over: Partial<Parameters<typeof sealCredentialBundle>[2]> = {}) {
  return sealCredentialBundle(PASSPHRASE, entries(), { kdf: CHEAP, now: 1_700_000_000_000, ...over });
}

// ── round trip ───────────────────────────────────────────────────────────────

test("a bundle round-trips and returns entries in a stable order", async () => {
  const bundle = await seal();
  const opened = await openCredentialBundle(PASSPHRASE, bundle);
  assert.equal(opened.bundleVersion, CREDENTIAL_BUNDLE_VERSION);
  assert.equal(opened.sealedAt, 1_700_000_000_000);
  // Sealed out of order above; recovered sorted, so two devices holding the same
  // secrets produce identical plaintext.
  assert.deepEqual(opened.entries, [
    { name: SECRET_A, value: VALUE_A },
    { name: SECRET_B, value: VALUE_B },
  ]);
});

test("the wrong passphrase fails with auth and reveals nothing", async () => {
  const bundle = await seal();
  await assert.rejects(
    () => openCredentialBundle("an entirely different passphrase", bundle),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "auth",
  );
});

test("no secret, name, or passphrase appears in the sealed bundle (canary)", async () => {
  const bundle = await seal();
  const wire = canonicalize(credentialBundleToJson(bundle));
  for (const leak of [VALUE_A, VALUE_B, SECRET_A, SECRET_B, PASSPHRASE, "OPENAI_API_KEY"]) {
    assert.ok(!wire.includes(leak), `bundle leaked ${leak}`);
  }
  // Not even the entry count is in the clear: the only cleartext field is the
  // format version plus the AEAD header.
  assert.deepEqual(Object.keys(JSON.parse(wire) as object).sort(), ["bundleVersion", "sealed"]);
});

test("tampering with the ciphertext fails authentication", async () => {
  const bundle = await seal();
  const ct = Buffer.from(bundle.sealed.ciphertext, "base64");
  ct[0] = ct[0]! ^ 0xff;
  const tampered: CredentialBundle = {
    ...bundle,
    sealed: { ...bundle.sealed, ciphertext: ct.toString("base64") },
  };
  await assert.rejects(
    () => openCredentialBundle(PASSPHRASE, tampered),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "auth",
  );
});

test("a bundle survives the canonicalization its enclosing document applies", async () => {
  const bundle = await seal();
  // A document payload is canonicalized (keys reordered) before it is stored.
  // The AAD is rebuilt from validated fields, not raw key order, so this is safe
  // — but it has to be proven, not assumed.
  const roundTripped = JSON.parse(canonicalize(credentialBundleToJson(bundle))) as unknown;
  const opened = await openCredentialBundle(PASSPHRASE, roundTripped);
  assert.equal(opened.entries.length, 2);
  assert.equal(opened.entries[0]?.value, VALUE_A);
});

test("the production argon2id profile seals and opens a real bundle", async () => {
  const bundle = await sealCredentialBundle(PASSPHRASE, entries());
  assert.equal(bundle.sealed.header.kdf.algorithm, "argon2id");
  const opened = await openCredentialBundle(PASSPHRASE, bundle);
  assert.equal(opened.entries.length, 2);
});

// ── admission control: inclusion allowlist ───────────────────────────────────

test("only the bundleable prefixes are eligible", () => {
  assert.ok(isBundleableCredentialName(SECRET_A));
  assert.ok(isBundleableCredentialName(TOKEN_A));
  assert.ok(!isBundleableCredentialName("kopiaPassword"));
  assert.ok(!isBundleableCredentialName(SIGNING_KEY_NAME));
  assert.ok(!isBundleableCredentialName("mcp-gateway:sync-salt-hex"));
  // A bare prefix names nothing and must not slip through.
  assert.ok(!isBundleableCredentialName("mcp-gateway:project-secret:"));
  assert.ok(!isBundleableCredentialName("mcp-gateway:project-token:"));
});

test("an unrecognised credential is refused as not-bundleable", async () => {
  await assert.rejects(
    () => sealCredentialBundle(PASSPHRASE, [{ name: "kopiaPassword", value: "x" }], { kdf: CHEAP }),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "not-bundleable",
  );
});

test("selectBundleableNames keeps only eligible names, sorted", () => {
  const vault = [
    "s3SecretAccessKey",
    SECRET_B,
    SIGNING_KEY_NAME,
    TOKEN_A,
    "mcp-gateway:sync-salt-hex",
    SECRET_A,
    "kopiaPassword",
  ];
  assert.deepEqual(selectBundleableNames(vault), [SECRET_A, SECRET_B, TOKEN_A]);
});

// ── admission control: explicit exclusions ───────────────────────────────────

test("the device signing key is refused by the exclusion list, not merely by inclusion", async () => {
  // Asserting the exact code matters: this name also fails the inclusion test,
  // so a looser assertion would pass even if the exclusion list were deleted.
  assert.throws(
    () => assertBundleable(SIGNING_KEY_NAME),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
  );
  assert.throws(
    () => assertNotExcluded(SIGNING_KEY_NAME),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
  );
  await assert.rejects(
    () =>
      sealCredentialBundle(PASSPHRASE, [{ name: SIGNING_KEY_NAME, value: "-----BEGIN..." }], {
        kdf: CHEAP,
      }),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
  );
});

test("the sync salt is excluded", () => {
  assert.throws(
    () => assertBundleable("mcp-gateway:sync-salt-hex"),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
  );
});

test("configured bucket-credential refs are excluded even when they look bundleable", async () => {
  // The Kopia/S3 credential names are free-form strings in settings. An operator
  // (or a migration) could set kopiaPasswordRef to something that matches a
  // bundleable prefix; the exclusion list is what stops the password guarding the
  // bucket from being backed up into that same bucket. This is the case the
  // inclusion check cannot catch, which is why the two checks are separate.
  const configured = "mcp-gateway:project-secret:proj1:REPO_PASSWORD";
  assert.ok(isBundleableCredentialName(configured), "precondition: passes inclusion");
  const scope = { excludedNames: [configured, "kopiaPassword", "s3AccessKeyId"] };
  assert.throws(
    () => assertBundleable(configured, scope),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
  );
  await assert.rejects(
    () => sealCredentialBundle(PASSPHRASE, [{ name: configured, value: "pw" }], { ...scope, kdf: CHEAP }),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
  );
  assert.deepEqual(selectBundleableNames([configured, SECRET_A], scope), [SECRET_A]);
});

test("opening re-checks admission, so a trusted-but-compromised writer cannot inject an excluded secret", async () => {
  // Bypass sealCredentialBundle entirely and forge a payload the way a device
  // with the passphrase could. The outer document would be validly signed by a
  // trusted device, so the read path is the only thing standing between this and
  // an overwritten device identity.
  const forged = await sealAsync(
    PASSPHRASE,
    new TextEncoder().encode(
      canonicalize({
        bundleVersion: 1,
        sealedAt: 1,
        entries: [{ name: SIGNING_KEY_NAME, value: "-----BEGIN PRIVATE KEY-----" }],
      } as JsonValue),
    ),
    { saltHex: generateSaltHex(), context: CREDENTIAL_BUNDLE_CONTEXT, kdf: CHEAP },
  );
  const bundle: CredentialBundle = { bundleVersion: 1, sealed: forged };
  await assert.rejects(
    () => openCredentialBundle(PASSPHRASE, bundle),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
  );
});

// ── entry validation ─────────────────────────────────────────────────────────

test("duplicate credential names are refused", async () => {
  await assert.rejects(
    () =>
      sealCredentialBundle(
        PASSPHRASE,
        [
          { name: SECRET_A, value: "one" },
          { name: SECRET_A, value: "two" },
        ],
        { kdf: CHEAP },
      ),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "duplicate",
  );
});

test("a non-string value is refused rather than coerced", async () => {
  await assert.rejects(
    () =>
      sealCredentialBundle(PASSPHRASE, [{ name: SECRET_A, value: 42 as unknown as string }], {
        kdf: CHEAP,
      }),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "invalid-entry",
  );
});

test("an over-long credential name is refused", async () => {
  const long = `mcp-gateway:project-secret:p:${"X".repeat(MAX_CREDENTIAL_NAME_LENGTH)}`;
  await assert.rejects(
    () => sealCredentialBundle(PASSPHRASE, [{ name: long, value: "v" }], { kdf: CHEAP }),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "invalid-entry",
  );
});

test("an empty value is preserved, not dropped", async () => {
  // A vault entry that genuinely holds "" must survive a round trip; silently
  // dropping it would make a restored device differ from the one backed up.
  const bundle = await sealCredentialBundle(PASSPHRASE, [{ name: SECRET_A, value: "" }], {
    kdf: CHEAP,
  });
  const opened = await openCredentialBundle(PASSPHRASE, bundle);
  assert.deepEqual(opened.entries, [{ name: SECRET_A, value: "" }]);
});

test("a passphrase below the floor is refused before any sealing happens", async () => {
  const short = "x".repeat(MIN_BUNDLE_PASSPHRASE_LENGTH - 1);
  await assert.rejects(
    () => sealCredentialBundle(short, entries(), { kdf: CHEAP }),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "weak-passphrase",
  );
});

test("a bundle larger than the cap is refused", async () => {
  const big = [
    { name: SECRET_A, value: "x".repeat(MAX_CREDENTIAL_BUNDLE_BYTES + 1) },
  ];
  await assert.rejects(
    () => sealCredentialBundle(PASSPHRASE, big, { kdf: CHEAP }),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "too-large",
  );
});

// ── structural parsing ───────────────────────────────────────────────────────

test("a scrypt-sealed bundle is refused: the KDF cannot be downgraded", async () => {
  const downgraded = await sealAsync(PASSPHRASE, new TextEncoder().encode("{}"), {
    saltHex: generateSaltHex(),
    context: CREDENTIAL_BUNDLE_CONTEXT,
    kdf: DEFAULT_KDF,
  });
  assert.throws(
    () => parseCredentialBundle({ bundleVersion: 1, sealed: downgraded }),
    (e: unknown) =>
      e instanceof CredentialBundleError &&
      e.code === "malformed" &&
      /argon2id/.test(e.message),
  );
});

test("an oversized ciphertext is refused before the key derivation is attempted", async () => {
  const bundle = await seal();
  const oversized = {
    ...bundle,
    sealed: {
      ...bundle.sealed,
      ciphertext: Buffer.alloc(MAX_CREDENTIAL_BUNDLE_BYTES + 1).toString("base64"),
    },
  };
  await assert.rejects(
    () => openCredentialBundle(PASSPHRASE, oversized),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "too-large",
  );
});

test("structurally invalid input is malformed, not an auth failure", async () => {
  for (const bad of [null, 42, "nope", {}, { bundleVersion: 2 }, { bundleVersion: 1 }]) {
    await assert.rejects(
      () => openCredentialBundle(PASSPHRASE, bad),
      (e: unknown) => e instanceof CredentialBundleError && e.code === "malformed",
      `expected malformed for ${JSON.stringify(bad)}`,
    );
  }
});

test("a hostile envelope header reports malformed rather than blaming the passphrase", async () => {
  const bundle = await seal();
  const hostile = {
    ...bundle,
    sealed: {
      ...bundle.sealed,
      header: { ...bundle.sealed.header, kdf: { ...CHEAP, memoryKib: 4 * 1024 * 1024 } },
    },
  };
  // An operator told "wrong passphrase" here would retype it forever; the real
  // problem is a bogus object in the bucket.
  await assert.rejects(
    () => openCredentialBundle(PASSPHRASE, hostile),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "malformed",
  );
});

// ── composition with the synced document layer ───────────────────────────────

const REPO_PASSWORD = "operator-encryption-password";

async function device(store: SyncObjectStore, saltHex: string): Promise<{
  key: SigningKey;
  docs: SyncedDocumentStore;
}> {
  const key = await new InMemoryVault().getOrCreateSigningKey();
  return {
    key,
    docs: new SyncedDocumentStore({
      store,
      controlPrefix: "repo/control",
      password: REPO_PASSWORD,
      saltHex,
      signingKey: key,
    }),
  };
}

async function registryFor(admin: SigningKey, ...others: SigningKey[]): Promise<TrustRegistry> {
  const all: TrustEntry[] = [admin, ...others].map((k) => ({
    deviceId: k.deviceId,
    publicKeyHex: k.publicKeyHex,
    role: "trusted" as const,
  }));
  return signTrustRegistry(admin, 1, all);
}

test("a bundle published as a document is readable on a second device and needs the passphrase", async () => {
  const inner = new InMemoryConditionalObjectStore();
  const store = inner as unknown as SyncObjectStore;
  const salt = generateSaltHex();
  const a = await device(store, salt);
  const b = await device(store, salt);
  const registry = await registryFor(a.key, b.key);

  const bundle = await seal();
  const published = await a.docs.publish(
    "shared",
    "credentials",
    credentialBundleToJson(bundle),
    1,
  );
  assert.equal(published.kind, "published");

  // Device B has the bucket credentials, the repository password, and a trusted
  // signing key. It can read the document...
  const read = await b.docs.read<unknown>("shared", "credentials", registry);
  assert.equal(read.kind, "loaded");
  if (read.kind !== "loaded") return;

  // ...and what it gets is still ciphertext. This is the property the whole
  // design exists for: repository password + bucket access is not enough.
  const asJson = JSON.stringify(read.document.value);
  assert.ok(!asJson.includes(VALUE_A));
  assert.ok(!asJson.includes(SECRET_A));
  await assert.rejects(
    () => openCredentialBundle("guessed wrong", read.document.value),
    (e: unknown) => e instanceof CredentialBundleError && e.code === "auth",
  );

  // With the passphrase, B recovers exactly what A sealed.
  const opened = await openCredentialBundle(PASSPHRASE, read.document.value);
  assert.deepEqual(opened.entries, [
    { name: SECRET_A, value: VALUE_A },
    { name: SECRET_B, value: VALUE_B },
  ]);
});

test("nothing readable reaches the object store bytes (end-to-end canary)", async () => {
  const inner = new InMemoryConditionalObjectStore();
  const store = inner as unknown as SyncObjectStore;
  const a = await device(store, generateSaltHex());
  await a.docs.publish("shared", "credentials", credentialBundleToJson(await seal()), 1);

  // Scan every byte the store holds, not just the record we think we wrote.
  const page = await store.list("");
  assert.ok(page.keys.length > 0, "precondition: something was stored");
  for (const k of page.keys) {
    const raw = Buffer.from((await store.get(k)).bytes).toString("latin1");
    for (const leak of [VALUE_A, VALUE_B, SECRET_A, SECRET_B, PASSPHRASE, "OPENAI_API_KEY"]) {
      assert.ok(!raw.includes(leak), `${k} leaked ${leak}`);
    }
  }
});
