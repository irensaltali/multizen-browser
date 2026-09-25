import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalize } from "../canonicalJson.js";
import {
  CryptoError,
  DEFAULT_ARGON2ID_KDF,
  DEFAULT_KDF,
  generateSaltHex,
  kdfJson,
  open,
  openAsync,
  seal,
  sealAsync,
  type Argon2idKdfParams,
  type CryptoEnvelope,
} from "./crypto.js";

const PW = "correct horse battery staple";
const enc = new TextEncoder();
const dec = new TextDecoder();

test("seal then open round-trips with the same password + salt", () => {
  const salt = generateSaltHex();
  const env = seal(PW, enc.encode("hello world"), { saltHex: salt, context: "proj" });
  const out = open(PW, env, "proj");
  assert.equal(dec.decode(out), "hello world");
});

test("wrong password fails authentication (never returns plaintext)", () => {
  const salt = generateSaltHex();
  const env = seal(PW, enc.encode("secret"), { saltHex: salt, context: "proj" });
  assert.throws(
    () => open("wrong password", env, "proj"),
    (e: unknown) => e instanceof CryptoError && e.code === "auth",
  );
});

test("tampered ciphertext fails authentication", () => {
  const salt = generateSaltHex();
  const env = seal(PW, enc.encode("secret"), { saltHex: salt, context: "proj" });
  const ctBytes = Buffer.from(env.ciphertext, "base64");
  ctBytes[0] = ctBytes[0]! ^ 0xff;
  const tampered: CryptoEnvelope = { ...env, ciphertext: ctBytes.toString("base64") };
  assert.throws(
    () => open(PW, tampered, "proj"),
    (e: unknown) => e instanceof CryptoError && e.code === "auth",
  );
});

test("tampered auth tag fails authentication", () => {
  const salt = generateSaltHex();
  const env = seal(PW, enc.encode("secret"), { saltHex: salt, context: "proj" });
  const tagBytes = Buffer.from(env.tag, "base64");
  tagBytes[0] = tagBytes[0]! ^ 0x01;
  const tampered: CryptoEnvelope = { ...env, tag: tagBytes.toString("base64") };
  assert.throws(
    () => open(PW, tampered, "proj"),
    (e: unknown) => e instanceof CryptoError && e.code === "auth",
  );
});

test("header tamper (salt) invalidates via AAD", () => {
  const salt = generateSaltHex();
  const env = seal(PW, enc.encode("secret"), { saltHex: salt, context: "proj" });
  const other = generateSaltHex();
  const tampered: CryptoEnvelope = {
    ...env,
    header: { ...env.header, saltHex: other },
  };
  // Different salt derives a different key AND breaks the AAD binding.
  assert.throws(() => open(PW, tampered, "proj"), (e: unknown) => e instanceof CryptoError);
});

test("context mismatch is rejected (record substitution defense)", () => {
  const salt = generateSaltHex();
  const env = seal(PW, enc.encode("secret"), { saltHex: salt, context: "projA" });
  assert.throws(
    () => open(PW, env, "projB"),
    (e: unknown) => e instanceof CryptoError && e.code === "auth",
  );
});

