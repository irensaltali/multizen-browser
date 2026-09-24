import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { assertProjectId } from "./ids.js";
import { CONFIG_VERSION, parseProjectConfig } from "./projectConfig.js";
import { ProjectConfigStore } from "./projectConfigStore.js";

const tmpDirs: string[] = [];
async function tmpStore(): Promise<{ store: ProjectConfigStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcpgw-store-"));
  tmpDirs.push(dir);
  return { store: new ProjectConfigStore(dir), dir };
}

after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

function cfg(id: string, enabled = true) {
  return parseProjectConfig({
    configVersion: CONFIG_VERSION,
    id,
    enabled,
    servers: [
      { transport: "stdio", id: "s", command: "node", args: [], env: {}, disabled: !enabled },
    ],
  });
}

test("save then load round-trips", async () => {
  const { store } = await tmpStore();
  const saved = await store.save(cfg("proj-a"));
  const loaded = await store.load(assertProjectId("proj-a"));
  assert.ok(loaded);
  assert.deepEqual(loaded!.config, saved.config);
  assert.equal(loaded!.hash, saved.hash);
});

test("one file per project named by id", async () => {
  const { store, dir } = await tmpStore();
  await store.save(cfg("alpha"));
  await store.save(cfg("beta"));
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["alpha.json", "beta.json"]);
});

test("write is atomic: no tmp files remain", async () => {
  const { store, dir } = await tmpStore();
  await store.save(cfg("gamma"));
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("desired disabled state persists", async () => {
  const { store } = await tmpStore();
  await store.save(cfg("delta", false));
  const loaded = await store.load(assertProjectId("delta"));
  assert.equal(loaded!.config.enabled, false);
  assert.equal(loaded!.config.servers[0]!.disabled, true);
});

test("loadAll separates valid and rejected", async () => {
  const { store, dir } = await tmpStore();
  await store.init();
  await store.save(cfg("valid"));
  await fs.writeFile(path.join(dir, "broken.json"), "{ not json", "utf8");
  await fs.writeFile(path.join(dir, "mismatch.json"), JSON.stringify({ configVersion: 1, id: "other", servers: [] }), "utf8");
  const result = await store.loadAll();
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0]!.config.id, "valid");
  const rejectedFiles = result.rejected.map((r) => r.file).sort();
  assert.deepEqual(rejectedFiles, ["broken.json", "mismatch.json"]);
});

test("load returns null for missing project", async () => {
  const { store } = await tmpStore();
  await store.init();
  assert.equal(await store.load(assertProjectId("nope")), null);
});

test("remove deletes the file", async () => {
  const { store } = await tmpStore();
  await store.save(cfg("temp"));
  assert.equal(await store.remove(assertProjectId("temp")), true);
  assert.equal(await store.remove(assertProjectId("temp")), false);
  assert.equal(await store.load(assertProjectId("temp")), null);
});
