import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

const PROFILES = [
  { id: "prof-a", name: "Profile A" },
  { id: "prof-b", name: "Profile B" },
  { id: "prof-c", name: "Profile C" },
];

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "mz-bind-")));
}

function makeService(dataDir: string, vault = new MemoryVault()): GatewayService {
  return new GatewayService({
    dataDir,
    vault,
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    envSource: {},
    listProfiles: () => PROFILES,
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
  });
}

function makeController(svc: GatewayService): GatewayController {
  return new GatewayController(svc, { baseUrl: svc.baseUrl, routesServed: () => true });
}

test("a profile can be bound to one project", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "alpha", enabled: true });

    const bound = await ctl.bindProfile("alpha", "prof-a");
    assert.equal(bound.ok, true, JSON.stringify(bound));
    if (bound.ok) assert.equal(bound.value.browserProfileId, "prof-a");
    assert.equal(svc.projectBoundTo("prof-a"), "alpha");
    assert.equal(svc.projectBoundTo("prof-b"), null);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binding a profile already held by another project is refused with the holder named", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "alpha", enabled: true, browserProfileId: "prof-a" });
    await ctl.createProject({ id: "beta", enabled: true });

    const conflict = await ctl.bindProfile("beta", "prof-a");
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.error.code, "profile-bound:alpha", "the holder is machine-readable");
      assert.match(conflict.error.message, /alpha/);
      assert.match(conflict.error.message, /only one project/i);
    }
    // Neither side changed.
    assert.equal(svc.projectBoundTo("prof-a"), "alpha");
    assert.equal(svc.configOf("beta")?.browserProfileId, undefined);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CREATING a project with an already-bound profile is refused", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "alpha", enabled: true, browserProfileId: "prof-a" });

    const conflict = await ctl.createProject({
      id: "beta",
      enabled: true,
      browserProfileId: "prof-a",
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, "profile-bound:alpha");
    assert.equal(svc.configOf("beta"), null, "the conflicting project was not created");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-binding the SAME profile to the project that already holds it is allowed", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "alpha", enabled: true, browserProfileId: "prof-a" });

    const again = await ctl.bindProfile("alpha", "prof-a");
    assert.equal(again.ok, true, "idempotent self-rebind");
    // And an unrelated update that leaves the binding untouched still works.
    const renamed = await ctl.updateProject("alpha", { label: "Renamed" });
    assert.equal(renamed.ok, true);
    if (renamed.ok) {
      assert.equal(renamed.value.label, "Renamed");
      assert.equal(renamed.value.browserProfileId, "prof-a", "binding preserved");
    }
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unbinding frees the profile for another project", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "alpha", enabled: true, browserProfileId: "prof-a" });
    await ctl.createProject({ id: "beta", enabled: true });

    const unbound = await ctl.bindProfile("alpha", null);
    assert.equal(unbound.ok, true);
    if (unbound.ok) assert.equal(unbound.value.browserProfileId, undefined);
    assert.equal(svc.projectBoundTo("prof-a"), null);

    const rebound = await ctl.bindProfile("beta", "prof-a");
    assert.equal(rebound.ok, true, JSON.stringify(rebound));
    assert.equal(svc.projectBoundTo("prof-a"), "beta");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a project releases its profile", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "alpha", enabled: true, browserProfileId: "prof-a" });
    assert.equal(svc.projectBoundTo("prof-a"), "alpha");

    const deleted = await ctl.deleteProject("alpha");
    assert.equal(deleted.ok, true);
    assert.equal(svc.projectBoundTo("prof-a"), null, "the profile is free again");

    await ctl.createProject({ id: "beta", enabled: true });
    assert.equal((await ctl.bindProfile("beta", "prof-a")).ok, true);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent binds of the same profile: exactly one wins", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "alpha", enabled: true });
    await ctl.createProject({ id: "beta", enabled: true });
    await ctl.createProject({ id: "gamma", enabled: true });

    const results = await Promise.all([
      ctl.bindProfile("alpha", "prof-a"),
      ctl.bindProfile("beta", "prof-a"),
      ctl.bindProfile("gamma", "prof-a"),
    ]);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.equal(winners.length, 1, "exactly one bind succeeded");
    assert.equal(losers.length, 2);
    for (const l of losers) {
      if (!l.ok) assert.match(l.error.code, /^profile-bound:/);
    }
    // The persisted state agrees: exactly one project holds it.
    const holders = ["alpha", "beta", "gamma"].filter(
      (p) => svc.configOf(p)?.browserProfileId === "prof-a",
    );
    assert.deepEqual(holders.length, 1);
    assert.equal(svc.projectBoundTo("prof-a"), holders[0]);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bindableProfiles marks a profile held elsewhere unavailable and names the holder", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "alpha", enabled: true, browserProfileId: "prof-a" });
    await ctl.createProject({ id: "beta", enabled: true, browserProfileId: "prof-b" });

    // From beta's perspective: its OWN profile is selectable, alpha's is not.
    const forBeta = ctl.bindableProfiles("beta");
    assert.equal(forBeta.ok, true);
    if (forBeta.ok) {
      const byId = new Map(forBeta.value.map((p) => [p.profileId, p]));
      assert.equal(byId.get("prof-a")?.available, false);
      assert.equal(byId.get("prof-a")?.boundToProjectId, "alpha");
      assert.equal(byId.get("prof-b")?.available, true, "its own binding stays selectable");
      assert.equal(byId.get("prof-b")?.boundToProjectId, "beta");
      assert.equal(byId.get("prof-c")?.available, true);
      assert.equal(byId.get("prof-c")?.boundToProjectId, undefined);
      assert.equal(byId.get("prof-a")?.name, "Profile A", "names come from the profile store");
    }

    // With no project context, every bound profile is unavailable.
    const generic = ctl.bindableProfiles();
    if (generic.ok) {
      const byId = new Map(generic.value.map((p) => [p.profileId, p]));
      assert.equal(byId.get("prof-a")?.available, false);
      assert.equal(byId.get("prof-b")?.available, false);
      assert.equal(byId.get("prof-c")?.available, true);
    }
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bindings survive a restart and still exclude other projects", async () => {
  const dir = tmp();
  const vault = new MemoryVault();
  try {
    const a = makeService(dir, vault);
    await a.start();
    const ctlA = makeController(a);
    await ctlA.createProject({ id: "alpha", enabled: true, browserProfileId: "prof-a" });
    await a.shutdown();

    const b = makeService(dir, vault);
    await b.start();
    const ctlB = makeController(b);
    assert.equal(b.projectBoundTo("prof-a"), "alpha", "binding reloaded from disk");
    await ctlB.createProject({ id: "beta", enabled: true });
    const conflict = await ctlB.bindProfile("beta", "prof-a");
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, "profile-bound:alpha");
    await b.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a project with no profile store still works (bindableProfiles is empty)", async () => {
  const dir = tmp();
  try {
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      envSource: {},
      makeBoundServer: () => {
        throw new Error("no browser");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
    });
    await svc.start();
    const ctl = makeController(svc);
    const list = ctl.bindableProfiles("any");
    assert.equal(list.ok, true);
    if (list.ok) assert.deepEqual(list.value, []);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projectBoundTo is the single guard a host deletion hook can consult", async () => {
  const dir = tmp();
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "alpha", enabled: true, browserProfileId: "prof-a" });

    // This mirrors index.ts's profileSyncLifecycle.beforeDelete guard.
    const beforeDelete = (profileId: string): void => {
      const holder = svc.projectBoundTo(profileId);
      if (holder) throw new Error(`bound to ${holder}`);
    };
    assert.throws(() => beforeDelete("prof-a"), /bound to alpha/);
    assert.doesNotThrow(() => beforeDelete("prof-c"), "an unbound profile deletes freely");

    // After unbinding, deletion is permitted — we never unbind implicitly.
    await ctl.bindProfile("alpha", null);
    assert.doesNotThrow(() => beforeDelete("prof-a"));
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
