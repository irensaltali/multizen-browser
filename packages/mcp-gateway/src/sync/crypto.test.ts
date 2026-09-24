import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CryptoError,
  generateSaltHex,
  open,
  seal,
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
