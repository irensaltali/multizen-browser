/**
 * Parsing of Kopia's JSON stdout.
 *
 * Kopia emits either a single JSON value or, for some commands, a stream of
 * concatenated JSON values (JSON lines). We support both. Parsing is defensive:
 * we never trust the shape blindly and surface a typed error on malformed
 * input rather than throwing a raw SyntaxError.
 */

export class KopiaJsonParseError extends Error {
  constructor(
    message: string,
    readonly rawPreview: string,
  ) {
    super(message);
    this.name = "KopiaJsonParseError";
  }
}

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/**
 * Parse a single JSON value from Kopia stdout.
 *
 * @throws KopiaJsonParseError when the text is empty or not valid JSON.
 */
export function parseJson<T = unknown>(stdout: string): T {
  const text = stdout.trim();
  if (text.length === 0) {
    throw new KopiaJsonParseError("empty stdout, expected JSON", "");
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new KopiaJsonParseError(`invalid JSON: ${reason}`, preview(text));
  }
}

/**
 * Parse a JSON array from Kopia stdout, tolerating two shapes:
 *  1. A single JSON array:            `[ {...}, {...} ]`
 *  2. Newline-delimited JSON objects: `{...}\n{...}\n`
 *
 * @throws KopiaJsonParseError when neither shape parses cleanly.
 */
export function parseJsonArray<T = unknown>(stdout: string): T[] {
  const text = stdout.trim();
  if (text.length === 0) return [];

  // Fast path: a proper JSON array.
  if (text.startsWith("[")) {
    const value = parseJson<unknown>(text);
    if (!Array.isArray(value)) {
      throw new KopiaJsonParseError("expected a JSON array", preview(text));
    }
    return value as T[];
  }

  // Fallback: newline-delimited JSON objects (NDJSON), which Kopia may emit as
  // a stream. A single JSON value that is not an array is rejected — the caller
  // asked for a list. Genuine NDJSON has multiple lines.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length <= 1) {
    // Either a single scalar/object (not a list) or empty — reject as non-array.
    throw new KopiaJsonParseError("expected a JSON array", preview(text));
  }

  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new KopiaJsonParseError(`invalid JSON line: ${reason}`, preview(line));
    }
  }
  return out;
}
