import { describe, expect, it } from "vitest";

import { assessPassphrase } from "../passphraseStrength";

/**
 * The floor is supplied by the caller, not hard-coded here — the main process is
 * the only place that enforces it. These tests therefore pass a length in
 * explicitly and check the rule is applied to whatever it is given, which is what
 * keeps the renderer from developing an opinion of its own.
 */
describe("assessPassphrase", () => {
  it("refuses anything below the supplied minimum", () => {
    const a = assessPassphrase("short", 12);
    expect(a.acceptable).toBe(false);
    expect(a.verdict).toBe("too-short");
    expect(a.advice).toBe("At least 12 characters — 7 more to go.");
  });

  it("uses the minimum it is given rather than a built-in constant", () => {
    // Same input, different policy: the verdict has to follow the argument.
    expect(assessPassphrase("abcdefghij", 8).acceptable).toBe(true);
    expect(assessPassphrase("abcdefghij", 20).acceptable).toBe(false);
    expect(assessPassphrase("abcdefghij", 20).advice).toContain("At least 20 characters");
  });

  it("says nothing at all for an empty field", () => {
    // Nagging before anything is typed is noise, not guidance.
    expect(assessPassphrase("", 12)).toEqual({
      acceptable: false,
      verdict: "too-short",
      advice: null,
    });
  });

  it("calls a long but repetitive passphrase weak", () => {
    // Long enough to pass any length check, and terrible.
    const a = assessPassphrase("aaaaaaaaaaaaaaaaaaaa", 12);
    expect(a.acceptable).toBe(true);
    expect(a.verdict).toBe("weak");
    expect(a.advice).toContain("repetitive");
  });

  it("rates a long varied passphrase strong and says nothing further", () => {
    const a = assessPassphrase("correct horse battery staple", 12);
    expect(a.verdict).toBe("strong");
    expect(a.advice).toBeNull();
  });

  it("rates a medium mixed passphrase fair with a suggestion", () => {
    const a = assessPassphrase("Grapefruit12", 12);
    expect(a.verdict).toBe("fair");
    expect(a.advice).toContain("more words");
  });

  it("accepts but flags a single-class passphrase at the floor", () => {
    const a = assessPassphrase("grapefruitse", 12);
    expect(a.acceptable).toBe(true);
    expect(a.verdict).toBe("weak");
  });
});
