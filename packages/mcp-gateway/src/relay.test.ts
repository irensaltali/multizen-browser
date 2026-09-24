import assert from "node:assert/strict";
import { test } from "node:test";

import { MCP_ERROR, JSON_RPC, type JsonRpcMessage } from "./jsonrpc.js";
import { RelaySession } from "./relay.js";
import {
  CapturingClientSink,
  makeFakeUpstream,
  rpcNotification,
  rpcRequest,
  rpcResponse,
} from "./testSupport.js";

function setup(sessionId = "sess-a") {
  const upstream = makeFakeUpstream();
  const client = new CapturingClientSink();
  let seq = 0;
  const session = new RelaySession({
    sessionId,
    upstream: upstream.transport,
    client,
    allocateUpstreamId: () => `up-${sessionId}-${seq++}`,
  });
  return { upstream, client, session };
}

test("client request is forwarded with a remapped upstream id", async () => {
  const { upstream, session } = setup();
  await session.fromClient(rpcRequest(1, "tools/list", { cursor: "c1" }));
  assert.equal(upstream.sent.length, 1);
  const fwd = upstream.sent[0] as { id: unknown; method: string; params: unknown };
  assert.equal(fwd.id, "up-sess-a-0");
  assert.equal(fwd.method, "tools/list");
  assert.deepEqual(fwd.params, { cursor: "c1" });
  assert.equal(session.pendingClientRequests, 1);
});

test("upstream response is mapped back to the client's original id, preserving result + _meta + cursor", async () => {
  const { upstream, client, session } = setup();
  await session.fromClient(rpcRequest(7, "tools/list"));
  const upId = (upstream.sent[0] as { id: string }).id;
  const result = {
    tools: [{ name: "t" }],
    nextCursor: "next-1",
    _meta: { trace: "abc" },
  };
  upstream.deliver(rpcResponse(upId, result));
  assert.equal(client.received.length, 1);
  const res = client.received[0] as { id: unknown; result: unknown };
  assert.equal(res.id, 7, "client's original id restored");
  assert.deepEqual(res.result, result, "result, cursor and _meta preserved verbatim");
  assert.equal(session.pendingClientRequests, 0);
});

test("upstream error response preserves the error object", async () => {
  const { upstream, client, session } = setup();
  await session.fromClient(rpcRequest(9, "tools/call"));
  const upId = (upstream.sent[0] as { id: string }).id;
  upstream.deliver({
    jsonrpc: "2.0",
    id: upId,
    error: { code: JSON_RPC.INVALID_PARAMS, message: "bad", data: { field: "x" } },
  });
  const res = client.received[0] as { id: unknown; error: unknown };
  assert.equal(res.id, 9);
  assert.deepEqual(res.error, { code: JSON_RPC.INVALID_PARAMS, message: "bad", data: { field: "x" } });
});

test("notifications pass through untouched in both directions", async () => {
  const { upstream, client, session } = setup();
  // client -> upstream
  await session.fromClient(rpcNotification("notifications/initialized"));
  assert.deepEqual(upstream.sent.at(-1), { jsonrpc: "2.0", method: "notifications/initialized" });
  // upstream -> client (progress, list_changed, resources/updated, logging)
  for (const n of [
    rpcNotification("notifications/progress", { progressToken: 1, progress: 0.5 }),
    rpcNotification("notifications/tools/list_changed"),
    rpcNotification("notifications/resources/updated", { uri: "file:///a" }),
    rpcNotification("notifications/message", { level: "info", data: "hi" }),
  ]) {
    upstream.deliver(n);
  }
  assert.equal(client.received.length, 4);
  assert.deepEqual(client.received[0], {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: 1, progress: 0.5 },
  });
});

test("cancellation notification is remapped to the upstream id", async () => {
  const { upstream, session } = setup();
  await session.fromClient(rpcRequest(42, "tools/call"));
  const upId = (upstream.sent[0] as { id: string }).id;
  await session.fromClient(rpcNotification("notifications/cancelled", { requestId: 42, reason: "user" }));
  const cancel = upstream.sent.at(-1) as { method: string; params: { requestId: unknown; reason: string } };
  assert.equal(cancel.method, "notifications/cancelled");
  assert.equal(cancel.params.requestId, upId, "requestId remapped to upstream id");
  assert.equal(cancel.params.reason, "user");
  assert.equal(session.pendingClientRequests, 0, "cancelled request cleared");
});

test("cancellation for an unknown id is dropped (idempotent)", async () => {
  const { upstream, session } = setup();
  await session.fromClient(rpcNotification("notifications/cancelled", { requestId: 999 }));
  assert.equal(upstream.sent.length, 0);
});

test("server-initiated request is routed to the originating client", async () => {
  const { upstream, client, session } = setup();
  upstream.deliver(rpcRequest("s1", "sampling/createMessage", { messages: [] }));
  assert.equal(client.received.length, 1);
  const req = client.received[0] as { id: unknown; method: string };
  assert.equal(req.id, "s1", "upstream id forwarded verbatim to client");
  assert.equal(req.method, "sampling/createMessage");
  assert.equal(session.pendingServerRequests, 1);
  // Client answers; the response goes back upstream unchanged.
  await session.fromClient(rpcResponse("s1", { role: "assistant", content: { type: "text", text: "ok" } }));
  const back = upstream.sent.at(-1) as { id: unknown; result: unknown };
  assert.equal(back.id, "s1");
  assert.deepEqual(back.result, { role: "assistant", content: { type: "text", text: "ok" } });
  assert.equal(session.pendingServerRequests, 0);
});

