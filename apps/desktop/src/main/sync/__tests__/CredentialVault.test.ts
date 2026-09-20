import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeCredentialVault,
  SafeStorageCredentialVault,
  type SafeStorageLike,
} from "../CredentialVault.ts";

/** Reversible XOR "encryption" — enough to prove the vault never stores plaintext. */
function fakeSafeStorage(available = true): SafeStorageLike {
  const KEY = 0x5a;
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) =>
      Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ KEY)),
    decryptString: (buf: Buffer) =>
      Buffer.from([...buf].map((b) => b ^ KEY)).toString("utf8"),
  };
}

test("FakeCredentialVault stores, reads, has, deletes, lists", async () => {
  const v = new FakeCredentialVault();
  assert.equal(await v.get("k"), null);
  assert.equal(await v.has("k"), false);
  await v.set("k", "secret-value");
  assert.equal(await v.get("k"), "secret-value");
  assert.equal(await v.has("k"), true);
  assert.deepEqual(await v.names(), ["k"]);
  await v.delete("k");
  assert.equal(await v.has("k"), false);
});

test("SafeStorageCredentialVault throws when encryption unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-vault-"));
  assert.throws(
    () => new SafeStorageCredentialVault(join(dir, "v.vault"), fakeSafeStorage(false)),
    /secure storage is unavailable/i,
  );
});

test("SafeStorageCredentialVault never writes plaintext + persists across instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-vault-"));
  const file = join(dir, "v.vault");
  const v1 = new SafeStorageCredentialVault(file, fakeSafeStorage());
  await v1.set("kopiaPassword", "PLAINTEXTSECRET");

  // The plaintext must not appear on disk.
  const onDisk = readFileSync(file, "utf8");
  assert.equal(onDisk.includes("PLAINTEXTSECRET"), false, "plaintext leaked to disk");

  // 0600 permissions (owner-only).
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);

  // A fresh instance decrypts the same value (persistence).
  const v2 = new SafeStorageCredentialVault(file, fakeSafeStorage());
  assert.equal(await v2.get("kopiaPassword"), "PLAINTEXTSECRET");
});

test("SafeStorageCredentialVault delete + has", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-vault-"));
  const v = new SafeStorageCredentialVault(join(dir, "v.vault"), fakeSafeStorage());
  await v.set("a", "1234");
  await v.set("b", "5678");
  assert.deepEqual((await v.names()).sort(), ["a", "b"]);
  await v.delete("a");
  assert.equal(await v.has("a"), false);
  assert.equal(await v.get("b"), "5678");
});
