import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceBindingStore } from "../WorkspaceBindingStore.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mz-wb-"));
}

test("a missing file loads as empty state", async () => {
  const dir = tmp();
  try {
    const store = new WorkspaceBindingStore(join(dir, "nested", "workspaces.json"));
    await store.load();
    assert.deepEqual(store.listAll(), []);
    assert.deepEqual(store.approvedEnv(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads before load() are rejected rather than silently empty", async () => {
  const dir = tmp();
  try {
    const store = new WorkspaceBindingStore(join(dir, "workspaces.json"));
    assert.throws(() => store.listAll(), /load\(\) was not awaited/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bindings survive save + reload from a fresh instance", async () => {
  const dir = tmp();
  const file = join(dir, "workspaces.json");
  try {
    const a = new WorkspaceBindingStore(file);
    await a.load();
    await a.setAgents("proj", "/abs/work/one", ["claude-code", "codex"]);
    await a.setAgents("proj", "/abs/work/two", ["cursor"]);

    const b = new WorkspaceBindingStore(file);
    await b.load();
    const bindings = b.listForProject("proj");
    assert.equal(bindings.length, 2);
    assert.deepEqual(
      bindings.map((x) => x.directory),
      ["/abs/work/one", "/abs/work/two"],
      "sorted by directory for stable UI order",
    );
    assert.deepEqual(
      bindings[0]?.agents.map((x) => x.agent).sort(),
      ["claude-code", "codex"],
    );
    // A freshly selected agent has never been installed.
    assert.equal(bindings[0]?.agents[0]?.status, "out-of-date");
    assert.equal(bindings[0]?.agents[0]?.lastInstalledAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-binding the same directory for one project replaces, never duplicates", async () => {
  const dir = tmp();
  try {
    const store = new WorkspaceBindingStore(join(dir, "workspaces.json"));
    await store.load();
    await store.setAgents("proj", "/abs/work", ["claude-code"]);
    await store.setAgents("proj", "/abs/work", ["cursor", "kiro-cli"]);
    const list = store.listForProject("proj");
    assert.equal(list.length, 1, "one row for one (project, directory) pair");
    assert.deepEqual(list[0]?.agents.map((a) => a.agent), ["cursor", "kiro-cli"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same directory may be bound by two DIFFERENT projects", async () => {
  const dir = tmp();
  try {
    const store = new WorkspaceBindingStore(join(dir, "workspaces.json"));
    await store.load();
    await store.setAgents("alpha", "/abs/shared", ["codex"]);
    await store.setAgents("beta", "/abs/shared", ["cursor"]);
    assert.equal(store.listAll().length, 2);
    assert.equal(store.listForProject("alpha").length, 1);
    assert.equal(store.listForProject("beta").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deselecting an agent returns its prior row so owned entries can be removed", async () => {
  const dir = tmp();
  try {
    const store = new WorkspaceBindingStore(join(dir, "workspaces.json"));
    await store.load();
    await store.setAgents("proj", "/abs/work", ["claude-code", "codex"]);
    await store.updateAgentState("proj", "/abs/work", "codex", {
      ownedKeys: ["multizen_proj_srv"],
      status: "current",
      lastInstalledAt: 123,
    });

    const { binding, removed } = await store.setAgents("proj", "/abs/work", ["claude-code"]);
    assert.deepEqual(binding.agents.map((a) => a.agent), ["claude-code"]);
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.agent, "codex");
    assert.deepEqual(removed[0]?.ownedKeys, ["multizen_proj_srv"], "ownership is handed back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a kept agent preserves its ownership + install history across a selection change", async () => {
  const dir = tmp();
  try {
    const store = new WorkspaceBindingStore(join(dir, "workspaces.json"));
    await store.load();
    await store.setAgents("proj", "/abs/work", ["claude-code"]);
    await store.updateAgentState("proj", "/abs/work", "claude-code", {
      ownedKeys: ["multizen_proj_a"],
      desiredHash: "h1",
      fileHash: "f1",
      status: "current",
      lastInstalledAt: 999,
    });
    await store.setAgents("proj", "/abs/work", ["claude-code", "cursor"]);
    const row = store.get("proj", "/abs/work")?.agents.find((a) => a.agent === "claude-code");
    assert.deepEqual(row?.ownedKeys, ["multizen_proj_a"]);
    assert.equal(row?.desiredHash, "h1");
    assert.equal(row?.status, "current");
    assert.equal(row?.lastInstalledAt, 999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateAgentState can set and explicitly clear error/hint", async () => {
  const dir = tmp();
  try {
    const store = new WorkspaceBindingStore(join(dir, "workspaces.json"));
    await store.load();
    await store.setAgents("proj", "/abs/work", ["codex"]);
    await store.updateAgentState("proj", "/abs/work", "codex", {
      status: "error",
      error: "permission denied",
      hint: "trust the project",
    });
    let row = store.get("proj", "/abs/work")?.agents[0];
    assert.equal(row?.status, "error");
    assert.equal(row?.error, "permission denied");
    assert.equal(row?.hint, "trust the project");

    await store.updateAgentState("proj", "/abs/work", "codex", {
      status: "current",
      error: undefined,
      hint: undefined,
    });
    row = store.get("proj", "/abs/work")?.agents[0];
    assert.equal(row?.status, "current");
    assert.equal(row?.error, undefined);
    assert.equal(row?.hint, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeBinding / removeProject return the removed rows for cleanup", async () => {
  const dir = tmp();
  try {
    const store = new WorkspaceBindingStore(join(dir, "workspaces.json"));
    await store.load();
    await store.setAgents("proj", "/abs/a", ["codex"]);
    await store.setAgents("proj", "/abs/b", ["cursor"]);

    const one = await store.removeBinding("proj", "/abs/a");
    assert.equal(one?.directory, "/abs/a");
    assert.equal(store.listForProject("proj").length, 1);
    assert.equal(await store.removeBinding("proj", "/abs/missing"), null);

    const rest = await store.removeProject("proj");
    assert.equal(rest.length, 1);
    assert.equal(rest[0]?.directory, "/abs/b");
    assert.deepEqual(store.listAll(), []);
    assert.deepEqual(await store.removeProject("proj"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed records are dropped, valid ones in the same file survive", async () => {
  const dir = tmp();
  const file = join(dir, "workspaces.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        bindings: [
          { projectId: "good", directory: "/abs/ok", agents: [{ agent: "codex" }] },
          { projectId: "", directory: "/abs/x", agents: [] }, // empty project id
          { projectId: "rel", directory: "relative/path", agents: [] }, // not absolute
          { projectId: "bad-agents", directory: "/abs/y", agents: [{ agent: "nope" }] },
          "not-an-object",
          null,
        ],
        approvedEnv: ["A", "A", 5, "B"],
      }),
    );
    const store = new WorkspaceBindingStore(file);
    await store.load();
    const all = store.listAll();
    assert.deepEqual(
      all.map((b) => b.projectId).sort(),
      ["bad-agents", "good"],
      "only absolute-path rows with a non-empty project id survive",
    );
    // The unknown agent kind was dropped, leaving an empty selection.
    assert.deepEqual(all.find((b) => b.projectId === "bad-agents")?.agents, []);
    assert.deepEqual(store.approvedEnv(), ["A", "B"], "deduped + non-strings dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt (unparseable) file loads as empty instead of throwing", async () => {
  const dir = tmp();
  const file = join(dir, "workspaces.json");
  try {
    writeFileSync(file, "{ this is not json");
    const store = new WorkspaceBindingStore(file);
    await store.load();
    assert.deepEqual(store.listAll(), []);
    // And the store is usable afterwards, overwriting the corrupt file.
    await store.setAgents("proj", "/abs/work", ["cursor"]);
    assert.equal(store.listAll().length, 1);
    const reread = JSON.parse(readFileSync(file, "utf8")) as { bindings: unknown[] };
    assert.equal(reread.bindings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a duplicate (project, directory) pair in the file collapses to one row", async () => {
  const dir = tmp();
  const file = join(dir, "workspaces.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        bindings: [
          { projectId: "p", directory: "/abs/w", agents: [{ agent: "codex" }] },
          { projectId: "p", directory: "/abs/w", agents: [{ agent: "cursor" }] },
        ],
        approvedEnv: [],
      }),
    );
    const store = new WorkspaceBindingStore(file);
    await store.load();
    const list = store.listForProject("p");
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]?.agents.map((a) => a.agent), ["cursor"], "last wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes are atomic: no temp files remain and the file is always valid JSON", async () => {
  const dir = tmp();
  const file = join(dir, "workspaces.json");
  try {
    const store = new WorkspaceBindingStore(file);
    await store.load();
    // Fire several mutations concurrently; the store serializes them.
    await Promise.all([
      store.setAgents("p1", "/abs/1", ["codex"]),
      store.setAgents("p2", "/abs/2", ["cursor"]),
      store.setAgents("p3", "/abs/3", ["kiro-cli"]),
      store.approveEnv("TOKEN_A"),
      store.approveEnv("TOKEN_B"),
    ]);
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, [], "no temp files survive a completed write");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      bindings: unknown[];
      approvedEnv: string[];
    };
    assert.equal(parsed.bindings.length, 3);
    assert.deepEqual(parsed.approvedEnv.sort(), ["TOKEN_A", "TOKEN_B"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approved env names persist and can be revoked", async () => {
  const dir = tmp();
  const file = join(dir, "workspaces.json");
  try {
    const a = new WorkspaceBindingStore(file);
    await a.load();
    await a.approveEnv("MY_TOKEN");
    await a.approveEnv("MY_TOKEN"); // idempotent
    assert.equal(a.isEnvApproved("MY_TOKEN"), true);
    assert.equal(a.isEnvApproved("OTHER"), false);

    const b = new WorkspaceBindingStore(file);
    await b.load();
    assert.deepEqual(b.approvedEnv(), ["MY_TOKEN"]);
    await b.revokeEnv("MY_TOKEN");
    await b.revokeEnv("MY_TOKEN"); // idempotent
    assert.deepEqual(b.approvedEnv(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local directory paths never appear in the signed project config directory", async () => {
  const dir = tmp();
  try {
    // The workspace store writes to its OWN file; the signed project store owns
    // `projects/`. This asserts the separation the design depends on.
    const root = join(dir, "mcp-gateway");
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(
      join(root, "projects", "proj.json"),
      JSON.stringify({
        configVersion: 1,
        id: "proj",
        enabled: true,
        localAuth: { enabled: false },
        servers: [],
      }),
    );
    const store = new WorkspaceBindingStore(join(root, "workspaces.json"));
    await store.load();
    await store.setAgents("proj", "/Users/someone/private/work", ["codex"]);

    const signed = readFileSync(join(root, "projects", "proj.json"), "utf8");
    assert.equal(
      signed.includes("/Users/someone/private/work"),
      false,
      "the machine path is not in the signed/synced project config",
    );
    const local = readFileSync(join(root, "workspaces.json"), "utf8");
    assert.equal(local.includes("/Users/someone/private/work"), true, "it lives device-locally");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
