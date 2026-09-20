/**
 * Crypto helpers. Lease ids are random opaque tokens returned to the client;
 * only their SHA-256 hash is persisted, so a leaked DB row cannot be replayed
 * to renew/release a lease without knowing the original token.
 */

const LEASE_ID_BYTES = 32;

export function generateLeaseId(): string {
  const bytes = new Uint8Array(LEASE_ID_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function hashLeaseId(leaseId: string): Promise<string> {
  const data = new TextEncoder().encode(leaseId);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(digest));
}

/**
 * Constant-time comparison of two equal-length base64url strings. Guards the
 * lease-id check against timing side channels.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
