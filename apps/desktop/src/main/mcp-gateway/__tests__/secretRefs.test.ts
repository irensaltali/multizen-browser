import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { GatewayVault } from "../GatewayVault.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

const SECRET = "sk-super-secret-value-9f3a";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mz-secret-"));
}

function makeService(
  dataDir: string,
  opts: {
    vault?: MemoryVault;
    env?: Record<string, string | undefined>;
  } = {},
) {
  return new GatewayService({
    dataDir,
    vault: opts.vault ?? new MemoryVault(),
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    envSource: opts.env ?? {},
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
  });
}

function makeController(svc: GatewayService): GatewayController {
  return new GatewayController(svc, {
    baseUrl: svc.baseUrl,
    routesServed: () => true,
  });
}

/** A project with one stdio server referencing ${API_TOKEN}. */
async function seedProject(ctl: GatewayController): Promise<void> {
  const created = await ctl.createProject({ id: "proj", enabled: true });
  assert.equal(created.ok, true);
  const added = await ctl.addServer("proj", {
    transport: "stdio",
    id: "srv",
    command: "echo",
    args: [],
    env: { API_TOKEN: "${API_TOKEN}" },
  });
  assert.equal(added.ok, true);
}

test("an unapproved environment variable is reported absent even when it exists", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir, { env: { API_TOKEN: SECRET } });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);

    const refs = await ctl.secretRefs("proj");
    assert.equal(refs.ok, true);
    if (refs.ok) {
      assert.equal(refs.value.length, 1);
      const r = refs.value[0];
      assert.equal(r?.name, "API_TOKEN");
      assert.equal(r?.approved, false);
      assert.equal(r?.managed, false);
      assert.equal(r?.present, false, "present only after explicit approval");
      assert.equal(r?.source, null);
    }
    // The server must NOT be running: an unresolved reference fails closed.
    const rt = ctl.runtime("proj");
    assert.equal(rt.ok && rt.value.servers[0]?.phase, "env-error");
    assert.deepEqual(rt.ok ? rt.value.servers[0]?.missingEnv : [], ["API_TOKEN"]);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approving an existing environment variable activates the server", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir, { env: { API_TOKEN: SECRET } });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);
    assert.equal(svc.runtime.hasLiveServer("proj", "srv"), false);

    const approved = await ctl.approveEnvName("API_TOKEN");
    assert.equal(approved.ok, true);

    const refs = await ctl.secretRefs("proj");
    if (refs.ok) {
      assert.equal(refs.value[0]?.approved, true);
      assert.equal(refs.value[0]?.present, true);
      assert.equal(refs.value[0]?.source, "environment");
    }
    assert.equal(svc.runtime.hasLiveServer("proj", "srv"), true, "reconciled + started");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approving a NAME that is absent from the environment keeps the server inactive", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir, { env: {} });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);
    await ctl.approveEnvName("API_TOKEN");

    const refs = await ctl.secretRefs("proj");
    if (refs.ok) {
      assert.equal(refs.value[0]?.approved, true);
      assert.equal(refs.value[0]?.present, false);
      assert.equal(refs.value[0]?.source, null);
    }
    assert.equal(svc.runtime.hasLiveServer("proj", "srv"), false);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving a managed secret activates the server with no environment at all", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir, { env: {} });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);
    assert.equal(svc.runtime.hasLiveServer("proj", "srv"), false);

    const saved = await ctl.saveManagedSecret("proj", "API_TOKEN", SECRET);
    assert.equal(saved.ok, true);
    if (saved.ok) {
      assert.equal(saved.value[0]?.managed, true);
      assert.equal(saved.value[0]?.present, true);
      assert.equal(saved.value[0]?.source, "managed");
      // The returned status must not carry the value anywhere.
      assert.equal(JSON.stringify(saved.value).includes(SECRET), false);
    }
    assert.equal(svc.runtime.hasLiveServer("proj", "srv"), true);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a managed value takes precedence over an approved environment value", async () => {
  const dir = tmp();
  try {
    const envValue = "from-environment";
    const svc = makeService(dir, { env: { API_TOKEN: envValue } });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);
    await ctl.approveEnvName("API_TOKEN");
    await ctl.saveManagedSecret("proj", "API_TOKEN", SECRET);

    const refs = await ctl.secretRefs("proj");
    if (refs.ok) {
      assert.equal(refs.value[0]?.source, "managed", "managed wins");
      assert.equal(refs.value[0]?.approved, true, "approval state is still reported");
    }
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a managed secret deactivates the server when nothing else backs it", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir, { env: {} });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);
    await ctl.saveManagedSecret("proj", "API_TOKEN", SECRET);
    assert.equal(svc.runtime.hasLiveServer("proj", "srv"), true);

    const removed = await ctl.deleteManagedSecret("proj", "API_TOKEN");
    assert.equal(removed.ok, true);
    if (removed.ok) {
      assert.equal(removed.value[0]?.managed, false);
      assert.equal(removed.value[0]?.present, false);
    }
    assert.equal(svc.runtime.hasLiveServer("proj", "srv"), false, "fails closed again");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoking an approval deactivates the server", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir, { env: { API_TOKEN: SECRET } });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);
    await ctl.approveEnvName("API_TOKEN");
    assert.equal(svc.runtime.hasLiveServer("proj", "srv"), true);

    await ctl.revokeEnvName("API_TOKEN");
    assert.equal(svc.runtime.hasLiveServer("proj", "srv"), false);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approvals and managed secrets survive a restart (device-local durability)", async () => {
  const dir = tmp();
  const vault = new MemoryVault();
  try {
    const a = makeService(dir, { vault, env: { OTHER: "x" } });
    await a.start();
    const ctlA = makeController(a);
    await seedProject(ctlA);
    await ctlA.approveEnvName("SOME_NAME");
    await ctlA.saveManagedSecret("proj", "API_TOKEN", SECRET);
    await a.shutdown();

    const b = makeService(dir, { vault, env: { OTHER: "x" } });
    await b.start();
    const ctlB = makeController(b);
    assert.deepEqual(b.workspaces.approvedEnv(), ["SOME_NAME"], "approval persisted");
    const refs = await ctlB.secretRefs("proj");
    if (refs.ok) assert.equal(refs.value[0]?.managed, true, "managed secret persisted");
    assert.equal(b.runtime.hasLiveServer("proj", "srv"), true, "starts on restart");
    await b.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a synced project arriving on a device with no secret stays inactive", async () => {
  const dirA = tmp();
  const dirB = tmp();
  try {
    // Device A provisions the secret and runs the server.
    const a = makeService(dirA, { env: {} });
    await a.start();
    const ctlA = makeController(a);
    await seedProject(ctlA);
    await ctlA.saveManagedSecret("proj", "API_TOKEN", SECRET);
    assert.equal(a.runtime.hasLiveServer("proj", "srv"), true);
    const exported = a.configOf("proj");
    assert.ok(exported);
    await a.shutdown();

    // Device B receives the SAME config (own empty vault + empty environment).
    const b = makeService(dirB, { env: {} });
    await b.start();
    const ctlB = makeController(b);
    await ctlB.createProject({ id: "proj", enabled: true });
    await ctlB.addServer("proj", {
      transport: "stdio",
      id: "srv",
      command: "echo",
      args: [],
      env: { API_TOKEN: "${API_TOKEN}" },
    });
    assert.equal(
      b.runtime.hasLiveServer("proj", "srv"),
      false,
      "the reference does not resolve on a device that never provisioned it",
    );
    const refs = await ctlB.secretRefs("proj");
    if (refs.ok) {
      assert.equal(refs.value[0]?.present, false);
      assert.equal(refs.value[0]?.managed, false);
    }
    await b.shutdown();
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("secret canary: no view, config file, or log line carries the value", async () => {
  const dir = tmp();
  const vault = new MemoryVault();
  const logs: string[] = [];
  try {
    const svc = makeService(dir, { vault, env: { API_TOKEN: SECRET } });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);
    await ctl.approveEnvName("API_TOKEN");
    await ctl.saveManagedSecret("proj", "API_TOKEN", SECRET);

    // Every read-side surface the renderer can reach.
    const surfaces = JSON.stringify([
      await ctl.listProjects(),
      await ctl.getProject("proj"),
      await ctl.secretRefs("proj"),
      await ctl.authStatus("proj"),
      ctl.endpoints("proj"),
      ctl.runtime("proj"),
      ctl.logs("proj", "srv"),
      ctl.conflicts(),
      ctl.quarantine(),
      ctl.syncStatus(),
      logs,
    ]);
    assert.equal(surfaces.includes(SECRET), false, "no IPC surface leaks the value");

    // The persisted project config carries only the ${NAME} reference.
    const { readFileSync } = await import("node:fs");
    const onDisk = readFileSync(join(dir, "mcp-gateway", "projects", "proj.json"), "utf8");
    assert.equal(onDisk.includes(SECRET), false, "signed config has no expanded value");
    assert.equal(onDisk.includes("${API_TOKEN}"), true, "it keeps the reference form");

    // The device-local workspace file must not carry it either.
    const wsPath = join(dir, "mcp-gateway", "workspaces.json");
    const ws = readFileSync(wsPath, "utf8");
    assert.equal(ws.includes(SECRET), false);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed secrets are namespaced per project and purged on deletion", async () => {
  const vault = new MemoryVault();
  const gv = new GatewayVault(vault);
  await gv.setManagedSecret("alpha", "TOKEN", "a-value");
  await gv.setManagedSecret("beta", "TOKEN", "b-value");
  assert.equal(await gv.getManagedSecret("alpha", "TOKEN"), "a-value");
  assert.equal(await gv.getManagedSecret("beta", "TOKEN"), "b-value");
  assert.deepEqual(await gv.managedSecretNames("alpha"), ["TOKEN"]);

  await gv.deleteAllManagedSecrets("alpha");
  assert.equal(await gv.hasManagedSecret("alpha", "TOKEN"), false);
  assert.equal(
    await gv.getManagedSecret("beta", "TOKEN"),
    "b-value",
    "another project's secret is untouched",
  );
});

test("deleting a project purges its managed secrets and bearer token", async () => {
  const dir = tmp();
  const vault = new MemoryVault();
  try {
    const svc = makeService(dir, { vault, env: {} });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);
    await ctl.saveManagedSecret("proj", "API_TOKEN", SECRET);
    await ctl.setAuthEnabled("proj", true);
    await ctl.generateToken("proj");

    const gv = new GatewayVault(vault);
    assert.equal(await gv.hasManagedSecret("proj", "API_TOKEN"), true);
    assert.equal(await gv.hasProjectToken("proj"), true);

    await ctl.deleteProject("proj");
    assert.equal(await gv.hasManagedSecret("proj", "API_TOKEN"), false);
    assert.equal(await gv.hasProjectToken("proj"), false);
    // And nothing secret survives in the raw vault dump.
    assert.equal(JSON.stringify(vault.dump()).includes(SECRET), false);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid reference names and empty values are refused", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir, { env: {} });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);

    const badName = await ctl.saveManagedSecret("proj", "not a name", "x");
    assert.equal(badName.ok, false);
    const empty = await ctl.saveManagedSecret("proj", "API_TOKEN", "");
    assert.equal(empty.ok, false);
    const missingProject = await ctl.saveManagedSecret("nope", "API_TOKEN", "x");
    assert.equal(missingProject.ok, false);
    const badApprove = await ctl.approveEnvName("1BAD");
    assert.equal(badApprove.ok, false);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotating a managed secret restarts the upstream with the new value", async () => {
  const dir = tmp();
  try {
    const seen: string[] = [];
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
      envSource: {},
      makeBoundServer: () => {
        throw new Error("no browser");
      },
      runtimeOptions: {
        stdioFactory: fakeStdioFactory((t) => {
          const v = t.spec.env.API_TOKEN;
          if (v !== undefined) seen.push(v);
        }),
      },
    });
    await svc.start();
    const ctl = makeController(svc);
    await seedProject(ctl);

    await ctl.saveManagedSecret("proj", "API_TOKEN", "first-value");
    await ctl.saveManagedSecret("proj", "API_TOKEN", "second-value");
    assert.deepEqual(seen, ["first-value", "second-value"], "relaunched with the rotated value");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
