import assert from "node:assert/strict";
import { test } from "node:test";

import { type ProjectId } from "./ids.js";
import {
  constantTimeEquals,
  isLoopbackHost,
  parseBearer,
  Router,
  type ProjectAuthPolicy,
  type RouterRequest,
} from "./router.js";

function req(partial: Partial<RouterRequest>): RouterRequest {
  return {
    method: "POST",
    path: "/mcp/proxies/proj/srv",
    headers: { host: "127.0.0.1:7777" },
    ...partial,
  };
}

function router(policy?: (p: ProjectId) => ProjectAuthPolicy | undefined) {
  return new Router(policy ?? (() => undefined), { maxBodyBytes: 1000 });
}

test("matches proxy route", () => {
  const r = router();
  const res = r.evaluate(req({ path: "/mcp/proxies/my-proj/my-srv" }));
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.route.kind, "proxy");
    assert.equal(res.route.project, "my-proj");
    if (res.route.kind === "proxy") assert.equal(res.route.server, "my-srv");
  }
});

test("matches browser route", () => {
  const r = router();
  const res = r.evaluate(req({ path: "/mcp/projects/proj/browser" }));
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.route.kind, "browser");
});

test("unknown path is 404", () => {
  const r = router();
  const res = r.evaluate(req({ path: "/mcp/other" }));
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.status, 404);
});

test("unsafe id in path does not match", () => {
  const r = router();
  const res = r.evaluate(req({ path: "/mcp/proxies/../srv" }));
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.reason, "not-found");
});

test("disallowed method is 405", () => {
  const r = router();
  const res = r.evaluate(req({ method: "PUT" }));
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.status, 405);
});

test("non-loopback host rejected", () => {
  const r = router();
  const res = r.evaluate(req({ headers: { host: "evil.com" } }));
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.reason, "bad-host");
});

test("loopback hosts accepted", () => {
  const r = router();
  for (const host of ["127.0.0.1:7777", "localhost:7777", "[::1]:7777"]) {
    const res = r.evaluate(req({ headers: { host } }));
    assert.ok(res.ok, host);
  }
});

test("missing host rejected", () => {
  const r = router();
  const res = r.evaluate(req({ headers: {} }));
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.status, 400);
});

test("cross-origin non-loopback Origin rejected", () => {
  const r = router();
  const res = r.evaluate(
    req({ headers: { host: "127.0.0.1:7777", origin: "https://evil.com" } }),
  );
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.reason, "bad-origin");
});

test("loopback Origin accepted", () => {
  const r = router();
  const res = r.evaluate(
    req({ headers: { host: "127.0.0.1:7777", origin: "http://localhost:7777" } }),
  );
  assert.ok(res.ok);
});

test("body over limit rejected", () => {
  const r = router();
  const res = r.evaluate(req({ contentLength: 2000 }));
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.status, 413);
});

test("auth default off: no token required", () => {
  const r = router(() => ({ authRequired: false }));
  const res = r.evaluate(req({}));
  assert.ok(res.ok);
});

test("auth required: missing token rejected", () => {
  const r = router(() => ({ authRequired: true, expectedToken: "secret" }));
  const res = r.evaluate(req({}));
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.status, 401);
});

test("auth required: correct token accepted", () => {
  const r = router(() => ({ authRequired: true, expectedToken: "secret" }));
  const res = r.evaluate(
    req({ headers: { host: "127.0.0.1:7777", authorization: "Bearer secret" } }),
  );
  assert.ok(res.ok);
});

test("auth required: wrong token rejected", () => {
  const r = router(() => ({ authRequired: true, expectedToken: "secret" }));
  const res = r.evaluate(
    req({ headers: { host: "127.0.0.1:7777", authorization: "Bearer nope" } }),
  );
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.reason, "unauthorized");
});

test("parseBearer", () => {
  assert.equal(parseBearer("Bearer abc"), "abc");
  assert.equal(parseBearer("bearer  xyz "), "xyz");
  assert.equal(parseBearer("Basic abc"), null);
  assert.equal(parseBearer(undefined), null);
});

test("constantTimeEquals", () => {
  assert.ok(constantTimeEquals("a", "a"));
  assert.ok(constantTimeEquals("longer-token-value", "longer-token-value"));
  assert.ok(!constantTimeEquals("a", "b"));
  assert.ok(!constantTimeEquals("short", "longer"));
});

test("isLoopbackHost", () => {
  assert.ok(isLoopbackHost("localhost"));
  assert.ok(isLoopbackHost("127.0.0.1"));
  assert.ok(isLoopbackHost("127.5.5.5"));
  assert.ok(isLoopbackHost("::1"));
  assert.ok(!isLoopbackHost("10.0.0.1"));
  assert.ok(!isLoopbackHost("example.com"));
});
