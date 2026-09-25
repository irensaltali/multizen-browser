import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";
import {
  CredentialBundleError,
  documentKey,
  openCredentialBundle,
  parseCredentialsDocument,
  type SyncObjectStore,
  type TrustEntry,
} from "@multizen/mcp-gateway";

import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { CredentialSync, CREDENTIALS_DOCUMENT } from "../CredentialSync.ts";
import { projectSecretName, projectTokenName } from "../GatewayVault.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

/**
 * The credential bundle is the only synced document MultiZen cannot read on its
 * own. These tests hold the two secrets apart on purpose: every device here has
 * the bucket and the repository password, so anything they can or cannot see is
 * attributable to the bundle passphrase alone.
 */

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";
const PASSPHRASE = "a sufficiently long bundle passphrase";
const OTHER_PASSPHRASE = "a completely different passphrase";

/** A value distinctive enough to grep the whole bucket for. */
const SECRET_VALUE = "sk-canary-upstream-key-9f3a";
const KOPIA_VALUE = "kopia-repo-password-canary";
const S3_KEY_VALUE = "AKIA-canary-access-key";

/** The settings-configured credential refs that must never be backed up. */
const EXCLUDED = ["kopiaPassword", "s3AccessKeyId", "s3SecretAccessKey"];

function sharedStore(): InMemoryConditionalObjectStore {
  return new InMemoryConditionalObjectStore();
}

function asSync(store: InMemoryConditionalObjectStore): SyncObjectStore {
  return store as unknown as SyncObjectStore;
}

interface Device {
  dir: string;
  svc: GatewayService;
  ctl: GatewayController;
  vault: MemoryVault;
  creds: CredentialSync;
  cleanup: () => void;
}

