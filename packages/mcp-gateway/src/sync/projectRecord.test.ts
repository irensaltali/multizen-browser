import assert from "node:assert/strict";
import { test } from "node:test";

import { assertProjectId } from "../ids.js";
import { CONFIG_VERSION, parseProjectConfig } from "../projectConfig.js";
import { signProject } from "../trust.js";
import { InMemoryVault } from "../vault.js";
import { generateSaltHex, seal } from "./crypto.js";
import {
  decodeRecord,
  encodeRecord,
  PROJECT_RECORD_VERSION,
  RecordError,
  type ProjectRecord,
} from "./projectRecord.js";

async function sampleRecord(): Promise<ProjectRecord> {
  const key = await new InMemoryVault().getOrCreateSigningKey();
  const config = parseProjectConfig({
    configVersion: CONFIG_VERSION,
    id: "proj",
    servers: [{ transport: "stdio", id: "s", command: "node", args: [], env: {} }],
  });
  const envelope = await signProject(key, assertProjectId("proj"), 1, config);
  const payload = seal("pw", new TextEncoder().encode(JSON.stringify(config)), {
    saltHex: generateSaltHex(),
    context: "proj",
  });
  return { recordVersion: PROJECT_RECORD_VERSION, envelope, payload };
}

test("encode/decode round-trips a record", async () => {
  const rec = await sampleRecord();
  const decoded = decodeRecord(encodeRecord(rec));
  assert.deepEqual(decoded, rec);
});

test("unknown top-level key rejected", async () => {
  const rec = await sampleRecord();
  const obj = JSON.parse(new TextDecoder().decode(encodeRecord(rec))) as Record<string, unknown>;
  obj.extra = true;
  assert.throws(
    () => decodeRecord(new TextEncoder().encode(JSON.stringify(obj))),
    (e: unknown) => e instanceof RecordError && e.code === "malformed",
  );
});

test("bad revision rejected", async () => {
  const rec = await sampleRecord();
  const obj = JSON.parse(new TextDecoder().decode(encodeRecord(rec))) as Record<string, unknown>;
  (obj.envelope as Record<string, unknown>).revision = 0;
  assert.throws(
    () => decodeRecord(new TextEncoder().encode(JSON.stringify(obj))),
    (e: unknown) => e instanceof RecordError,
  );
});

test("oversized record rejected", async () => {
  const rec = await sampleRecord();
  const bloated: ProjectRecord = {
    ...rec,
    payload: { ...rec.payload, ciphertext: "A".repeat(300 * 1024) },
  };
  assert.throws(
    () => encodeRecord(bloated),
    (e: unknown) => e instanceof RecordError && e.code === "too-large",
  );
});

test("non-JSON body rejected", () => {
  assert.throws(
    () => decodeRecord(new TextEncoder().encode("not json")),
    (e: unknown) => e instanceof RecordError && e.code === "malformed",
  );
});
