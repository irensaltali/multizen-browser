import { test } from "node:test";
import assert from "node:assert/strict";

import { buildChildEnv, secretValues, type KopiaSecrets } from "./env.js";

const SECRETS: KopiaSecrets = {
  kopiaPassword: "pw",
  awsAccessKeyId: "AKIA",
  awsSecretAccessKey: "secret",
  awsSessionToken: "token",
};

test("secrets are injected via env only", () => {
  const env = buildChildEnv({ secrets: SECRETS, parentEnv: {} });
  assert.equal(env.KOPIA_PASSWORD, "pw");
  assert.equal(env.AWS_ACCESS_KEY_ID, "AKIA");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, "secret");
  assert.equal(env.AWS_SESSION_TOKEN, "token");
});

test("only whitelisted passthrough keys survive from parent env", () => {
  const env = buildChildEnv({
    secrets: { kopiaPassword: "pw" },
    parentEnv: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      SOME_OTHER_SECRET: "leak-me",
      AWS_PROFILE: "should-not-pass",
    },
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.ok(!("SOME_OTHER_SECRET" in env));
  assert.ok(!("AWS_PROFILE" in env));
});

test("optional AWS creds omitted when not provided", () => {
  const env = buildChildEnv({ secrets: { kopiaPassword: "pw" }, parentEnv: {} });
  assert.ok(!("AWS_ACCESS_KEY_ID" in env));
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in env));
  assert.ok(!("AWS_SESSION_TOKEN" in env));
});

test("update check disabled to limit egress", () => {
  const env = buildChildEnv({ secrets: { kopiaPassword: "pw" }, parentEnv: {} });
  assert.equal(env.KOPIA_CHECK_FOR_UPDATES, "false");
});

test("extra env must not smuggle secret keys", () => {
  assert.throws(
    () =>
      buildChildEnv({
        secrets: { kopiaPassword: "pw" },
        parentEnv: {},
        extra: { AWS_ACCESS_KEY_ID: "x" },
      }),
    /must not contain secret key/,
  );
});

test("secretValues returns only non-empty values", () => {
  assert.deepEqual(secretValues({ kopiaPassword: "pw", awsAccessKeyId: "", awsSessionToken: "t" }), [
    "pw",
    "t",
  ]);
});
