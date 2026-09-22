import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedExternalUrl } from "../externalLinks.ts";

test("isAllowedExternalUrl allows exactly https://irensaltali.com (with optional trailing slash)", () => {
  assert.equal(isAllowedExternalUrl("https://irensaltali.com"), true);
  assert.equal(isAllowedExternalUrl("https://irensaltali.com/"), true);
});

test("isAllowedExternalUrl rejects other schemes, hosts, paths, ports, and payloads", () => {
  for (const bad of [
    "http://irensaltali.com",
    "https://irensaltali.com/foo",
    "https://irensaltali.com?x=1",
    "https://irensaltali.com#frag",
    "https://irensaltali.com:8443",
    "https://user:pw@irensaltali.com",
    "https://evil.irensaltali.com",
    "https://irensaltali.com.evil.com",
    "https://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "irensaltali.com",
    "",
    "not a url",
  ]) {
    assert.equal(isAllowedExternalUrl(bad), false, `should reject: ${bad}`);
  }
});
