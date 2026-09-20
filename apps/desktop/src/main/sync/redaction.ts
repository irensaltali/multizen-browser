/**
 * Secret redaction for sync diagnostics, journal messages, and error text.
 *
 * The sync controller surfaces status/diagnostics and records operation
 * messages. None of these must ever carry a secret value. `redact` scrubs a
 * set of known secret values from any string; `redactError` normalizes an
 * arbitrary thrown value into a safe, redacted message.
 */

/**
 * Replace every occurrence of each secret value with a fixed marker. Longer
 * secrets are redacted first so a secret that is a substring of another is not
 * left partially exposed. Short strings (< 4 chars) are ignored so redaction
 * can't scrub an entire message down to markers.
 */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  const values = [
    ...new Set(secrets.filter((s): s is string => typeof s === "string" && s.length >= 4)),
  ].sort((a, b) => b.length - a.length);
  for (const secret of values) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/** Normalize + redact an unknown thrown value into a safe message string. */
export function redactError(
  err: unknown,
  secrets: readonly (string | null | undefined)[],
): string {
  const message = err instanceof Error ? err.message : String(err);
  return redact(message, secrets);
}
