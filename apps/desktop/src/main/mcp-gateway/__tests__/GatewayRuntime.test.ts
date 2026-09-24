import assert from "node:assert/strict";
import test from "node:test";

import { parseProjectConfig, type ClientSink, type JsonRpcMessage } from "@multizen/mcp-gateway";
import { GatewayRuntime } from "../GatewayRuntime.ts";
import { fakeStdioFactory } from "./testSupport.ts";

function stdioProject(over: Record<string, unknown> = {}): ReturnType<typeof parseProjectConfig> {
  return parseProjectConfig({
    configVersion: 1,
    id: "p1",
    enabled: true,
    localAuth: { enabled: false },
    servers: [
      {
        transport: "stdio",
        id: "s1",
        disabled: false,
        command: "echo",
        args: ["hi"],
        env: {},
      },
    ],
    ...over,
  });
}

test("enabled stdio server starts; disabled stays stopped", async () => {
  const rt = new GatewayRuntime({ stdioFactory: fakeStdioFactory() });
  await rt.reconcile([stdioProject()]);
  assert.equal(rt.hasLiveServer("p1", "s1"), true);
  assert.equal(rt.status()[0]?.phase, "running");

  const disabled = stdioProject({
    servers: [{ transport: "stdio", id: "s1", disabled: true, command: "echo", args: [], env: {} }],
  });
  await rt.reconcile([disabled]);
  assert.equal(rt.hasLiveServer("p1", "s1"), false);
  assert.equal(rt.status()[0]?.phase, "disabled");
  await rt.shutdown();
});

test("project-level disabled leaves servers stopped", async () => {
  const rt = new GatewayRuntime({ stdioFactory: fakeStdioFactory() });
  await rt.reconcile([stdioProject({ enabled: false })]);
  assert.equal(rt.hasLiveServer("p1", "s1"), false);
  assert.equal(rt.status()[0]?.phase, "disabled");
  await rt.shutdown();
});

test("missing env reference marks the server visible-inactive (env-error), never started", async () => {
  let created = 0;
  const rt = new GatewayRuntime({
    envSource: {},
    envAllow: ["ALLOWED_TOKEN"],
    stdioFactory: fakeStdioFactory(() => {
      created += 1;
    }),
  });
  const proj = stdioProject({
    servers: [
      {
        transport: "stdio",
        id: "s1",
        disabled: false,
        command: "echo",
        args: [],
        env: { TOKEN: "${ALLOWED_TOKEN}" }, // allowlisted but absent from source
      },
    ],
  });
  await rt.reconcile([proj]);
  const st = rt.status()[0];
  assert.equal(st?.phase, "env-error");
  assert.deepEqual(st?.missingEnv, ["ALLOWED_TOKEN"]);
  assert.equal(created, 0, "no child transport was ever created");
  assert.equal(rt.hasLiveServer("p1", "s1"), false);
  await rt.shutdown();
});

test("reconcile stops removed servers and shutdown leaves no children/sessions", async () => {
  const rt = new GatewayRuntime({ stdioFactory: fakeStdioFactory() });
  await rt.reconcile([stdioProject()]);
  assert.equal(rt.hasLiveServer("p1", "s1"), true);
  await rt.reconcile([]); // project removed
  assert.equal(rt.hasLiveServer("p1", "s1"), false);
  assert.equal(rt.status().length, 0);
  await rt.shutdown();
  assert.equal(rt.isQuiescent, true);
});

test("relay routes a client request to the bound upstream and back, isolated per session", async () => {
  const rt = new GatewayRuntime({ stdioFactory: fakeStdioFactory() });
  await rt.reconcile([stdioProject()]);

  const received: JsonRpcMessage[] = [];
  const sink: ClientSink = { deliver: (m) => void received.push(m) };
  const relay = rt.openSession("p1", "s1", "sess-1", sink);
  assert.equal(rt.sessionCount("p1", "s1"), 1);

  await relay.fromClient({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
  // The fake upstream auto-answers on a microtask.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(received.length, 1);
  const resp = received[0] as { id: number; result: { echoed: string } };
  assert.equal(resp.id, 7, "response mapped back to client id");
  assert.equal(resp.result.echoed, "tools/list");

  await rt.closeSession("sess-1");
  assert.equal(rt.sessionCount("p1", "s1"), 0);
  await rt.shutdown();
  assert.equal(rt.isQuiescent, true);
});
