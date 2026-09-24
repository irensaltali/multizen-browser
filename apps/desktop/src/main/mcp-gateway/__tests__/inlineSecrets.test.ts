import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StdioTransportSpec } from "@multizen/mcp-gateway";

import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { managedRefName } from "../GatewayVault.ts";
import { fakeStdioFactory, MemoryVault, type FakeUpstream } from "./testSupport.ts";

/**
 * Tests for pasting a raw credential into a server's env/header field.
 *
 * The contract being defended: the value goes into OS secure storage and the
 * project config gets only a `${NAME}` reference, so nothing that is persisted,
 * signed, synced, or written into an agent's config file can carry the secret.
 */

const SECRET = "sk-live-paste-me-8823aa";
const OTHER = "sk-live-second-value-771b";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mz-inline-"));
}

function makeHarness(
  dataDir: string,
  opts: { vault?: MemoryVault; env?: Record<string, string | undefined> } = {},
) {
  const vault = opts.vault ?? new MemoryVault();
  const launched: FakeUpstream[] = [];
  const svc = new GatewayService({
    dataDir,
    vault,
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    envSource: opts.env ?? {},
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory((t) => launched.push(t)) },
  });
  const ctl = new GatewayController(svc, {
    baseUrl: svc.baseUrl,
    routesServed: () => true,
  });
  return { svc, ctl, vault, launched };
}

