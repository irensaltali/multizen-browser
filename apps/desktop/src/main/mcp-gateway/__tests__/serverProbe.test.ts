import assert from "node:assert/strict";
import test from "node:test";

import type {
  GatewayTransport,
  HttpTransportSpec,
  JsonRpcMessage,
  ServerConfig,
  StdioTransportSpec,
} from "@multizen/mcp-gateway";

import { probeReferencedNames, probeServer } from "../ServerProbe.ts";

/**
 * Tests for the one-shot connection test.
 *
 * The transports are faked so every branch — a well-behaved server, one that
 * refuses, one that dies on spawn, one that hangs, one that echoes its own
 * credentials — is reachable without a real child process or network.
 */

const TOKEN = "sk-live-super-secret-1234";

interface Scripted extends GatewayTransport {
  readonly sent: JsonRpcMessage[];
  readonly spec: StdioTransportSpec | HttpTransportSpec;
  closed: number;
  onStderr?: (chunk: string) => void;
}

interface ScriptOptions {
  /** Capabilities returned from initialize. Omit `tools` to advertise none. */
  readonly capabilities?: Record<string, unknown>;
  readonly tools?: ReadonlyArray<{ name: string }>;
  /** Fail initialize with this JSON-RPC error message. */
  readonly initError?: string;
  /** Throw from start(), as a failed spawn does. */
  readonly startError?: string;
  /** Answer nothing, so the deadline decides. */
  readonly hang?: boolean;
  /** Emit these stderr chunks during start(). */
  readonly stderr?: readonly string[];
  /** Close the transport during start() without answering. */
  readonly dieOnStart?: boolean;
}

function scripted(opts: ScriptOptions = {}): {
  factory: (spec: StdioTransportSpec | HttpTransportSpec) => Scripted;
  created: Scripted[];
} {
  const created: Scripted[] = [];
  const factory = (spec: StdioTransportSpec | HttpTransportSpec): Scripted => {
    const sent: JsonRpcMessage[] = [];
    const t: Scripted = {
      spec,
      sent,
      closed: 0,
      async start(): Promise<void> {
        for (const chunk of opts.stderr ?? []) t.onStderr?.(chunk);
        if (opts.startError !== undefined) throw new Error(opts.startError);
        if (opts.dieOnStart === true) queueMicrotask(() => t.onclose?.());
      },
      async close(): Promise<void> {
        t.closed += 1;
      },
      async send(message: JsonRpcMessage): Promise<void> {
        sent.push(message);
        if (opts.hang === true) return;
        if (!("id" in message) || !("method" in message)) return;
        const req = message as { id: number; method: string };
        queueMicrotask(() => {
          if (req.method === "initialize") {
            if (opts.initError !== undefined) {
              t.onmessage?.({
                jsonrpc: "2.0",
                id: req.id,
                error: { code: -32602, message: opts.initError },
              });
              return;
            }
            t.onmessage?.({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: opts.capabilities ?? { tools: {} },
                serverInfo: { name: "docs-mcp", version: "2.1.0" },
              },
            });
            return;
          }
          if (req.method === "tools/list") {
            t.onmessage?.({
              jsonrpc: "2.0",
              id: req.id,
              result: { tools: opts.tools ?? [{ name: "search" }, { name: "fetch" }] },
            });
          }
        });
      },
    };
    created.push(t);
    return t;
  };
  return { factory, created };
}

function options(
  s: ReturnType<typeof scripted>,
  over: { timeoutMs?: number; baseEnv?: Record<string, string> } = {},
) {
  return {
    stdioFactory: s.factory as never,
    httpFactory: s.factory as never,
    baseEnv: over.baseEnv ?? { PATH: "/usr/bin" },
    timeoutMs: over.timeoutMs ?? 200,
  };
}

function stdio(over: Partial<Record<string, unknown>> = {}): ServerConfig {
  return {
    transport: "stdio",
    id: "docs",
    disabled: false,
    command: "npx",
    args: ["-y", "docs-mcp"],
    env: {},
    ...over,
  } as unknown as ServerConfig;
}

function http(over: Partial<Record<string, unknown>> = {}): ServerConfig {
  return {
    transport: "streamable-http",
    id: "api",
    disabled: false,
    url: "https://mcp.example.com/mcp",
    headers: {},
    ...over,
  } as unknown as ServerConfig;
}

test("probeReferencedNames collects every reference, sorted and deduplicated", () => {
  assert.deepEqual(
    probeReferencedNames(stdio({ env: { B: "${TWO}", A: "${ONE}", C: "${ONE}" } })),
    ["ONE", "TWO"],
  );
  assert.deepEqual(
    probeReferencedNames(http({ url: "https://${HOST}/mcp", headers: { A: "${TOK}" } })),
    ["HOST", "TOK"],
  );
});

test("a well-behaved stdio server reports its identity and tools", async () => {
  const s = scripted();
  const result = await probeServer({ server: stdio(), resolved: {} }, options(s));

  assert.equal(result.ok, true);
  assert.equal(result.serverName, "docs-mcp");
  assert.equal(result.serverVersion, "2.1.0");
  assert.equal(result.protocolVersion, "2025-11-25");
  assert.equal(result.toolCount, 2);
  assert.deepEqual(result.toolNames, ["search", "fetch"]);
  assert.equal(typeof result.durationMs, "number");
});

