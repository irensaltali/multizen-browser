/**
 * Pure detection of the "repository is not initialized in the provided storage"
 * condition emitted by the pinned Kopia 0.23.1 binary when a `repository
 * connect` targets a bucket/prefix that has never had a repository created.
 *
 * The matcher is intentionally TIGHT: it recognizes only the specific
 * "not initialized in the provided storage" phrase (case-insensitive, with
 * flexible whitespace). Every other failure — authentication, network,
 * corruption, "invalid repository password", generic "repository not found"
 * without the "provided storage" qualifier — must NOT be treated as a
 * missing-repository condition, so the caller never silently creates a new
 * (empty) repository over what could be a transient or credential failure.
 *
 * Kept as a pure string predicate so it is trivially unit-testable and carries
 * no I/O or secrets. The caller passes the already-redacted error message
 * and/or stderr.
 */

/**
 * The canonical Kopia 0.23.1 phrase, matched case-insensitively with tolerant
 * inter-word whitespace. Anchored on the distinctive
 * "not initialized in the provided storage" wording so unrelated
 * "repository ..." errors cannot match.
 */
const MISSING_REPO_RE =
  /repository\s+not\s+initialized\s+in\s+the\s+provided\s+storage/i;

/**
 * True IFF the supplied text matches the pinned "missing repository in the
 * provided storage" condition. Any non-string input, or any other error text,
 * returns false.
 */
export function isRepositoryNotInitialized(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return MISSING_REPO_RE.test(text);
}
