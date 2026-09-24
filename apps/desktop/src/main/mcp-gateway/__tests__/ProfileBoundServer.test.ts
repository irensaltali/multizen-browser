import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProfileManager } from "@multizen/profile-manager";
import type { BrowserDriver } from "@multizen/mcp-server";

import { createProfileBoundServer, BOUND_TOOL_NAMES } from "../ProfileBoundServer.ts";

/** A BrowserDriver mock that records the profile id every call receives. */
function mockDriver(): { driver: BrowserDriver; calls: Array<{ method: string; id: string }> } {
  const calls: Array<{ method: string; id: string }> = [];
  const driver: BrowserDriver = {
    async launch(id) {
      calls.push({ method: "launch", id });
      return { id, cdpEndpoint: "ws://x", port: 0 } as never;
    },
    async close(id) {
      calls.push({ method: "close", id });
    },
    isRunning(id) {
      calls.push({ method: "isRunning", id });
      return true;
    },
    async navigate(id, url) {
      calls.push({ method: "navigate", id });
      return { url };
    },
    async click(id) {
      calls.push({ method: "click", id });
      return { ok: true };
    },
    async type(id) {
      calls.push({ method: "type", id });
      return { ok: true };
    },
    async extract(id) {
      calls.push({ method: "extract", id });
      return { result: { url: "about:blank" } };
    },
    async screenshot(id) {
      calls.push({ method: "screenshot", id });
      return { pngBase64: "" };
    },
    async cdpSend(id, method) {
      calls.push({ method: `cdp:${method}`, id });
      return { result: { value: true } };
    },
  };
  return { driver, calls };
}

/** Minimal ProfileManager stub — bound page tools never touch it. */
const profileManagerStub = {
  get: () => ({ id: "bound-1", name: "x" }),
  list: () => [],
} as unknown as ProfileManager;

async function connectClient(boundProfileId: string, driver: BrowserDriver) {
  const bound = await createProfileBoundServer({
    profileManager: profileManagerStub,
    browserDriver: driver,
    boundProfileId,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([bound.server.connect(st), client.connect(ct)]);
  return { bound, client };
}

test("advertised tools exclude profile-library tools and strip profile_id", async () => {
  const { driver } = mockDriver();
  const { bound, client } = await connectClient("bound-1", driver);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  // Page tools present.
  assert.ok(names.has("navigate"));
  assert.ok(names.has("extract"));
  // Library / lifecycle tools absent.
  for (const blocked of ["list_profiles", "create_profile", "update_profile", "delete_profile", "launch_profile", "close_profile", "list_fingerprint_options"]) {
    assert.ok(!names.has(blocked), `${blocked} must be blocked`);
  }
  // No advertised tool exposes profile_id in its schema.
  for (const t of tools) {
    const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(!("profile_id" in props), `${t.name} must not advertise profile_id`);
  }
  await client.close();
  await bound.close();
});

test("a tool call injects the bound profile id (routes ONLY the bound profile)", async () => {
  const { driver, calls } = mockDriver();
  const { bound, client } = await connectClient("bound-1", driver);
  await client.callTool({ name: "navigate", arguments: { url: "https://example.com" } });
  const ids = new Set(calls.map((c) => c.id));
  assert.deepEqual([...ids], ["bound-1"], "every driver call used the bound id only");
  await client.close();
  await bound.close();
});

test("a client-supplied profile_id is rejected (no cross-profile smuggling)", async () => {
  const { driver, calls } = mockDriver();
  const { bound, client } = await connectClient("bound-1", driver);
  const res = await client.callTool({
    name: "navigate",
    arguments: { url: "https://example.com", profile_id: "other-profile" },
  });
  assert.equal(res.isError, true, "cross-profile arg is rejected");
  // The driver must never have been invoked for the smuggled id.
  assert.equal(calls.some((c) => c.id === "other-profile"), false);
  await client.close();
  await bound.close();
});

test("BOUND_TOOL_NAMES contains only page-drive tools", () => {
  assert.ok(BOUND_TOOL_NAMES.has("navigate"));
  assert.ok(!BOUND_TOOL_NAMES.has("list_profiles"));
  assert.ok(!BOUND_TOOL_NAMES.has("delete_profile"));
});