/** Every file under a directory, as text. */
function allFileContents(dir: string): string {
  let out = "";
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out += readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

test("a pasted value is stored in the vault and the config keeps only a reference", async () => {
  const dir = tmp();
  try {
    const { svc, ctl, vault } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });

    const added = await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });
    assert.equal(added.ok, true);

    const name = managedRefName("docs", "API_TOKEN");
    const config = svc.configOf("proj");
    assert.equal(
      config?.servers[0]?.transport === "stdio" && config.servers[0].env["API_TOKEN"],
      `\${${name}}`,
      "the config holds the reference, not the value",
    );
    assert.equal(await svc.vaultAdapter.getManagedSecret("proj", name), SECRET);

    // The view handed back to the UI carries the reference too.
    assert.equal(
      added.ok &&
        added.value.servers[0]?.transport === "stdio" &&
        added.value.servers[0].env["API_TOKEN"],
      `\${${name}}`,
    );
    // Nothing in the vault is keyed by the plaintext, and no other entry holds it.
    const stored = Object.entries(vault.dump()).filter(([, v]) => v === SECRET);
    assert.equal(stored.length, 1, "exactly one vault entry holds the value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pasted value reaches no file on disk and no IPC view", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    await ctl.addServer("proj", {
      transport: "streamable-http",
      id: "api",
      url: "https://mcp.example.com/mcp",
      secretValues: { Authorization: SECRET },
    });

    assert.ok(
      !allFileContents(dir).includes(SECRET),
      "no persisted project config, state, or workspace file contains the value",
    );

    const surfaces = JSON.stringify([
      await ctl.listProjects(),
      await ctl.getProject("proj"),
      await ctl.secretRefs("proj"),
      ctl.runtime("proj"),
      await ctl.endpoints("proj"),
      await ctl.authStatus("proj"),
    ]);
    assert.ok(!surfaces.includes(SECRET), "no IPC response echoes the value back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stored value is what the server is actually launched with", async () => {
  const dir = tmp();
  try {
    const { svc, ctl, launched } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });

    const spec = launched.at(-1)?.spec as StdioTransportSpec | undefined;
    assert.equal(spec?.env["API_TOKEN"], SECRET, "resolved at launch, from the vault");
    const rt = ctl.runtime("proj");
    assert.equal(rt.ok && rt.value.servers[0]?.phase, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reference shows as managed, and never exposes a read-back", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });

    const refs = await ctl.secretRefs("proj");
    assert.equal(refs.ok, true);
    if (refs.ok) {
      assert.equal(refs.value.length, 1);
      assert.equal(refs.value[0]?.name, managedRefName("docs", "API_TOKEN"));
      assert.equal(refs.value[0]?.managed, true);
      assert.equal(refs.value[0]?.present, true);
      assert.equal(refs.value[0]?.source, "managed");
      assert.ok(!("value" in (refs.value[0] as object)), "there is no value field to read");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-pasting a value overwrites one entry instead of orphaning a trail", async () => {
  const dir = tmp();
  try {
    const { svc, ctl, vault } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    const base = {
      transport: "stdio" as const,
      id: "docs",
      command: "echo",
      args: [] as string[],
    };
    await ctl.addServer("proj", { ...base, secretValues: { API_TOKEN: SECRET } });
    await ctl.updateServer("proj", { ...base, secretValues: { API_TOKEN: OTHER } });

    const name = managedRefName("docs", "API_TOKEN");
    assert.equal(await svc.vaultAdapter.getManagedSecret("proj", name), OTHER);
    assert.deepEqual(await svc.vaultAdapter.managedSecretNames("proj"), [name]);
    assert.ok(
      !Object.values(vault.dump()).includes(SECRET),
      "the replaced value is gone, not left behind under a second name",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edit that omits the value keeps the stored credential", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    const name = managedRefName("docs", "API_TOKEN");
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });

    // The UI round-trips the reference it was given, with no secretValues.
    const updated = await ctl.updateServer("proj", {
      transport: "stdio",
      id: "docs",
      label: "Docs lookup",
      command: "echo",
      args: [],
      env: { API_TOKEN: `\${${name}}` },
    });
    assert.equal(updated.ok, true);
    assert.equal(
      await svc.vaultAdapter.getManagedSecret("proj", name),
      SECRET,
      "editing an unrelated field must not wipe the credential",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dropping the reference prunes its stored value", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    const name = managedRefName("docs", "API_TOKEN");
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });
    assert.equal(await svc.vaultAdapter.hasManagedSecret("proj", name), true);

    // Same server, credential removed.
    await ctl.updateServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      env: {},
    });
    assert.equal(
      await svc.vaultAdapter.hasManagedSecret("proj", name),
      false,
      "a credential nothing refers to is not kept around",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removing the server prunes its value but keeps the project's bearer token", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    await ctl.setAuthEnabled("proj", true);
    const token = await ctl.generateToken("proj");
    assert.equal(token.ok, true);

    const name = managedRefName("docs", "API_TOKEN");
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });
    await ctl.removeServer("proj", "docs");

    assert.equal(await svc.vaultAdapter.hasManagedSecret("proj", name), false);
    const auth = await ctl.authStatus("proj");
    assert.equal(auth.ok && auth.value.tokenPresent, true, "the bearer token is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two servers using the same key get separate values", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "search",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: OTHER },
    });

    const a = managedRefName("docs", "API_TOKEN");
    const b = managedRefName("search", "API_TOKEN");
    assert.notEqual(a, b);
    assert.equal(await svc.vaultAdapter.getManagedSecret("proj", a), SECRET);
    assert.equal(await svc.vaultAdapter.getManagedSecret("proj", b), OTHER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty value is refused rather than stored as a blank credential", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });

    const added = await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: "" },
    });
    assert.equal(added.ok, false);
    assert.equal(added.ok === false && added.error.code, "invalid");
    assert.match(added.ok === false ? added.error.message : "", /API_TOKEN/);
    assert.deepEqual(await svc.vaultAdapter.managedSecretNames("proj"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a value for an unknown project is not stored", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();

    const added = await ctl.addServer("ghost", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });
    assert.equal(added.ok, false);
    assert.equal(added.ok === false && added.error.code, "not-found");
    assert.deepEqual(await svc.vaultAdapter.managedSecretNames("ghost"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guided setup stores a first server's pasted credential", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();

    const setup = await ctl.setupProject({
      id: "proj",
      label: "Proj",
      server: {
        transport: "stdio",
        id: "docs",
        command: "echo",
        args: [],
        secretValues: { API_TOKEN: SECRET },
      },
      enableWhenReady: true,
    });
    assert.equal(setup.ok, true);

    const name = managedRefName("docs", "API_TOKEN");
    assert.equal(await svc.vaultAdapter.getManagedSecret("proj", name), SECRET);
    assert.ok(!allFileContents(dir).includes(SECRET));
    // Enabled last, with the credential already resolvable, so it starts.
    const rt = ctl.runtime("proj");
    assert.equal(rt.ok && rt.value.servers[0]?.phase, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("derived names are stable and do not collide across lossy key shapes", () => {
  assert.equal(managedRefName("docs", "API_TOKEN"), managedRefName("docs", "API_TOKEN"));
  assert.notEqual(managedRefName("a-b", "K"), managedRefName("a_b", "K"));
  assert.notEqual(managedRefName("docs", "a-b"), managedRefName("docs", "a_b"));
  assert.match(managedRefName("my-docs", "x-api-key"), /^MULTIZEN_MY_DOCS_X_API_KEY_[0-9A-F]{6}$/);
});

test("a connection test uses the typed value without storing it", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });

    const result = await ctl.testServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.ok, true, "the fake upstream answers initialize");
    // Testing is not saving: no vault write, no server in the config.
    assert.deepEqual(await svc.vaultAdapter.managedSecretNames("proj"), []);
    assert.equal(svc.configOf("proj")?.servers.length, 0);
    assert.ok(!allFileContents(dir).includes(SECRET));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a test passes the value under the same name a save would use", async () => {
  const dir = tmp();
  try {
    const { svc, ctl, launched } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });

    await ctl.testServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });
    const probedEnv = (launched.at(-1)?.spec as StdioTransportSpec).env["API_TOKEN"];

    // Now save the identical definition and compare what the server receives.
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });
    const savedEnv = (launched.at(-1)?.spec as StdioTransportSpec).env["API_TOKEN"];

    assert.equal(probedEnv, SECRET);
    assert.equal(
      savedEnv,
      probedEnv,
      "a green test means the saved server behaves identically",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a test can draw on an already-stored credential the operator did not retype", async () => {
  const dir = tmp();
  try {
    const { svc, ctl, launched } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    const name = managedRefName("docs", "API_TOKEN");
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });

    const before = launched.length;
    const result = await ctl.testServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      env: { API_TOKEN: `\${${name}}` },
    });

    assert.equal(result.ok && result.value.ok, true);
    assert.ok(launched.length > before, "a fresh throwaway connection was made");
    assert.equal((launched.at(-1)?.spec as StdioTransportSpec).env["API_TOKEN"], SECRET);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a test with no project cannot reach another project's stored credentials", async () => {
  const dir = tmp();
  try {
    const { svc, ctl } = makeHarness(dir);
    await svc.start();
    await ctl.createProject({ id: "proj", enabled: true });
    const name = managedRefName("docs", "API_TOKEN");
    await ctl.addServer("proj", {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      secretValues: { API_TOKEN: SECRET },
    });

    // The wizard case: no project id yet, so only typed values are available.
    const result = await ctl.testServer(null, {
      transport: "stdio",
      id: "docs",
      command: "echo",
      args: [],
      env: { API_TOKEN: `\${${name}}` },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.ok, false);
    assert.deepEqual(result.ok && result.value.missingRefs, [name]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
