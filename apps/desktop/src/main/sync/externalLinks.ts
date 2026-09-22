/**
 * Pure URL allowlist for the `system:openExternal` IPC. The renderer must never
 * be able to open arbitrary schemes or hosts through the main process, so this
 * helper permits EXACTLY the attribution link and nothing else:
 *
 *   - scheme must be https,
 *   - host must be irensaltali.com,
 *   - path must be empty or a single trailing slash,
 *   - no query, no fragment, no userinfo, no port.
 *
 * Kept pure (no Electron import) so it is trivially unit-testable.
 */

const ALLOWED_HOST = "irensaltali.com";

/** True IFF `url` is exactly https://irensaltali.com (optional trailing slash). */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== ALLOWED_HOST) return false;
  if (parsed.port !== "") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return false;
  return true;
}