test("nonces are unique per seal", () => {
  const salt = generateSaltHex();
  const a = seal(PW, enc.encode("x"), { saltHex: salt, context: "p" });
  const b = seal(PW, enc.encode("x"), { saltHex: salt, context: "p" });
  assert.notEqual(a.header.nonceHex, b.header.nonceHex);
  // Same plaintext under distinct nonces yields distinct ciphertext.
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("password/derived key never appear in the serialized envelope (secret canary)", () => {
  const salt = generateSaltHex();
  const env = seal(PW, enc.encode("secret-value-xyz"), { saltHex: salt, context: "p" });
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes(PW));
  assert.ok(!serialized.includes("secret-value-xyz"));
});

test("fresh device with only password + salt can decrypt", () => {
  const salt = generateSaltHex();
  const env = seal(PW, enc.encode("state-across-devices"), { saltHex: salt, context: "p" });
  // Simulate a fresh device: no shared memory, only PW + the envelope (which
  // carries the salt in its header).
  const wire = JSON.parse(JSON.stringify(env)) as CryptoEnvelope;
  const out = open(PW, wire, "p");
  assert.equal(dec.decode(out), "state-across-devices");
});


// ── Argon2id KDF ─────────────────────────────────────────────────────────────

/** Deliberately cheap so the suite is fast; production uses DEFAULT_ARGON2ID_KDF. */
const CHEAP_ARGON2: Argon2idKdfParams = {
  algorithm: "argon2id",
  memoryKib: 64,
  iterations: 1,
  parallelism: 1,
  keyLenBytes: 32,
};

test("argon2id round-trips through sealAsync/openAsync", async () => {
  const salt = generateSaltHex();
  const env = await sealAsync(PW, enc.encode("bundle contents"), {
    saltHex: salt,
    context: "bundle",
    kdf: CHEAP_ARGON2,
  });
  assert.equal(env.header.kdf.algorithm, "argon2id");
  const out = await openAsync(PW, env, "bundle");
  assert.equal(dec.decode(out), "bundle contents");
});

test("argon2id rejects the wrong password with auth (never returns plaintext)", async () => {
  const env = await sealAsync(PW, enc.encode("secret"), {
    saltHex: generateSaltHex(),
    context: "bundle",
    kdf: CHEAP_ARGON2,
  });
  await assert.rejects(
    () => openAsync("not the password", env, "bundle"),
    (e: unknown) => e instanceof CryptoError && e.code === "auth",
  );
});

test("the synchronous seal refuses argon2id rather than silently downgrading", () => {
  assert.throws(
    () =>
      seal(PW, enc.encode("x"), {
        saltHex: generateSaltHex(),
        context: "bundle",
        kdf: CHEAP_ARGON2,
      }),
    (e: unknown) => e instanceof CryptoError && e.code === "params",
  );
});

test("the synchronous open refuses an argon2id envelope", async () => {
  const env = await sealAsync(PW, enc.encode("x"), {
    saltHex: generateSaltHex(),
    context: "bundle",
    kdf: CHEAP_ARGON2,
  });
  assert.throws(
    () => open(PW, env, "bundle"),
    (e: unknown) => e instanceof CryptoError && e.code === "params",
  );
});

test("sealAsync with the default KDF is wire-compatible with the sync open", async () => {
  // The async path must not have forked the format: an envelope written by
  // sealAsync must still be readable by every existing scrypt caller.
  const env = await sealAsync(PW, enc.encode("legacy readable"), {
    saltHex: generateSaltHex(),
    context: "p",
  });
  assert.equal(env.header.kdf.algorithm, "scrypt");
  assert.equal(dec.decode(open(PW, env, "p")), "legacy readable");
});

test("scrypt kdf canonicalization is byte-identical to the pre-argon2id format", () => {
  // Records already in a bucket were signed over these exact bytes. If this
  // string changes, every stored envelope becomes unverifiable.
  assert.equal(
    canonicalize(kdfJson(DEFAULT_KDF)),
    '{"algorithm":"scrypt","keyLenBytes":32,"n":32768,"p":1,"r":8}',
  );
});

test("an attacker-supplied memory cost is capped rather than attempted", async () => {
  const env = await sealAsync(PW, enc.encode("x"), {
    saltHex: generateSaltHex(),
    context: "bundle",
    kdf: CHEAP_ARGON2,
  });
  // 4 GiB of memory requested by a header found in an untrusted bucket.
  // (Written as a product, not `1 << 32`, which wraps to 1 in 32-bit JS shifts.)
  const hostile: CryptoEnvelope = {
    ...env,
    header: { ...env.header, kdf: { ...CHEAP_ARGON2, memoryKib: 4 * 1024 * 1024 } },
  };
  await assert.rejects(
    () => openAsync(PW, hostile, "bundle"),
    (e: unknown) =>
      e instanceof CryptoError &&
      e.code === "params" &&
      /memoryKib 4194304 exceeds cap 1048576/.test(e.message),
  );
});

test("an attacker-supplied iteration count is capped", async () => {
  const env = await sealAsync(PW, enc.encode("x"), {
    saltHex: generateSaltHex(),
    context: "bundle",
    kdf: CHEAP_ARGON2,
  });
  const hostile: CryptoEnvelope = {
    ...env,
    header: { ...env.header, kdf: { ...CHEAP_ARGON2, iterations: 1_000_000 } },
  };
  await assert.rejects(
    () => openAsync(PW, hostile, "bundle"),
    (e: unknown) =>
      e instanceof CryptoError &&
      e.code === "params" &&
      /iterations 1000000 exceeds cap/.test(e.message),
  );
});

test("argon2id requires memoryKib >= 8*parallelism (RFC 9106)", async () => {
  await assert.rejects(
    () =>
      sealAsync(PW, enc.encode("x"), {
        saltHex: generateSaltHex(),
        context: "bundle",
        kdf: { ...CHEAP_ARGON2, parallelism: 4, memoryKib: 16 },
      }),
    (e: unknown) => e instanceof CryptoError && e.code === "params",
  );
});

test("rewriting an argon2id header to scrypt does not yield plaintext", async () => {
  const env = await sealAsync(PW, enc.encode("secret"), {
    saltHex: generateSaltHex(),
    context: "bundle",
    kdf: CHEAP_ARGON2,
  });
  const downgraded: CryptoEnvelope = {
    ...env,
    header: { ...env.header, kdf: DEFAULT_KDF },
  };
  // Different KDF derives a different key and changes the AAD, so the tag fails.
  await assert.rejects(
    () => openAsync(PW, downgraded, "bundle"),
    (e: unknown) => e instanceof CryptoError && e.code === "auth",
  );
});

test("argon2id passphrase never appears in the serialized envelope (secret canary)", async () => {
  const env = await sealAsync(PW, enc.encode("secret-value-xyz"), {
    saltHex: generateSaltHex(),
    context: "bundle",
    kdf: CHEAP_ARGON2,
  });
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes(PW));
  assert.ok(!serialized.includes("secret-value-xyz"));
});