test("the handshake is completed properly: initialize, initialized, then tools/list", async () => {
  const s = scripted();
  await probeServer({ server: stdio(), resolved: {} }, options(s));

  const methods = s.created[0]!.sent.map((m) => (m as { method: string }).method);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
});

test("the transport is always closed, including after a failure", async () => {
  const good = scripted();
  await probeServer({ server: stdio(), resolved: {} }, options(good));
  assert.equal(good.created[0]?.closed, 1, "closed after success");

  const bad = scripted({ hang: true });
  await probeServer({ server: stdio(), resolved: {} }, options(bad, { timeoutMs: 40 }));
  assert.equal(bad.created[0]?.closed, 1, "closed after a timeout — no orphaned child");
});

test("a server advertising no tools capability is still a pass, with no tool count", async () => {
  const s = scripted({ capabilities: {} });
  const result = await probeServer({ server: stdio(), resolved: {} }, options(s));

  assert.equal(result.ok, true);
  assert.equal(result.toolCount, undefined);
  const methods = s.created[0]!.sent.map((m) => (m as { method: string }).method);
  assert.ok(!methods.includes("tools/list"), "tools/list is not sent when unsupported");
});

test("references are resolved into the launch spec, exactly like a real start", async () => {
  const s = scripted();
  await probeServer(
    { server: stdio({ env: { API_TOKEN: "${TOK}" } }), resolved: { TOK: TOKEN } },
    options(s, { baseEnv: { PATH: "/usr/bin" } }),
  );

  const spec = s.created[0]!.spec as StdioTransportSpec;
  assert.equal(spec.command, "npx");
  assert.deepEqual(spec.args, ["-y", "docs-mcp"]);
  assert.equal(spec.env["API_TOKEN"], TOKEN);
  assert.equal(spec.env["PATH"], "/usr/bin", "the allowlisted base env is inherited");
});

test("an http url and headers are templated from references", async () => {
  const s = scripted();
  await probeServer(
    {
      server: http({ url: "https://${HOST}/mcp", headers: { Authorization: "${TOK}" } }),
      resolved: { HOST: "mcp.example.com", TOK: `Bearer ${TOKEN}` },
    },
    options(s),
  );

  const spec = s.created[0]!.spec as HttpTransportSpec;
  assert.equal(spec.url, "https://mcp.example.com/mcp");
  assert.equal(spec.headers["Authorization"], `Bearer ${TOKEN}`);
});

test("a missing reference is named and nothing is launched", async () => {
  const s = scripted();
  const result = await probeServer(
    { server: stdio({ env: { A: "${ONE}", B: "${TWO}" } }), resolved: { ONE: "x" } },
    options(s),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingRefs, ["TWO"]);
  assert.match(result.error ?? "", /TWO/);
  assert.equal(s.created.length, 0, "a server is never started with a blank credential");
});

test("a refused initialize is reported with the server's reason", async () => {
  const s = scripted({ initError: "unsupported protocol version" });
  const result = await probeServer({ server: stdio(), resolved: {} }, options(s));

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /unsupported protocol version/);
  assert.match(result.hint ?? "", /protocol/i);
});

test("a failed spawn is explained with an actionable hint and the child's output", async () => {
  const s = scripted({
    startError: "spawn npx ENOENT",
    stderr: ["sh: npx: command not found\n"],
  });
  const result = await probeServer({ server: stdio(), resolved: {} }, options(s));

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ENOENT/);
  assert.match(result.hint ?? "", /could not be found/i);
  assert.deepEqual(result.stderr, ["sh: npx: command not found"]);
});

test("a hang is cut off at the deadline rather than waiting forever", async () => {
  const s = scripted({ hang: true });
  const started = Date.now();
  const result = await probeServer({ server: stdio(), resolved: {} }, options(s, { timeoutMs: 60 }));

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no response/i);
  assert.match(result.hint ?? "", /speaks MCP on stdout/i);
  assert.ok(Date.now() - started < 2_000, "returned promptly, not after the default 15s");
});

test("a server that closes mid-handshake says so instead of timing out silently", async () => {
  const s = scripted({ hang: true, dieOnStart: true });
  const result = await probeServer({ server: stdio(), resolved: {} }, options(s, { timeoutMs: 500 }));

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /closed the connection/i);
});

test("a resolved secret is never echoed back, even when the server prints it", async () => {
  const s = scripted({
    startError: `failed to authenticate with ${TOKEN}`,
    stderr: [`DEBUG using token ${TOKEN}\n`],
  });
  const result = await probeServer(
    { server: stdio({ env: { API_TOKEN: "${TOK}" } }), resolved: { TOK: TOKEN } },
    options(s),
  );

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(TOKEN), "the value must not reach the UI");
  assert.match(result.error ?? "", /«hidden»/);
  assert.match(result.stderr?.join("\n") ?? "", /«hidden»/);
});

test("an unexpected throw is reported rather than propagated", async () => {
  const exploding = {
    stdioFactory: () => {
      throw new Error("factory blew up");
    },
    httpFactory: () => {
      throw new Error("unused");
    },
    timeoutMs: 100,
  };
  const result = await probeServer({ server: stdio(), resolved: {} }, exploding as never);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /factory blew up/);
});