async function device(
  store: InMemoryConditionalObjectStore,
  vault = new MemoryVault(),
  password = PASSWORD,
): Promise<Device> {
  const dir = mkdtempSync(join(tmpdir(), "gw-cred-"));
  const svc = new GatewayService({
    dataDir: dir,
    vault,
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    autoSync: { intervalMs: 0 },
    syncMaterials: async () => ({
      store: asSync(store),
      controlPrefix: PREFIX,
      password,
      deviceId: "d",
    }),
  });
  await svc.start();
  const ctl = new GatewayController(svc, {
    baseUrl: svc.baseUrl,
    routesServed: () => true,
  });
  return {
    dir,
    svc,
    ctl,
    vault,
    creds: new CredentialSync({
      service: svc,
      vault: svc.vaultAdapter,
      excludedNames: () => EXCLUDED,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A project whose single server needs `${NAME}` before it can start. */
async function seedSecretProject(
  ctl: GatewayController,
  id: string,
  envName: string,
): Promise<void> {
  const created = await ctl.createProject({ id, enabled: true });
  assert.ok(created.ok, `createProject ${id}: ${JSON.stringify(created)}`);
  const added = await ctl.addServer(id, {
    transport: "stdio",
    id: "srv",
    command: "echo",
    args: [],
    env: { TOKEN: `\${${envName}}` },
  });
  assert.ok(added.ok, `addServer ${id}: ${JSON.stringify(added)}`);
}

/**
 * Establish the trust registry from `admin` and approve every listed device.
 * De-duplicates, so passing a single device is a valid "trust only me".
 */
async function trust(admin: Device, ...others: Device[]): Promise<void> {
  const bridge = admin.svc.syncBridge;
  assert.ok(bridge, "the admin device must have a composed sync bridge");
  await bridge.ensureTrustRegistry();
  const entries = new Map<string, TrustEntry>();
  for (const d of [admin, ...others]) {
    const k = await d.svc.vaultAdapter.getOrCreateSigningKey();
    entries.set(k.deviceId, {
      deviceId: k.deviceId,
      publicKeyHex: k.publicKeyHex,
      role: "trusted",
    } as TrustEntry);
  }
  await bridge.approveDevice([...entries.values()]);
}

/** Every byte currently in the bucket, for canary sweeps. */
async function allBytes(store: InMemoryConditionalObjectStore): Promise<string> {
  const s = asSync(store);
  const page = await s.list("");
  let out = "";
  for (const k of page.keys)
    out += `\n${k}\n${Buffer.from((await s.get(k)).bytes).toString("latin1")}`;
  return out;
}

/** The raw credentials document as stored. */
async function remoteDocument(store: InMemoryConditionalObjectStore): Promise<unknown> {
  const key = documentKey(PREFIX, "shared", CREDENTIALS_DOCUMENT);
  const got = await asSync(store).get(key);
  return JSON.parse(Buffer.from(got.bytes).toString("utf8")) as unknown;
}

/**
 * The published credentials document, decrypted through `d` and parsed.
 * `expectFresh: false` so reading for an assertion never trips the rollback
 * guard on a revision this device has already applied.
 */
async function publishedDocument(d: Device) {
  const read = await d.svc.readDocument<unknown>("shared", CREDENTIALS_DOCUMENT, {
    expectFresh: false,
  });
  assert.equal(read?.kind, "loaded", `credentials document unreadable: ${JSON.stringify(read)}`);
  return parseCredentialsDocument(read?.kind === "loaded" ? read.document.value : null);
}

function phaseOf(svc: GatewayService, projectId: string, serverId: string): string {
  const s = svc.runtime.status().find((x) => x.projectId === projectId && x.serverId === serverId);
  return s?.phase ?? "absent";
}

// ── the headline path ────────────────────────────────────────────────────────

test("a restored secret starts the server that was waiting for it", async () => {
  const store = sharedStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    await seedSecretProject(a.ctl, "proj1", "UPSTREAM_TOKEN");

    // A provides the value and backs it up.
    await a.svc.saveManagedSecret("proj1", "UPSTREAM_TOKEN", SECRET_VALUE);
    const enabled = await a.creds.enable(PASSPHRASE);
    assert.ok(enabled.pushed, `enable should publish: ${JSON.stringify(enabled)}`);

    // B receives the project through normal config sync, and is stuck: the
    // reference cannot resolve, so the server is held visible-inactive.
    await b.svc.syncNow();
    assert.equal(phaseOf(b.svc, "proj1", "srv"), "env-error");

    // The passphrase is the only thing B is missing.
    const restored = await b.creds.restore(PASSPHRASE);
    assert.equal(restored.reason, undefined);
    assert.equal(restored.restored, 1);
    assert.deepEqual(restored.projects, ["proj1"]);
    assert.equal(
      await b.svc.vaultAdapter.getManagedSecret("proj1", "UPSTREAM_TOKEN"),
      SECRET_VALUE,
    );

    // And the restore's own reconcile started it — no explicit restart.
    assert.notEqual(phaseOf(b.svc, "proj1", "srv"), "env-error");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("the repository password and bucket access are not enough to read a secret", async () => {
  const store = sharedStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    await seedSecretProject(a.ctl, "proj1", "UPSTREAM_TOKEN");
    await a.svc.saveManagedSecret("proj1", "UPSTREAM_TOKEN", SECRET_VALUE);
    await a.creds.enable(PASSPHRASE);

    // B holds the repository password (same `PASSWORD`) and a trusted key, so it
    // can decrypt the document envelope. What it gets is still ciphertext.
    const read = await b.svc.readDocument<unknown>("shared", CREDENTIALS_DOCUMENT);
    assert.equal(read?.kind, "loaded");
    if (read?.kind !== "loaded") return;
    assert.ok(!JSON.stringify(read.document.value).includes(SECRET_VALUE));

    // Nor is the value anywhere in the bucket.
    assert.ok(!(await allBytes(store)).includes(SECRET_VALUE));

    // A wrong passphrase is refused as such, and writes nothing.
    const bad = await b.creds.restore(OTHER_PASSPHRASE);
    assert.equal(bad.reason, "wrong-passphrase");
    assert.equal(bad.restored, 0);
    assert.equal(await b.svc.vaultAdapter.getManagedSecret("proj1", "UPSTREAM_TOKEN"), null);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

// ── off by default ──────────────────────────────────────────────────────────

test("without a passphrase nothing is published at all", async () => {
  const store = sharedStore();
  const a = await device(store);
  try {
    await trust(a);
    await seedSecretProject(a.ctl, "proj1", "UPSTREAM_TOKEN");
    await a.svc.saveManagedSecret("proj1", "UPSTREAM_TOKEN", SECRET_VALUE);

    assert.equal(await a.creds.enabled(), false);
    const push = await a.creds.push();
    assert.deepEqual(push, { pushed: false, entryCount: 0, reason: "disabled" });

    // No credentials document exists, and the secret is nowhere in the bucket.
    await assert.rejects(() => remoteDocument(store));
    assert.ok(!(await allBytes(store)).includes(SECRET_VALUE));

    // reconcile() is equally inert, so app startup does not opt anyone in.
    const rec = await a.creds.reconcile();
    assert.equal(rec.push.reason, "disabled");
    assert.equal(rec.restore.reason, "no-passphrase");
  } finally {
    a.cleanup();
  }
});

test("push and restore are no-ops when Cloud Sync is not composed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-cred-nosync-"));
  const vault = new MemoryVault();
  const svc = new GatewayService({
    dataDir: dir,
    vault,
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    autoSync: { intervalMs: 0 },
  });
  await svc.start();
  const creds = new CredentialSync({
    service: svc,
    vault: svc.vaultAdapter,
    excludedNames: () => EXCLUDED,
  });
  try {
    await svc.vaultAdapter.setBundlePassphrase(PASSPHRASE);
    assert.equal((await creds.push()).reason, "not-syncing");
    assert.equal((await creds.restore()).reason, "not-syncing");
    assert.equal((await creds.status()).remotePresent, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── what may and may not travel ─────────────────────────────────────────────

test("bucket credentials and the device key never enter the bundle", async () => {
  const store = sharedStore();
  const a = await device(store);
  try {
    await trust(a);
    await seedSecretProject(a.ctl, "proj1", "UPSTREAM_TOKEN");
    await a.svc.saveManagedSecret("proj1", "UPSTREAM_TOKEN", SECRET_VALUE);
    // The same vault holds Cloud Sync's own secrets, as it does in production.
    await a.vault.set("kopiaPassword", KOPIA_VALUE);
    await a.vault.set("s3AccessKeyId", S3_KEY_VALUE);
    await a.vault.set("s3SecretAccessKey", "s3-canary-secret");
    await a.creds.enable(PASSPHRASE);

    const doc = await publishedDocument(a);
    assert.ok(doc.bundle, "a bundle should be published");
    const opened = await openCredentialBundle(PASSPHRASE, doc.bundle, {
      excludedNames: EXCLUDED,
    });
    assert.deepEqual(
      opened.entries.map((e) => e.name),
      [projectSecretName("proj1", "UPSTREAM_TOKEN")],
    );

    // And the excluded values appear nowhere in the bucket, sealed or otherwise.
    const bytes = await allBytes(store);
    for (const leak of [KOPIA_VALUE, S3_KEY_VALUE, "s3-canary-secret", PASSPHRASE]) {
      assert.ok(!bytes.includes(leak), `bucket leaked ${leak}`);
    }
    // Including the device signing key, whose PEM is in the same vault.
    const pem = await a.vault.get("mcp-gateway:device-signing-key-pem");
    assert.ok(pem, "precondition: a signing key exists");
    assert.ok(!bytes.includes(pem.split("\n")[1] ?? "IMPOSSIBLE"));
  } finally {
    a.cleanup();
  }
});

test("a project bearer token is carried so external agent configs keep working", async () => {
  const store = sharedStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    await seedSecretProject(a.ctl, "proj1", "UPSTREAM_TOKEN");
    const minted = await a.ctl.generateToken("proj1");
    assert.ok(minted.ok);
    const token = minted.ok ? minted.value.token : "";
    await a.creds.enable(PASSPHRASE);

    await b.svc.syncNow();
    const restored = await b.creds.restore(PASSPHRASE);
    assert.ok(restored.restored >= 1);
    assert.equal(await b.svc.vaultAdapter.getProjectToken("proj1"), token);
    assert.ok(!(await allBytes(store)).includes(token), "the token itself never hits the wire");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

// ── merge semantics: the backup must not eat itself ─────────────────────────

test("a device without a project leaves that project's secrets in the backup", async () => {
  const store = sharedStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    // A owns proj1 and backs up its secret.
    await seedSecretProject(a.ctl, "proj1", "A_TOKEN");
    await a.svc.saveManagedSecret("proj1", "A_TOKEN", "value-from-a");
    await a.creds.enable(PASSPHRASE);

    // B is a device that has NOT taken proj1's secret into its own vault. If push
    // published only the local vault, B would wipe A's entry — a backup feature
    // destroying the backup.
    await b.svc.vaultAdapter.setBundlePassphrase(PASSPHRASE);
    await seedSecretProject(b.ctl, "proj2", "B_TOKEN");
    await b.svc.saveManagedSecret("proj2", "B_TOKEN", "value-from-b");
    const push = await b.creds.push();
    assert.ok(push.pushed, JSON.stringify(push));

    const doc = await publishedDocument(a);
    assert.ok(doc.bundle);
    const opened = await openCredentialBundle(PASSPHRASE, doc.bundle, {
      excludedNames: EXCLUDED,
    });
    assert.deepEqual(opened.entries, [
      { name: projectSecretName("proj1", "A_TOKEN"), value: "value-from-a" },
      { name: projectSecretName("proj2", "B_TOKEN"), value: "value-from-b" },
    ]);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("deleting a secret on the device that owns the project removes it from the backup", async () => {
  const store = sharedStore();
  const a = await device(store);
  try {
    await trust(a);
    await seedSecretProject(a.ctl, "proj1", "A_TOKEN");
    await a.svc.saveManagedSecret("proj1", "A_TOKEN", "value-from-a");
    await a.creds.enable(PASSPHRASE);

    await a.svc.deleteManagedSecret("proj1", "A_TOKEN");
    const push = await a.creds.push();
    assert.ok(push.pushed, JSON.stringify(push));
    assert.equal(push.entryCount, 0);

    const doc = await publishedDocument(a);
    assert.ok(doc.bundle);
    const opened = await openCredentialBundle(PASSPHRASE, doc.bundle, {
      excludedNames: EXCLUDED,
    });
    assert.deepEqual(opened.entries, []);
  } finally {
    a.cleanup();
  }
});

test("deleting a project purges its secrets from the backup", async () => {
  const store = sharedStore();
  const a = await device(store);
  try {
    await trust(a);
    await seedSecretProject(a.ctl, "proj1", "A_TOKEN");
    await seedSecretProject(a.ctl, "proj2", "B_TOKEN");
    await a.svc.saveManagedSecret("proj1", "A_TOKEN", "value-one");
    await a.svc.saveManagedSecret("proj2", "B_TOKEN", "value-two");
    await a.creds.enable(PASSPHRASE);

    // A deleted project stops being "held here", which is indistinguishable from
    // "never had it" — so the removal has to be stated, and it is.
    await a.svc.removeConfig("proj1");
    const push = await a.creds.push({ purgeProjects: ["proj1"] });
    assert.ok(push.pushed, JSON.stringify(push));

    const doc = await publishedDocument(a);
    assert.ok(doc.bundle);
    const opened = await openCredentialBundle(PASSPHRASE, doc.bundle, {
      excludedNames: EXCLUDED,
    });
    assert.deepEqual(
      opened.entries.map((e) => e.name),
      [projectSecretName("proj2", "B_TOKEN")],
    );
  } finally {
    a.cleanup();
  }
});

// ── refusing to clobber ─────────────────────────────────────────────────────

test("a device with the wrong passphrase cannot overwrite someone else's bundle", async () => {
  const store = sharedStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    await seedSecretProject(a.ctl, "proj1", "A_TOKEN");
    await a.svc.saveManagedSecret("proj1", "A_TOKEN", SECRET_VALUE);
    await a.creds.enable(PASSPHRASE);

    // B is trusted and holds the repository password, but its bundle passphrase
    // differs. Overwriting here would lock A out of its own credentials.
    await b.svc.vaultAdapter.setBundlePassphrase(OTHER_PASSPHRASE);
    const push = await b.creds.push();
    assert.deepEqual(push, { pushed: false, entryCount: 0, reason: "remote-unreadable" });

    // A's bundle is untouched and still opens.
    const doc = await publishedDocument(a);
    assert.ok(doc.bundle);
    const opened = await openCredentialBundle(PASSPHRASE, doc.bundle, {
      excludedNames: EXCLUDED,
    });
    assert.deepEqual(opened.entries, [
      { name: projectSecretName("proj1", "A_TOKEN"), value: SECRET_VALUE },
    ]);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a failed enable does not leave the device half-enabled", async () => {
  const store = sharedStore();
  const a = await device(store);
  const b = await device(store);
  try {
    await trust(a, b);
    await seedSecretProject(a.ctl, "proj1", "A_TOKEN");
    await a.svc.saveManagedSecret("proj1", "A_TOKEN", SECRET_VALUE);
    await a.creds.enable(PASSPHRASE);

    const outcome = await b.creds.enable(OTHER_PASSPHRASE);
    assert.equal(outcome.reason, "remote-unreadable");
    // Rolled back: B is off, not silently stuck unable to publish.
    assert.equal(await b.creds.enabled(), false);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("an untrusted device's credentials document is refused, not opened", async () => {
  const store = sharedStore();
  const a = await device(store);
  const b = await device(store);
  try {
    // A establishes the registry and trusts only itself.
    const bridge = a.svc.syncBridge;
    assert.ok(bridge);
    await bridge.ensureTrustRegistry();

    // B publishes a bundle without ever being approved.
    await seedSecretProject(b.ctl, "proj1", "A_TOKEN");
    await b.svc.saveManagedSecret("proj1", "A_TOKEN", SECRET_VALUE);
    await b.svc.vaultAdapter.setBundlePassphrase(PASSPHRASE);
    await b.creds.push();

    await a.svc.vaultAdapter.setBundlePassphrase(PASSPHRASE);
    const restore = await a.creds.restore();
    assert.equal(restore.reason, "rejected");
    assert.equal(restore.rejection?.code, "unknown-signer");
    assert.equal(restore.restored, 0);
    assert.deepEqual((await a.creds.status()).remoteIssue, {
      code: "unknown-signer",
      reason: `Unknown signer ${(await b.svc.vaultAdapter.getOrCreateSigningKey()).deviceId}`,
      signer: (await b.svc.vaultAdapter.getOrCreateSigningKey()).deviceId,
    });
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("an admin can explicitly replace an orphaned credential document from its local vault", async () => {
  const store = sharedStore();
  const current = await device(store);
  const orphaned = await device(store);
  const receiver = await device(store);
  try {
    // The current Mac is the new trust root. An older installation publishes a
    // credential document whose signing key is no longer in that registry.
    await trust(current);
    await seedSecretProject(orphaned.ctl, "proj1", "A_TOKEN");
    await orphaned.svc.saveManagedSecret("proj1", "A_TOKEN", "stale-secret");
    await orphaned.svc.vaultAdapter.setBundlePassphrase(PASSPHRASE);
    assert.equal((await orphaned.creds.push()).pushed, true);

    await seedSecretProject(current.ctl, "proj1", "A_TOKEN");
    await current.svc.saveManagedSecret("proj1", "A_TOKEN", SECRET_VALUE);
    await current.svc.vaultAdapter.setBundlePassphrase(PASSPHRASE);
    assert.equal((await current.creds.status()).remoteIssue?.code, "unknown-signer");

    const replaced = await current.creds.replaceRejectedRemote();
    assert.deepEqual(replaced, { pushed: true, entryCount: 1 });
    assert.equal((await current.creds.status()).remoteIssue, null);

    await seedSecretProject(receiver.ctl, "proj1", "A_TOKEN");
    const restored = await receiver.creds.restore(PASSPHRASE);
    assert.equal(restored.restored, 1);
    assert.equal(
      await receiver.vault.get(projectSecretName("proj1", "A_TOKEN")),
      SECRET_VALUE,
    );
  } finally {
    current.cleanup();
    orphaned.cleanup();
    receiver.cleanup();
  }
});

// ── churn and switching off ─────────────────────────────────────────────────

test("an unchanged bundle does not burn a revision", async () => {
  const store = sharedStore();
  const a = await device(store);
  try {
    await trust(a);
    await seedSecretProject(a.ctl, "proj1", "A_TOKEN");
    await a.svc.saveManagedSecret("proj1", "A_TOKEN", SECRET_VALUE);
    await a.creds.enable(PASSPHRASE);

    const first = await remoteDocument(store);
    const again = await a.creds.push();
    assert.deepEqual(again, { pushed: false, entryCount: 1, reason: "unchanged" });
    // A fresh salt and nonce per seal mean identical contents still produce
    // different ciphertext, so "unchanged" has to be decided on the plaintext.
    assert.deepEqual(await remoteDocument(store), first);
  } finally {
    a.cleanup();
  }
});

test("disabling replaces the bundle with an explicit null and needs no passphrase", async () => {
  const store = sharedStore();
  const a = await device(store);
  try {
    await trust(a);
    await seedSecretProject(a.ctl, "proj1", "A_TOKEN");
    await a.svc.saveManagedSecret("proj1", "A_TOKEN", SECRET_VALUE);
    await a.creds.enable(PASSPHRASE);
    assert.ok((await allBytes(store)).length > 0);

    // Forget the passphrase first: an operator who has lost it must still be able
    // to switch the feature off.
    await a.svc.vaultAdapter.clearBundlePassphrase();
    const off = await a.creds.disable();
    assert.deepEqual(off, { purged: true });

    const doc = await publishedDocument(a);
    assert.equal(doc.bundle, null);
    assert.equal(await a.creds.enabled(), false);
    assert.equal((await a.creds.status()).remotePresent, false);

    // A restore now reports the purge rather than an error.
    await a.svc.vaultAdapter.setBundlePassphrase(PASSPHRASE);
    assert.equal((await a.creds.restore()).reason, "purged");
    // The local vault keeps its secret: disabling stops backing up, it does not
    // delete the working copy.
    assert.equal(await a.svc.vaultAdapter.getManagedSecret("proj1", "A_TOKEN"), SECRET_VALUE);
  } finally {
    a.cleanup();
  }
});

test("saving a secret notifies the backup exactly once per change", async () => {
  const store = sharedStore();
  const dir = mkdtempSync(join(tmpdir(), "gw-cred-notify-"));
  const calls: Array<{ purgeProjects?: readonly string[] } | undefined> = [];
  const svc = new GatewayService({
    dataDir: dir,
    vault: new MemoryVault(),
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    autoSync: { intervalMs: 0 },
    onSecretsChanged: (change) => calls.push(change),
    syncMaterials: async () => ({
      store: asSync(store),
      controlPrefix: PREFIX,
      password: PASSWORD,
      deviceId: "d",
    }),
  });
  await svc.start();
  const ctl = new GatewayController(svc, { baseUrl: svc.baseUrl, routesServed: () => true });
  try {
    await seedSecretProject(ctl, "proj1", "A_TOKEN");
    assert.equal(calls.length, 0, "creating a project touches no credential");

    await svc.saveManagedSecret("proj1", "A_TOKEN", SECRET_VALUE);
    await svc.rotateProjectToken("proj1");
    await svc.deleteManagedSecret("proj1", "A_TOKEN");
    assert.deepEqual(calls, [undefined, undefined, undefined]);

    // Project deletion is the one case that must name what to purge.
    await svc.removeConfig("proj1");
    assert.deepEqual(calls.at(-1), { purgeProjects: ["proj1"] });
    assert.equal(calls.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the vault boundary ──────────────────────────────────────────────────────

test("the vault refuses to write a credential a bundle may not carry", async () => {
  // A restore already re-validates every entry before it gets here, so this check
  // is a second line rather than the only one. It is tested directly because a
  // defence that only ever runs behind another one is exactly the kind that rots
  // unnoticed: removing it breaks no end-to-end test.
  const store = sharedStore();
  const a = await device(store);
  try {
    const v = a.svc.vaultAdapter;
    const scope = { excludedNames: EXCLUDED };

    await assert.rejects(
      () => v.writeBundleableCredential("mcp-gateway:device-signing-key-pem", "x", scope),
      (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
    );
    await assert.rejects(
      () => v.writeBundleableCredential("kopiaPassword", KOPIA_VALUE, scope),
      (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
    );
    await assert.rejects(
      () => v.writeBundleableCredential("some-other-secret", "x", scope),
      (e: unknown) => e instanceof CredentialBundleError && e.code === "not-bundleable",
    );
    // Nothing was written by any of the refused calls.
    assert.deepEqual(
      (await a.vault.names()).filter((n) => n === "kopiaPassword" || n === "some-other-secret"),
      [],
    );

    // And an eligible name still works.
    await v.writeBundleableCredential(projectTokenName("proj1"), "tok", scope);
    assert.equal(await v.getProjectToken("proj1"), "tok");
  } finally {
    a.cleanup();
  }
});

test("the passphrase itself is never bundleable", async () => {
  const store = sharedStore();
  const a = await device(store);
  try {
    await a.svc.vaultAdapter.setBundlePassphrase(PASSPHRASE);
    // Present in the vault, but absent from everything a bundle would collect.
    assert.ok(await a.svc.vaultAdapter.hasBundlePassphrase());
    const names = await a.svc.vaultAdapter.bundleableNames({ excludedNames: EXCLUDED });
    assert.ok(!names.some((n) => n.includes("credential-bundle-passphrase")));
    await assert.rejects(
      () =>
        a.svc.vaultAdapter.writeBundleableCredential(
          "mcp-gateway:credential-bundle-passphrase",
          PASSPHRASE,
          { excludedNames: EXCLUDED },
        ),
      (e: unknown) => e instanceof CredentialBundleError && e.code === "excluded",
    );
  } finally {
    a.cleanup();
  }
});

test("enabling is all or nothing: a non-publishing outcome leaves the device off", async () => {
  // Reporting failure while quietly switching on would leave the UI showing
  // "off" and the backend behaving as "on". Every reason that is not a publish
  // (or an already-identical publish) must roll the passphrase back out.
  const dir = mkdtempSync(join(tmpdir(), "gw-cred-allornothing-"));
  const svc = new GatewayService({
    dataDir: dir,
    vault: new MemoryVault(),
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    autoSync: { intervalMs: 0 },
    // No syncMaterials: there is nowhere to publish.
  });
  await svc.start();
  const creds = new CredentialSync({
    service: svc,
    vault: svc.vaultAdapter,
    excludedNames: () => EXCLUDED,
  });
  try {
    const outcome = await creds.enable(PASSPHRASE);
    assert.equal(outcome.pushed, false);
    assert.equal(outcome.reason, "not-syncing");
    assert.equal(await creds.enabled(), false);
    assert.equal(await svc.vaultAdapter.hasBundlePassphrase(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enabling twice with the same passphrase stays on", async () => {
  // `unchanged` is success, not failure: an identical bundle is already published,
  // which is the desired end state. Rolling back here would switch the operator
  // off for doing nothing wrong.
  const store = sharedStore();
  const a = await device(store);
  try {
    await trust(a);
    await seedSecretProject(a.ctl, "proj1", "A_TOKEN");
    await a.svc.saveManagedSecret("proj1", "A_TOKEN", SECRET_VALUE);
    assert.ok((await a.creds.enable(PASSPHRASE)).pushed);

    const again = await a.creds.enable(PASSPHRASE);
    assert.equal(again.pushed, false);
    assert.equal(again.reason, "unchanged");
    assert.equal(await a.creds.enabled(), true);
  } finally {
    a.cleanup();
  }
});
