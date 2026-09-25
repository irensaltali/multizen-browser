/**
 * Live feedback for the credential-backup passphrase.
 *
 * Deliberately pure and local to the renderer: assessing a passphrase must not
 * involve sending it anywhere, so this cannot be an IPC call on every keystroke.
 *
 * The HARD FLOOR is not defined here. `minLength` is supplied by the caller from
 * {@link CredentialBackupView.minPassphraseLength}, which the main process reports
 * from the one constant it actually enforces. Keeping a second copy of the limit
 * in the renderer is exactly how a UI ends up accepting something the backend
 * then rejects, so the renderer is told the rule rather than repeating it.
 *
 * Everything above the floor is advice, not enforcement. A long passphrase made
 * of one repeated character clears any length test, so the score also looks at
 * how much variety there is and how many distinct characters were actually used.
 */

export type PassphraseVerdict = "too-short" | "weak" | "fair" | "strong";

export interface PassphraseAssessment {
  /** False when the main process would refuse it outright. */
  readonly acceptable: boolean;
  readonly verdict: PassphraseVerdict;
  /** One actionable sentence, or null when nothing needs saying. */
  readonly advice: string | null;
}

/** Rough character-class variety: lower, upper, digit, other, and spaces. */
function variety(value: string): number {
  let score = 0;
  if (/[a-z]/.test(value)) score += 1;
  if (/[A-Z]/.test(value)) score += 1;
  if (/[0-9]/.test(value)) score += 1;
  if (/[^A-Za-z0-9\s]/.test(value)) score += 1;
  if (/\s/.test(value)) score += 1;
  return score;
}

export function assessPassphrase(value: string, minLength: number): PassphraseAssessment {
  if (value.length < minLength) {
    return {
      acceptable: false,
      verdict: "too-short",
      advice:
        value.length === 0
          ? null
          : `At least ${minLength} characters — ${minLength - value.length} more to go.`,
    };
  }

  // Distinct characters, not just length: "aaaaaaaaaaaaaa" is long and terrible.
  const distinct = new Set(value).size;
  const v = variety(value);

  if (distinct < 6) {
    return {
      acceptable: true,
      verdict: "weak",
      advice: "Long but repetitive. Use more different characters.",
    };
  }
  if (value.length >= 20 || (value.length >= 16 && v >= 3)) {
    return { acceptable: true, verdict: "strong", advice: null };
  }
  if (v >= 2) {
    return {
      acceptable: true,
      verdict: "fair",
      advice: "A few more words would make this considerably harder to guess.",
    };
  }
  return {
    acceptable: true,
    verdict: "weak",
    advice: "Mix in another kind of character, or use several unrelated words.",
  };
}
