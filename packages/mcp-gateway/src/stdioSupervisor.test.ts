import assert from "node:assert/strict";
import { test } from "node:test";

import { EnvResolver } from "./env.js";
import { parseProjectConfig, type StdioServerConfig } from "./projectConfig.js";
import { StdioSupervisor, type StdioTransportSpec } from "./stdioSupervisor.js";
import { FakeClock, flushMicrotasks, makeFakeTransport, type FakeTransportController } from "./testSupport.js";

function stdioServer(overrides: Partial<Record<string, unknown>> = {}): StdioServerConfig {
  const cfg = parseProjectConfig({
    configVersion: 1,
    id: "proj",
    servers: [
      {
        transport: "stdio",
        id: "srv",
        command: "node",
        args: ["server.js"],
        env: { API: "${API_TOKEN}" },
        ...overrides,
      },
    ],
  });
  return cfg.servers[0] as StdioServerConfig;
}

function harness(server: StdioServerConfig) {
  const clock = new FakeClock();
  const specs: StdioTransportSpec[] = [];
  const controllers: FakeTransportController[] = [];
  const factory = (spec: StdioTransportSpec) => {
    specs.push(spec);
    const c = makeFakeTransport();
    controllers.push(c);
    return c.transport;
  };
  const resolver = new EnvResolver({ base: { API_TOKEN: "tok" }, allow: ["API_TOKEN"] });
  const sup = new StdioSupervisor({
    config: server,
    resolver,
    baseEnv: { PATH: "/bin" },
    factory,
    clock,
    backoff: { initialDelayMs: 100, maxDelayMs: 1000, factor: 2, breakerThreshold: 3 },
  });
  return { sup, clock, specs, controllers };
}

test("disabled server never starts", async () => {
  const server = stdioServer({ disabled: true });
  const { sup, specs } = harness(server);
  assert.equal(sup.eligible, false);
  await sup.start();
  assert.equal(specs.length, 0);
  assert.equal(sup.state.phase, "idle");
});

test("enabled server starts with resolved env and allowlisted base", async () => {
  const { sup, specs } = harness(stdioServer());
  await sup.start();
  assert.equal(sup.state.phase, "running");
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.command, "node");
  assert.deepEqual(specs[0]!.args, ["server.js"]);
  assert.equal(specs[0]!.env["API"], "tok", "resolved ${API_TOKEN}");
  assert.equal(specs[0]!.env["PATH"], "/bin", "base env present");
});

test("crash triggers capped exponential backoff then restart", async () => {
  const { sup, clock, controllers } = harness(stdioServer());
  await sup.start();
  assert.equal(sup.state.phase, "running");

  controllers[0]!.crash();
  assert.equal(sup.state.phase, "backoff");
  assert.equal(sup.state.consecutiveFailures, 1);

  // First retry after initialDelay (100ms).
  clock.advance(100);
  await flushMicrotasks();
  assert.equal(sup.state.phase, "running");
  assert.equal(sup.state.restarts, 1);
});

test("repeated start failures open the circuit breaker", async () => {
  const clock = new FakeClock();
  const controllers: FakeTransportController[] = [];
  const factory = () => {
    const c = makeFakeTransport();
    c.failNextStart("boom");
    controllers.push(c);
    return c.transport;
  };
  const sup = new StdioSupervisor({
    config: stdioServer(),
    resolver: new EnvResolver({ base: { API_TOKEN: "t" }, allow: ["API_TOKEN"] }),
    baseEnv: {},
    factory,
    clock,
    backoff: { initialDelayMs: 100, maxDelayMs: 1000, factor: 2, breakerThreshold: 3 },
  });

  await sup.start(); // failure 1 -> backoff
  assert.equal(sup.state.phase, "backoff");
  clock.advance(100);
  await flushMicrotasks(); // failure 2 -> backoff
  assert.equal(sup.state.phase, "backoff");
  clock.advance(200);
  await flushMicrotasks(); // failure 3 -> breaker opens
  assert.equal(sup.state.phase, "circuit-open");
  assert.equal(sup.state.consecutiveFailures, 3);
  assert.equal(clock.pendingCount, 0, "no further retries once open");
});

