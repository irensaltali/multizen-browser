import assert from "node:assert/strict";
import { test } from "node:test";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { HttpServerConfig, HttpTransportFactory } from "@multizen/mcp-gateway";

import { GatewayVault } from "../GatewayVault.ts";
import { OAuthManager } from "../OAuthManager.ts";
import { MemoryVault } from "./testSupport.ts";

const server: HttpServerConfig = {
  transport: "streamable-http",
  id: "sentry" as HttpServerConfig["id"],
  disabled: false,
  auth: "oauth",
  url: "https://mcp.sentry.dev/mcp",
  headers: {},
};

test("OAuth callback validates state; pre-save tokens stay in memory until promotion", async () => {
  const backing = new MemoryVault();
  const vault = new GatewayVault(backing);
  let openedProfile = "";
  const factory: HttpTransportFactory = (spec) => ({
    async start() {
      const provider = spec.authProvider!;
      await provider.saveClientInformation?.({ client_id: "test-client" });
      const url = new URL("https://login.example/authorize");
      url.searchParams.set("state", await provider.state!());
      url.searchParams.set("redirect_uri", String(provider.redirectUrl));
      await provider.redirectToAuthorization(url);
      throw new UnauthorizedError();
    },
    async finishAuth(code) {
      assert.equal(code, "auth-code");
      await spec.authProvider!.saveTokens({ access_token: "secret-token", token_type: "Bearer" });
    },
    async send() {},
    async close() {},
  });
  const manager = new OAuthManager(
    vault,
    async (profileId, url) => {
      openedProfile = profileId;
      const state = new URL(url).searchParams.get("state");
      assert.ok(state);
      const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
      const bad = new URL(redirect);
      bad.searchParams.set("state", "wrong");
      bad.searchParams.set("code", "stolen");
      assert.equal((await fetch(bad)).status, 400);
      redirect.searchParams.set("state", state);
      redirect.searchParams.set("code", "auth-code");
      assert.equal((await fetch(redirect)).status, 200);
    },
    factory,
  );

  await manager.authorize("project", server, "profile-a", false);
  assert.equal(openedProfile, "profile-a");
  assert.equal(await vault.getOAuth("project", server.id, server.url), null);
  assert.equal(
    (await manager.providerFor("project", server).tokens())?.access_token,
    "secret-token",
  );
  await manager.promote("project", server);
  assert.ok((await vault.getOAuth("project", server.id, server.url))?.includes("secret-token"));
  await vault.deleteOAuthForServer("project", server.id);
  assert.equal(await vault.getOAuth("project", server.id, server.url), null);
});

test("denied OAuth callback and timeout leave no credentials behind", async () => {
  const backing = new MemoryVault();
  const vault = new GatewayVault(backing);
  const factory: HttpTransportFactory = (spec) => ({
    async start() {
      const provider = spec.authProvider!;
      const url = new URL("https://login.example/authorize");
      url.searchParams.set("state", await provider.state!());
      url.searchParams.set("redirect_uri", String(provider.redirectUrl));
      await provider.redirectToAuthorization(url);
      throw new UnauthorizedError();
    },
    async send() {},
    async close() {},
  });
  const denied = new OAuthManager(
    vault,
    async (_profile, url) => {
      const authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("error", "access_denied");
      assert.equal((await fetch(callback)).status, 400);
    },
    factory,
    20,
  );
  await assert.rejects(
    () => denied.authorize("project", server, "profile-a", true),
    /cancelled or denied/,
  );
  assert.equal(await vault.getOAuth("project", server.id, server.url), null);

  const timedOut = new OAuthManager(vault, async () => {}, factory, 5);
  await assert.rejects(() => timedOut.authorize("project", server, "profile-a", true), /timed out/);
  assert.equal(await vault.getOAuth("project", server.id, server.url), null);
});

test("pending sign-in stays scoped to its endpoint and can be discarded with the project", async () => {
  const vault = new GatewayVault(new MemoryVault());
  const factory: HttpTransportFactory = (spec) => ({
    async start() {
      await spec.authProvider!.saveTokens({ access_token: "pending-token", token_type: "Bearer" });
    },
    async send() {},
    async close() {},
  });
  const manager = new OAuthManager(vault, async () => {}, factory);
  await manager.authorize("project", server, "profile-a", false);
  const changed = { ...server, url: "https://mcp.example.com/mcp" };
  await manager.promote("project", changed);
  assert.equal(await vault.getOAuth("project", changed.id, changed.url), null);
  assert.equal(await vault.getOAuth("project", server.id, server.url), null);

  await manager.authorize("project", server, "profile-a", false);
  manager.discardProject("project");
  assert.equal(await manager.providerFor("project", server).tokens(), undefined);
});
