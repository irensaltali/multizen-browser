import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONFIG_VERSION,
  ConfigValidationError,
  migrate,
  parseProjectConfig,
  projectConfigToJson,
  type ProjectConfig,
} from "./projectConfig.js";

function minimalRaw(): Record<string, unknown> {
  return {
    configVersion: CONFIG_VERSION,
    id: "proj",
    servers: [],
  };
}

test("parses minimal config with defaults", () => {
  const cfg = parseProjectConfig(minimalRaw());
  assert.equal(cfg.id, "proj");
  assert.equal(cfg.enabled, true, "project enabled defaults true");
  assert.equal(cfg.localAuth.enabled, false, "localAuth.enabled defaults false");
  assert.deepEqual(cfg.servers, []);
});

test("stdio server variant with env refs", () => {
  const cfg = parseProjectConfig({
    ...minimalRaw(),
    servers: [
      {
        transport: "stdio",
        id: "srv",
        command: "node",
        args: ["server.js"],
        env: { API_TOKEN: "${MY_TOKEN}" },
        cwd: "/work",
      },
    ],
  });
  const s = cfg.servers[0]!;
  assert.equal(s.transport, "stdio");
  assert.equal(s.disabled, false, "disabled defaults false");
  if (s.transport === "stdio") {
    assert.equal(s.env["API_TOKEN"], "${MY_TOKEN}");
    assert.equal(s.cwd, "/work");
  }
});

test("http server variant with header refs", () => {
  const cfg = parseProjectConfig({
    ...minimalRaw(),
    servers: [
      {
        transport: "streamable-http",
        id: "http1",
        disabled: true,
        url: "https://${UP_HOST}/mcp",
        headers: { Authorization: "${UP_TOKEN}" },
      },
    ],
  });
  const s = cfg.servers[0]!;
  assert.equal(s.disabled, true, "desired disabled preserved");
  if (s.transport === "streamable-http") {
    assert.equal(s.headers["Authorization"], "${UP_TOKEN}");
  }
});

test("rejects inline secret in env value (not a pure ref)", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...minimalRaw(),
        servers: [
          { transport: "stdio", id: "s", command: "x", args: [], env: { T: "secret-literal" } },
        ],
      }),
    ConfigValidationError,
  );
});

test("rejects inline secret in header value", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...minimalRaw(),
        servers: [
          {
            transport: "streamable-http",
            id: "s",
            url: "https://x/mcp",
            headers: { Authorization: "Bearer abc" },
          },
        ],
      }),
    ConfigValidationError,
  );
});

test("rejects unknown top-level key", () => {
  assert.throws(
    () => parseProjectConfig({ ...minimalRaw(), rogue: true }),
    ConfigValidationError,
  );
});

test("rejects unknown server key", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...minimalRaw(),
        servers: [{ transport: "stdio", id: "s", command: "x", args: [], env: {}, rogue: 1 }],
      }),
    ConfigValidationError,
  );
});

test("rejects unknown transport", () => {
  assert.throws(
    () => parseProjectConfig({ ...minimalRaw(), servers: [{ transport: "ws", id: "s" }] }),
    ConfigValidationError,
  );
});

test("rejects unsupported (newer) configVersion", () => {
  assert.throws(
    () => parseProjectConfig({ ...minimalRaw(), configVersion: 999 }),
    ConfigValidationError,
  );
});

test("rejects duplicate server ids", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...minimalRaw(),
        servers: [
          { transport: "stdio", id: "dup", command: "a", args: [], env: {} },
          { transport: "stdio", id: "dup", command: "b", args: [], env: {} },
        ],
      }),
    ConfigValidationError,
  );
});

test("rejects invalid ids", () => {
  assert.throws(() => parseProjectConfig({ ...minimalRaw(), id: "bad/id" }), ConfigValidationError);
});

test("rejects env ref in cwd", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...minimalRaw(),
        servers: [{ transport: "stdio", id: "s", command: "x", args: [], env: {}, cwd: "/a/${X}" }],
      }),
    ConfigValidationError,
  );
});

test("migrate stamps version onto pre-versioned draft", () => {
  const migrated = migrate({ id: "p", servers: [] });
  assert.equal(migrated["configVersion"], CONFIG_VERSION);
  const cfg = parseProjectConfig({ id: "p", servers: [] });
  assert.equal(cfg.configVersion, CONFIG_VERSION);
});

test("round-trips through JSON without loss", () => {
  const cfg = parseProjectConfig({
    ...minimalRaw(),
    enabled: false,
    browserProfileId: "profile-123",
    localAuth: { enabled: true, tokenRef: "${LOCAL_TOKEN}" },
    servers: [
      { transport: "stdio", id: "a", command: "node", args: ["x"], env: { E: "${E}" } },
      { transport: "streamable-http", id: "b", url: "https://x/mcp", headers: {} },
    ],
  });
  const json = projectConfigToJson(cfg);
  const reparsed = parseProjectConfig(json);
  assert.deepEqual(reparsed, cfg);
});

test("does not persist expanded env values", () => {
  const cfg: ProjectConfig = parseProjectConfig({
    ...minimalRaw(),
    servers: [{ transport: "stdio", id: "s", command: "x", args: [], env: { T: "${SECRET}" } }],
  });
  const text = JSON.stringify(projectConfigToJson(cfg));
  assert.ok(text.includes("${SECRET}"));
  assert.ok(!text.includes("expanded"));
});