test("hash-wasm computes RFC 9106 Argon2id (cross-checked against OpenSSL)", async () => {
  // This vector was produced independently by `openssl kdf ... ARGON2ID`
  // (OpenSSL 3.6.3) and by hash-wasm, and the two agreed byte for byte. Pinning
  // it here means a dependency swap or downgrade that computes something else —
  // and would therefore make every existing bundle unopenable — fails loudly.
  const { argon2id } = await import("hash-wasm");
  const derived = await argon2id({
    password: Buffer.from("correct horse battery staple", "utf8"),
    salt: new Uint8Array(32).fill(0x07),
    iterations: 3,
    parallelism: 1,
    memorySize: 65536,
    hashLength: 32,
    outputType: "binary",
  });
  assert.equal(
    Buffer.from(derived as Uint8Array).toString("hex"),
    "a946e7002480e5e1a79524aee83439e85f78bbe4837183d7b66ed45adcd48261",
  );
});

test("the production argon2id profile is m=64MiB t=3 p=1 and works end to end", async () => {
  assert.deepEqual(DEFAULT_ARGON2ID_KDF, {
    algorithm: "argon2id",
    memoryKib: 65536,
    iterations: 3,
    parallelism: 1,
    keyLenBytes: 32,
  });
  const env = await sealAsync(PW, enc.encode("real profile"), {
    saltHex: generateSaltHex(),
    context: "bundle",
    kdf: DEFAULT_ARGON2ID_KDF,
  });
  assert.equal(dec.decode(await openAsync(PW, env, "bundle")), "real profile");
});
