import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { ProjectAuthPolicy } from "@multizen/mcp-gateway";
import { parseProjectConfig } from "@multizen/mcp-gateway";

import { GatewayRuntime } from "../GatewayRuntime.ts";
import { GatewayHttpRouter } from "../GatewayHttpRouter.ts";
import { fakeStdioFactory, type FakeUpstream } from "./testSupport.ts";

const HOST = "127.0.0.1:7777";
const ALLOWED = ["127.0.0.1:7777", "localhost:7777"];

/** A minimal fake IncomingMessage that emits a JSON body. */
class FakeReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  private body: string;
  constructor(opts: {
    method: string;
    url: string;
    headers?: Record<string, string | undefined>;
    body?: unknown;
  }) {
    super();
    this.method = opts.method;
    this.url = opts.url;
    this.body = opts.body !== undefined ? JSON.stringify(opts.body) : "";
    this.headers = { host: HOST, ...(opts.headers ?? {}) };
    if (this.body) this.headers["content-length"] = String(Buffer.byteLength(this.body));
  }
  fire(): void {
    // Emit body on next tick so handlers can attach listeners first.
    queueMicrotask(() => {
      if (this.body) this.emit("data", Buffer.from(this.body));
      this.emit("end");
    });
  }
  destroy(): void {
    /* no-op */
  }
}

/** A minimal fake ServerResponse capturing status/headers/body. */
class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;
  private ended = false;
  writeHead(code: number, headers?: Record<string, string>): this {
    this.statusCode = code;
    if (headers) Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }
  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.ended = true;
  }
  on(): this {
    return this;
  }
  get isEnded(): boolean {
    return this.ended;
  }
}

function stdioProject() {
  return parseProjectConfig({
    configVersion: 1,
    id: "p1",
    enabled: true,
    localAuth: { enabled: false },
    servers: [
      { transport: "stdio", id: "s1", disabled: false, command: "echo", args: [], env: {} },
    ],
  });
}

async function setup(policy?: ProjectAuthPolicy) {
  const upstreams: FakeUpstream[] = [];
  const runtime = new GatewayRuntime({
    stdioFactory: fakeStdioFactory((t) => upstreams.push(t)),
  });
  await runtime.reconcile([stdioProject()]);
  let seenAuthHeaderUpstream = false;
  const router = new GatewayHttpRouter({
    runtime,
    allowedHosts: ALLOWED,
    authPolicyFor: async () => policy ?? { authRequired: false },
    projectEnabled: () => true,
    boundServerFor: async () => null,
  });
  return { runtime, router, upstreams, seenAuthHeaderUpstream };
}

async function run(router: GatewayHttpRouter, req: FakeReq, res: FakeRes): Promise<boolean> {
  const p = router.handle(req as never, res as never);
  req.fire();
  return p;
}

test("non-gateway paths fall through (returns false)", async () => {
  const { router, runtime } = await setup();
  const res = new FakeRes();
  const handled = await run(router, new FakeReq({ method: "POST", url: "/mcp" }), res);
  assert.equal(handled, false, "/mcp (broad) is not a gateway route");
  const h2 = await run(router, new FakeReq({ method: "GET", url: "/healthz" }), new FakeRes());
  assert.equal(h2, false);
  await runtime.shutdown();
});

test("non-loopback Host is rejected (403) even for a valid gateway path", async () => {
  const { router, runtime } = await setup();
  const res = new FakeRes();
  const handled = await run(
    router,
    new FakeReq({ method: "POST", url: "/mcp/proxies/p1/s1", headers: { host: "evil.example.com" }, body: {} }),
    res,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  await runtime.shutdown();
});

test("non-loopback Origin is rejected (403)", async () => {
  const { router, runtime } = await setup();
  const res = new FakeRes();
  await run(
    router,
    new FakeReq({
      method: "POST",
      url: "/mcp/proxies/p1/s1",
      headers: { origin: "https://evil.example.com" },
      body: {},
    }),
    res,
  );
  assert.equal(res.statusCode, 403);
  await runtime.shutdown();
});

test("project auth default OFF: initialize succeeds without a bearer", async () => {
  const { router, runtime } = await setup();
  const res = new FakeRes();
  await run(
    router,
    new FakeReq({
      method: "POST",
      url: "/mcp/proxies/p1/s1",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers["mcp-session-id"], "a session id is issued");
  await runtime.shutdown();
});

test("auth ENABLED: wrong/absent bearer is 401; correct bearer passes and is NEVER forwarded upstream", async () => {
  const TOKEN = "s3cr3t-device-local-token";
  const { router, runtime, upstreams } = await setup({ authRequired: true, expectedToken: TOKEN });

  // No bearer → 401.
  const res401 = new FakeRes();
  await run(
    router,
    new FakeReq({ method: "POST", url: "/mcp/proxies/p1/s1", body: { jsonrpc: "2.0", id: 1, method: "initialize" } }),
    res401,
  );
  assert.equal(res401.statusCode, 401);

  // Correct bearer → initialize creates a session.
  const resInit = new FakeRes();
  await run(
    router,
    new FakeReq({
      method: "POST",
      url: "/mcp/proxies/p1/s1",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    }),
    resInit,
  );
  assert.equal(resInit.statusCode, 200);
  const sessionId = resInit.headers["mcp-session-id"];
  assert.ok(sessionId);

  // A follow-up request carrying the bearer forwards a JSON-RPC call upstream.
  const resCall = new FakeRes();
  await run(
    router,
    new FakeReq({
      method: "POST",
      url: "/mcp/proxies/p1/s1",
      headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": sessionId },
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    }),
    resCall,
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resCall.statusCode, 200);

  // The inbound Authorization must NEVER reach the upstream. Inspect everything
  // the fake upstream received.
  const forwarded = JSON.stringify(upstreams.flatMap((u) => u.sent));
  assert.equal(forwarded.includes(TOKEN), false, "inbound bearer was not forwarded upstream");
  assert.equal(forwarded.toLowerCase().includes("authorization"), false);
  await runtime.shutdown();
});

test("stateful session: unknown session id on a non-initialize POST is rejected", async () => {
  const { router, runtime } = await setup();
  const res = new FakeRes();
  await run(
    router,
    new FakeReq({
      method: "POST",
      url: "/mcp/proxies/p1/s1",
      headers: { "mcp-session-id": "deadbeef", "mcp-protocol-version": "2025-06-18" },
      body: { jsonrpc: "2.0", id: 9, method: "tools/list" },
    }),
    res,
  );
  assert.equal(res.statusCode, 404);
  await runtime.shutdown();
});

test("proxy route to a non-live server returns 503", async () => {
  const runtime = new GatewayRuntime({ stdioFactory: fakeStdioFactory() });
  // No reconcile → server not live.
  const router = new GatewayHttpRouter({
    runtime,
    allowedHosts: ALLOWED,
    authPolicyFor: async () => ({ authRequired: false }),
    projectEnabled: () => true,
    boundServerFor: async () => null,
  });
  const res = new FakeRes();
  await run(
    router,
    new FakeReq({ method: "POST", url: "/mcp/proxies/p1/s1", body: { jsonrpc: "2.0", id: 1, method: "initialize" } }),
    res,
  );
  assert.equal(res.statusCode, 503);
  await runtime.shutdown();
});