test("resetAndStart clears breaker and relaunches", async () => {
  const clock = new FakeClock();
  let failUntil = 3;
  const controllers: FakeTransportController[] = [];
  const factory = () => {
    const c = makeFakeTransport();
    if (controllers.length < failUntil) c.failNextStart("boom");
    controllers.push(c);
    return c.transport;
  };
  const sup = new StdioSupervisor({
    config: stdioServer(),
    resolver: new EnvResolver({ base: { API_TOKEN: "t" }, allow: ["API_TOKEN"] }),
    baseEnv: {},
    factory,
    clock,
    backoff: { initialDelayMs: 100, maxDelayMs: 1000, factor: 2, breakerThreshold: 3 },
  });
  await sup.start();
  clock.advance(100);
  await flushMicrotasks();
  clock.advance(200);
  await flushMicrotasks();
  assert.equal(sup.state.phase, "circuit-open");

  failUntil = 0; // next attempt succeeds
  await sup.resetAndStart();
  assert.equal(sup.state.phase, "running");
  assert.equal(sup.state.consecutiveFailures, 0);
});

test("start() failure schedules retry (not immediate crash)", async () => {
  const clock = new FakeClock();
  const controllers: FakeTransportController[] = [];
  const factory = () => {
    const c = makeFakeTransport();
    controllers.push(c);
    if (controllers.length === 1) c.failNextStart("spawn ENOENT");
    return c.transport;
  };
  const sup = new StdioSupervisor({
    config: stdioServer(),
    resolver: new EnvResolver({ base: { API_TOKEN: "t" }, allow: ["API_TOKEN"] }),
    baseEnv: {},
    factory,
    clock,
    backoff: { initialDelayMs: 50, maxDelayMs: 500, factor: 2, breakerThreshold: 5 },
  });
  await sup.start();
  assert.equal(sup.state.phase, "backoff");
  assert.equal(sup.state.lastError, "spawn ENOENT");
  clock.advance(50);
  await flushMicrotasks();
  assert.equal(sup.state.phase, "running");
});

test("bounded stderr ring buffer", async () => {
  const clock = new FakeClock();
  const controllers: FakeTransportController[] = [];
  const factory = () => {
    const c = makeFakeTransport();
    controllers.push(c);
    return c.transport;
  };
  const sup = new StdioSupervisor({
    config: stdioServer(),
    resolver: new EnvResolver({ base: { API_TOKEN: "t" }, allow: ["API_TOKEN"] }),
    baseEnv: {},
    factory,
    clock,
    maxStderrBytes: 10,
  });
  await sup.start();
  controllers[0]!.emitStderr("0123456789ABCDEF");
  assert.equal(sup.stderr.length, 10);
  assert.equal(sup.stderr, "6789ABCDEF");
});

test("graceful stop closes transport and cancels retries", async () => {
  const { sup, clock, controllers } = harness(stdioServer());
  await sup.start();
  controllers[0]!.crash();
  assert.equal(sup.state.phase, "backoff");
  await sup.stop();
  assert.equal(sup.state.phase, "stopped");
  // Advancing time must not relaunch.
  clock.advance(10_000);
  assert.equal(sup.state.phase, "stopped");
});

test("send rejects when not running", async () => {
  const { sup } = harness(stdioServer());
  await assert.rejects(() => sup.send({ jsonrpc: "2.0", id: 1, method: "ping" }));
});

test("unresolved env fails closed at launch", async () => {
  const clock = new FakeClock();
  const factory = () => makeFakeTransport().transport;
  const sup = new StdioSupervisor({
    config: stdioServer(),
    resolver: new EnvResolver({ base: {}, allow: ["API_TOKEN"] }),
    baseEnv: {},
    factory,
    clock,
  });
  await assert.rejects(() => sup.start());
});