test("roots/list and elicitation/create are routable server methods", async () => {
  const { upstream, client, session } = setup();
  upstream.deliver(rpcRequest("r1", "roots/list"));
  upstream.deliver(rpcRequest("e1", "elicitation/create", { message: "?" }));
  assert.equal(client.received.length, 2);
  assert.equal(session.pendingServerRequests, 2);
});

test("unroutable server-initiated method gets a deterministic METHOD_NOT_FOUND", async () => {
  const { upstream, client, session } = setup();
  upstream.deliver(rpcRequest("x1", "server/doSomethingWeird"));
  assert.equal(client.received.length, 0, "not delivered to client");
  const err = upstream.sent.at(-1) as { id: unknown; error: { code: number } };
  assert.equal(err.id, "x1");
  assert.equal(err.error.code, JSON_RPC.METHOD_NOT_FOUND);
});

test("dead client causes NO_ELIGIBLE_CLIENT error back upstream", async () => {
  const { upstream, client, session } = setup();
  client.failNextDeliver("client gone");
  upstream.deliver(rpcRequest("s9", "sampling/createMessage"));
  const err = upstream.sent.at(-1) as { id: unknown; error: { code: number } };
  assert.equal(err.id, "s9");
  assert.equal(err.error.code, MCP_ERROR.NO_ELIGIBLE_CLIENT);
  assert.equal(session.pendingServerRequests, 0);
});

test("upstream send failure returns INTERNAL_ERROR to the client and clears state", async () => {
  const { upstream, client, session } = setup();
  upstream.failNextSend("pipe broken");
  await session.fromClient(rpcRequest(3, "tools/list"));
  const err = client.received.at(-1) as { id: unknown; error: { code: number } };
  assert.equal(err.id, 3);
  assert.equal(err.error.code, JSON_RPC.INTERNAL_ERROR);
  assert.equal(session.pendingClientRequests, 0);
});

test("session isolation: a response for an unknown id is never delivered", async () => {
  const { upstream, client, session } = setup();
  await session.fromClient(rpcRequest(1, "tools/list"));
  upstream.deliver(rpcResponse("some-other-session#0", { tools: [] }));
  assert.equal(client.received.length, 0, "foreign response dropped");
  assert.equal(session.pendingClientRequests, 1, "our request still pending");
});

test("two sessions on one upstream do not cross responses", async () => {
  const upstream = makeFakeUpstream();
  const clientA = new CapturingClientSink();
  const clientB = new CapturingClientSink();
  const a = new RelaySession({ sessionId: "A", upstream: upstream.transport, client: clientA, allocateUpstreamId: () => "u-A" });
  const b = new RelaySession({ sessionId: "B", upstream: upstream.transport, client: clientB, allocateUpstreamId: () => "u-B" });
  // NOTE: onmessage is last-writer; simulate demux by delivering only to the
  // session that owns the id via its private handler through the shared bus.
  await a.fromClient(rpcRequest(1, "tools/list"));
  await b.fromClient(rpcRequest(1, "tools/list"));
  // Deliver B's response on the shared transport (b bound onmessage last).
  upstream.deliver(rpcResponse("u-B", { tools: ["b"] }));
  assert.equal(clientB.received.length, 1);
  assert.equal(clientA.received.length, 0, "A must not receive B's response");
});

test("close settles all outstanding requests deterministically", async () => {
  const { upstream, client, session } = setup();
  await session.fromClient(rpcRequest(1, "tools/list"));
  await session.fromClient(rpcRequest(2, "resources/list"));
  upstream.deliver(rpcRequest("srv-1", "roots/list"));
  assert.equal(session.pendingClientRequests, 2);
  assert.equal(session.pendingServerRequests, 1);

  await session.close();

  // Two client requests answered with cancellation.
  const cancels = client.received.filter(
    (m) => "error" in (m as object) && (m as { error: { code: number } }).error.code === MCP_ERROR.REQUEST_CANCELLED,
  );
  assert.equal(cancels.length, 2);
  // Server request answered upstream with NO_ELIGIBLE_CLIENT.
  const srvErr = upstream.sent.find(
    (m) => "error" in (m as object) && (m as { error: { code: number } }).error.code === MCP_ERROR.NO_ELIGIBLE_CLIENT,
  );
  assert.ok(srvErr);
  assert.equal(session.pendingClientRequests, 0);
  assert.equal(session.pendingServerRequests, 0);
});

test("after close, new client requests get an immediate cancellation error", async () => {
  const { client, session } = setup();
  await session.close();
  await session.fromClient(rpcRequest(5, "tools/list"));
  const err = client.received.at(-1) as { id: unknown; error: { code: number } };
  assert.equal(err.id, 5);
  assert.equal(err.error.code, MCP_ERROR.REQUEST_CANCELLED);
});

test("close is idempotent", async () => {
  const { session } = setup();
  await session.close();
  await session.close();
});

test("initialize is forwarded transparently (no gateway handshake interception)", async () => {
  const { upstream, session } = setup();
  const init: JsonRpcMessage = rpcRequest(0, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  await session.fromClient(init);
  const fwd = upstream.sent[0] as { method: string; params: unknown };
  assert.equal(fwd.method, "initialize");
  assert.deepEqual(fwd.params, {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
});
