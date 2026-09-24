import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROTOCOL_VERSION_HEADER,
  SESSION_ID_HEADER,
  SessionManager,
  SUPPORTED_PROTOCOL_VERSIONS,
  type SessionRequest,
} from "./sessionManager.js";

function initBody() {
  return { jsonrpc: "2.0", id: 0, method: "initialize", params: {} };
}

function callBody() {
  return { jsonrpc: "2.0", id: 1, method: "tools/list" };
}

function deterministicIds() {
  let n = 0;
  return () => `sid-${n++}`;
}

function mgr(overrides = {}) {
  return new SessionManager({ generateId: deterministicIds(), now: () => 1000, ...overrides });
}

test("initialize POST creates a session and returns the id header", () => {
  const m = mgr();
  const d = m.handle({ method: "POST", headers: {}, body: initBody() });
  assert.equal(d.kind, "created");
  assert.equal(d.status, 200);
  assert.equal(d.sessionId, "sid-0");
  assert.equal(d.headers[SESSION_ID_HEADER], "sid-0");
  assert.ok(m.has("sid-0"));
  assert.equal(m.size, 1);
});

test("real ids are 256 bits of entropy (64 hex chars) and unique", () => {
  const m = new SessionManager();
  const a = m.handle({ method: "POST", headers: {}, body: initBody() });
  const b = m.handle({ method: "POST", headers: {}, body: initBody() });
  assert.match(a.sessionId!, /^[0-9a-f]{64}$/);
  assert.match(b.sessionId!, /^[0-9a-f]{64}$/);
  assert.notEqual(a.sessionId, b.sessionId);
});

test("initialize must not carry an existing session id", () => {
  const m = mgr();
  const d = m.handle({ method: "POST", headers: { [SESSION_ID_HEADER]: "sid-x" }, body: initBody() });
  assert.equal(d.kind, "rejected");
  assert.equal(d.status, 400);
});

test("non-initialize POST requires a known session", () => {
  const m = mgr();
  const missing = m.handle({ method: "POST", headers: {}, body: callBody() });
  assert.equal(missing.status, 400);
  const unknown = m.handle({
    method: "POST",
    headers: { [SESSION_ID_HEADER]: "nope" },
    body: callBody(),
  });
  assert.equal(unknown.status, 404);
});

test("valid non-initialize POST is accepted", () => {
  const m = mgr();
  const created = m.handle({ method: "POST", headers: {}, body: initBody() });
  const d = m.handle({
    method: "POST",
    headers: { [SESSION_ID_HEADER]: created.sessionId! },
    body: callBody(),
  });
  assert.equal(d.kind, "accepted");
  assert.equal(d.status, 200);
});

test("batch body containing initialize is treated as initialize", () => {
  const m = mgr();
  const d = m.handle({ method: "POST", headers: {}, body: [callBody(), initBody()] });
  assert.equal(d.kind, "created");
});

test("GET opens an SSE stream for a valid session", () => {
  const m = mgr();
  const created = m.handle({ method: "POST", headers: {}, body: initBody() });
  const d = m.handle({ method: "GET", headers: { [SESSION_ID_HEADER]: created.sessionId! } });
  assert.equal(d.kind, "stream-opened");
  assert.equal(d.headers["content-type"], "text/event-stream");
  assert.equal(m.get(created.sessionId!)!.streamOpen, true);
});

test("GET without a session id is rejected", () => {
  const m = mgr();
  const d = m.handle({ method: "GET", headers: {} });
  assert.equal(d.status, 400);
});

test("GET for an unknown session is 404", () => {
  const m = mgr();
  const d = m.handle({ method: "GET", headers: { [SESSION_ID_HEADER]: "ghost" } });
  assert.equal(d.status, 404);
});

test("DELETE terminates a session and further use is rejected", () => {
  const m = mgr();
  const created = m.handle({ method: "POST", headers: {}, body: initBody() });
  const del = m.handle({ method: "DELETE", headers: { [SESSION_ID_HEADER]: created.sessionId! } });
  assert.equal(del.kind, "terminated");
  assert.equal(m.has(created.sessionId!), false);
  const after = m.handle({
    method: "POST",
    headers: { [SESSION_ID_HEADER]: created.sessionId! },
    body: callBody(),
  });
  assert.equal(after.status, 404);
});

test("DELETE of an unknown session is 404", () => {
  const m = mgr();
  const d = m.handle({ method: "DELETE", headers: { [SESSION_ID_HEADER]: "ghost" } });
  assert.equal(d.status, 404);
});

test("unsupported protocol version on a call is rejected", () => {
  const m = mgr();
  const created = m.handle({ method: "POST", headers: {}, body: initBody() });
  const d = m.handle({
    method: "POST",
    headers: { [SESSION_ID_HEADER]: created.sessionId!, [PROTOCOL_VERSION_HEADER]: "1999-01-01" },
    body: callBody(),
  });
  assert.equal(d.status, 400);
  assert.match(d.message!, /Unsupported/);
});

test("supported protocol version is accepted", () => {
  const m = mgr();
  const created = m.handle({ method: "POST", headers: {}, body: initBody() });
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    const d = m.handle({
      method: "POST",
      headers: { [SESSION_ID_HEADER]: created.sessionId!, [PROTOCOL_VERSION_HEADER]: v },
      body: callBody(),
    });
    assert.equal(d.kind, "accepted", v);
  }
});

test("session limit yields 503", () => {
  const m = mgr({ maxSessions: 1 });
  m.handle({ method: "POST", headers: {}, body: initBody() });
  const d = m.handle({ method: "POST", headers: {}, body: initBody() });
  assert.equal(d.status, 503);
});

test("nextEventId is monotonic per session and null for unknown", () => {
  const m = mgr();
  const created = m.handle({ method: "POST", headers: {}, body: initBody() });
  assert.equal(m.nextEventId(created.sessionId!), `${created.sessionId}-1`);
  assert.equal(m.nextEventId(created.sessionId!), `${created.sessionId}-2`);
  assert.equal(m.nextEventId("ghost"), null);
});

test("closeStream flips streamOpen back to false", () => {
  const m = mgr();
  const created = m.handle({ method: "POST", headers: {}, body: initBody() });
  m.handle({ method: "GET", headers: { [SESSION_ID_HEADER]: created.sessionId! } });
  m.closeStream(created.sessionId!);
  assert.equal(m.get(created.sessionId!)!.streamOpen, false);
});

test("terminateAll clears every session", () => {
  const m = mgr();
  m.handle({ method: "POST", headers: {}, body: initBody() });
  m.handle({ method: "POST", headers: {}, body: initBody() });
  assert.equal(m.size, 2);
  m.terminateAll();
  assert.equal(m.size, 0);
});

test("createdAt uses the injected clock", () => {
  const m = mgr();
  const created = m.handle({ method: "POST", headers: {}, body: initBody() });
  assert.equal(m.get(created.sessionId!)!.createdAt, 1000);
});

test("unknown verb is 405", () => {
  const m = mgr();
  const d = m.handle({ method: "PATCH" as never, headers: {} } as SessionRequest);
  assert.equal(d.status, 405);
});
