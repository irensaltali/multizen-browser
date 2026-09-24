import assert from "node:assert/strict";
import { test } from "node:test";

import { EnvResolver } from "./env.js";
import { HttpConnector, type HttpTransportSpec } from "./httpConnector.js";
import { parseProjectConfig, type HttpServerConfig } from "./projectConfig.js";
import { makeFakeUpstream } from "./testSupport.js";

function httpServer(overrides: Record<string, unknown> = {}): HttpServerConfig {
  const cfg = parseProjectConfig({
    configVersion: 1,
    id: "proj",
    servers: [
      {
        transport: "streamable-http",
        id: "up",
        url: "https://${UP_HOST}/mcp",
        headers: { Authorization: "${UP_TOKEN}" },
        ...overrides,
      },
    ],
  });
  return cfg.servers[0] as HttpServerConfig;
}

function harness(server: HttpServerConfig, base: Record<string, string>) {
  const specs: HttpTransportSpec[] = [];
  const factory = (spec: HttpTransportSpec) => {
    specs.push(spec);
    return makeFakeUpstream().transport;
  };
  const resolver = new EnvResolver({ base, allow: Object.keys(base) });
  const connector = new HttpConnector({ config: server, resolver, factory });
  return { connector, specs };
}

test("resolves URL template and header refs at connect time", async () => {
  const { connector, specs } = harness(httpServer(), { UP_HOST: "api.example.com", UP_TOKEN: "Bearer up-secret" });
  await connector.connect();
  assert.equal(connector.state, "connected");
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.url, "https://api.example.com/mcp");
  assert.equal(specs[0]!.headers["Authorization"], "Bearer up-secret");
});

test("only the configured upstream headers are emitted (no inbound Authorization passthrough)", async () => {
  // The connector has no channel to receive an inbound token; it composes
  // headers solely from config. Assert the emitted header set is exactly what
  // config declared — nothing injected from ambient state.
  const server = httpServer({ headers: { "X-Api-Key": "${UP_TOKEN}" } });
  const { connector, specs } = harness(server, { UP_HOST: "h", UP_TOKEN: "k" });
  await connector.connect();
  assert.deepEqual(Object.keys(specs[0]!.headers), ["X-Api-Key"]);
  assert.equal(specs[0]!.headers["Authorization"], undefined);
});

test("disabled server issues no requests (connect is a no-op)", async () => {
  const { connector, specs } = harness(httpServer({ disabled: true }), { UP_HOST: "h", UP_TOKEN: "t" });
  await connector.connect();
  assert.equal(connector.state, "idle");
  assert.equal(specs.length, 0);
});

test("unresolved env reference fails closed at connect", async () => {
  const { connector } = harness(httpServer(), { UP_HOST: "h" }); // UP_TOKEN missing
  await assert.rejects(() => connector.connect());
});

test("send before connect is rejected", async () => {
  const { connector } = harness(httpServer(), { UP_HOST: "h", UP_TOKEN: "t" });
  await assert.rejects(() => connector.send({ jsonrpc: "2.0", id: 1, method: "ping" }));
});

test("terminate releases the transport and marks terminated", async () => {
  const { connector } = harness(httpServer(), { UP_HOST: "h", UP_TOKEN: "t" });
  await connector.connect();
  await connector.terminate();
  assert.equal(connector.state, "terminated");
  await assert.rejects(() => connector.send({ jsonrpc: "2.0", id: 1, method: "ping" }));
});
