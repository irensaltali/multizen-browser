/**
 * Deterministic canonical JSON serialization.
 *
 * Produces a stable byte representation of a JSON value: object keys are sorted
 * lexicographically (by UTF-16 code unit, matching `Array.prototype.sort`), and
 * there is no insignificant whitespace. This is the single source of truth used
 * both for config hashing and for Ed25519 envelope signing so that two devices
 * independently serializing the same logical value produce identical bytes.
 *
 * Only JSON-safe values are permitted. `undefined`, functions, symbols, BigInt,
 * NaN/Infinity, and circular references are rejected rather than silently
 * coerced, because signing over ambiguous input is a security hazard.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  override readonly name = "CanonicalJsonError";
}

function assertFiniteNumber(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(`Non-finite number at ${path}`);
  }
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    assertFiniteNumber(value as number, path);
    return JSON.stringify(value);
  }
  if (t === "undefined") {
    throw new CanonicalJsonError(`undefined is not serializable at ${path}`);
  }
  if (t === "bigint") {
    throw new CanonicalJsonError(`BigInt is not serializable at ${path}`);
  }
  if (t === "function" || t === "symbol") {
    throw new CanonicalJsonError(`${t} is not serializable at ${path}`);
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalJsonError(`Circular reference at ${path}`);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item, i) => encode(item, `${path}[${i}]`, seen));
      return `[${parts.join(",")}]`;
    }
    const entries = Object.entries(obj as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = entries.map(
      ([k, v]) => `${JSON.stringify(k)}:${encode(v, `${path}.${k}`, seen)}`,
    );
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Serialize a JSON value to its canonical string form. */
export function canonicalize(value: JsonValue): string {
  return encode(value, "$", new Set());
}

/** Canonical UTF-8 bytes, the input to hashing/signing. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
