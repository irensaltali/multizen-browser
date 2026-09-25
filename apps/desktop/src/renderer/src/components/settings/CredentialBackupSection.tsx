import { useCallback, useEffect, useState, type JSX } from "react";
import { KeyRound, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "../atoms/Button";
import type { CredentialBackupView } from "../../types";
import { assessPassphrase, type PassphraseAssessment } from "./passphraseStrength";

/**
 * Opt-in backup of MCP server credentials.
 *
 * Off by default, and it stays off until the operator types a passphrase, because
 * turning it on changes what leaves the machine. The copy says so plainly rather
 * than reassuringly: the honest summary of the trade is that secrets gain a second
 * place they can be lost from, and that a forgotten passphrase is unrecoverable.
 *
 * The passphrase is write-only across the bridge. It is held in component state
 * only while being typed, cleared as soon as the call returns, and there is no
 * bridge method that reads one back.
 */
export function CredentialBackupSection(): JSX.Element | null {
  const [view, setView] = useState<CredentialBackupView | null>(null);
  const [available, setAvailable] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const gw = window.multizen?.gateway;
    if (!gw?.credentialBackup) {
      setAvailable(false);
      return;
    }
    try {
      const res = await gw.credentialBackup();
      if (res.ok) setView(res.value);
      else setAvailable(false);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    if (view !== null && view.syncing) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh, view]);

  if (!available) return null;

  const minLength = view?.minPassphraseLength ?? 12;
  const assessment: PassphraseAssessment = assessPassphrase(passphrase, minLength);
  const mismatch = confirmation.length > 0 && confirmation !== passphrase;
  const canEnable =
    assessment.acceptable && confirmation === passphrase && !busy && view?.syncing === true;

  /** Wipe every passphrase field. Called on success AND on failure. */
  function clearInputs(): void {
    setPassphrase("");
    setConfirmation("");
    setRestorePassphrase("");
  }

  async function enable(): Promise<void> {
    const gw = window.multizen?.gateway;
    if (!gw?.enableCredentialBackup) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await gw.enableCredentialBackup(passphrase);
      if (res.ok) {
        setView(res.value);
        setMessage("Credential backup is on. Store the passphrase somewhere safe.");
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // The passphrase never lingers in component state, whatever happened.
      clearInputs();
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    const gw = window.multizen?.gateway;
    if (!gw?.disableCredentialBackup) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await gw.disableCredentialBackup();
      if (res.ok) {
        setView(res.value);
        setMessage(
          "Credential backup is off. The stored copy was cleared; credentials on this device are untouched.",
        );
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInputs();
      setBusy(false);
    }
  }

  async function restore(): Promise<void> {
    const gw = window.multizen?.gateway;
    if (!gw?.restoreCredentials) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await gw.restoreCredentials(restorePassphrase);
      if (res.ok) {
        setMessage(
          res.value.restored === 0
            ? "Nothing to restore — the stored backup is empty."
            : `Restored ${res.value.restored} credential${res.value.restored === 1 ? "" : "s"}` +
              (res.value.projects.length > 0 ? ` for ${res.value.projects.join(", ")}.` : "."),
        );
        await refresh();
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInputs();
      setBusy(false);
    }
  }

  return (
    <div className="pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
      <div className="flex items-center gap-2 mt-3">
        <KeyRound size={13} className="text-slate-400" />
        <span className="text-[12px] text-slate-200 font-medium">Back up MCP credentials</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            view?.enabled === true ? "bg-emerald-500/15 text-emerald-300" : "bg-white/[0.06] text-slate-400"
          }`}
          data-testid="credential-backup-state"
        >
          {view?.enabled === true ? "On" : "Off"}
        </span>
      </div>

      {/*
        The blunt statement. Written as a trade with two named costs rather than a
        feature blurb, because switching this on is a security decision and the
        operator should be able to decline it on an informed basis.
      */}
      <div className="text-[11px] text-slate-500 leading-relaxed mt-2 max-w-[560px]">
        Normally the API keys and tokens your MCP servers use never leave this
        machine — they stay in OS secure storage and only a <span className="mono">{"${NAME}"}</span>{" "}
        reference is synced. Switching this on puts them in your bucket as well,
        encrypted with a <strong>second passphrase</strong> that is separate from your
        encryption password, so a new device can be set up without pasting every key
        again.
        <div className="mt-1.5 text-slate-400">
          The trade, stated plainly: your secrets gain another place they can be
          stolen from, and{" "}
          <strong className="text-amber-300/90">
            if you forget the passphrase nobody can recover the backup
          </strong>{" "}
          — not us, not a reset link. Your bucket credentials and your encryption
          password are never included, whatever you choose here.
        </div>
      </div>

      {view?.syncing === false && (
        <div className="text-[11px] text-amber-400/90 mt-2 inline-flex items-start gap-1">
          <TriangleAlert size={11} className="shrink-0 mt-[1px]" />
          Set up Cloud Sync above first — there is nowhere to store a backup yet.
        </div>
      )}

      {view?.remoteIssue !== null && view?.remoteIssue !== undefined && (
        <div
          className="text-[11px] text-amber-300/90 mt-2 leading-relaxed"
          role="alert"
          data-testid="credential-backup-remote-issue"
        >
          <span className="inline-flex items-start gap-1">
            <TriangleAlert size={11} className="shrink-0 mt-[1px]" />
            <span>
              The stored credential backup is blocked: {view.remoteIssue.message}. On a trusted
              Mac, open Projects, choose Devices, and approve this device, then retry sync.
            </span>
          </span>
        </div>
      )}

      {view !== null && (
        <div className="text-[11px] text-slate-600 mt-2" data-testid="credential-backup-counts">
          {view.localCount} credential{view.localCount === 1 ? "" : "s"} on this device
          {view.remotePresent === true
            ? " · a backup is stored in your bucket"
            : view.remotePresent === false
              ? " · no backup stored yet"
              : ""}
        </div>
      )}

      {view?.enabled === true ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void disable()} disabled={busy}>
            {busy ? "Working…" : "Turn off and clear the backup"}
          </Button>
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-600">
            <ShieldCheck size={11} /> Updated automatically when a credential changes.
          </span>
        </div>
      ) : (
        <div className="mt-3 space-y-2 max-w-[420px]">
          <label className="block">
            <span className="text-[11px] text-slate-500">Credential passphrase</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={`At least ${minLength} characters`}
              aria-label="Credential passphrase"
              autoComplete="new-password"
              disabled={busy}
              className="mt-1 w-full px-2.5 h-8 rounded-md bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none"
              style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-500">Repeat it</span>
            <input
              type="password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              aria-label="Repeat credential passphrase"
              autoComplete="new-password"
              disabled={busy}
              className="mt-1 w-full px-2.5 h-8 rounded-md bg-white/[0.03] text-[12px] text-slate-200 outline-none"
              style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
            />
          </label>

          {passphrase.length > 0 && (
            <div
              className={`text-[11px] ${
                assessment.verdict === "strong"
                  ? "text-emerald-400/90"
                  : assessment.verdict === "fair"
                    ? "text-slate-400"
                    : "text-amber-400/90"
              }`}
              data-testid="passphrase-verdict"
            >
              {assessment.verdict === "too-short"
                ? "Too short"
                : assessment.verdict === "weak"
                  ? "Weak"
                  : assessment.verdict === "fair"
                    ? "Fair"
                    : "Strong"}
              {assessment.advice !== null && ` — ${assessment.advice}`}
            </div>
          )}
          {mismatch && (
            <div className="text-[11px] text-amber-400/90" data-testid="passphrase-mismatch">
              The two entries do not match.
            </div>
          )}

          <Button size="sm" onClick={() => void enable()} disabled={!canEnable}>
            {busy ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" /> Publishing…
              </span>
            ) : (
              "Turn on credential backup"
            )}
          </Button>
        </div>
      )}

      {/*
        Restore is offered whenever a backup exists, independently of whether this
        device publishes one: pulling credentials onto a new machine is the point
        of the feature, and that machine has not opted in to anything yet.
      */}
      {view?.remotePresent === true && (
        <div className="mt-4 max-w-[420px]">
          <div className="text-[11px] text-slate-500">
            Restore credentials onto this device
          </div>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="password"
              value={restorePassphrase}
              onChange={(e) => setRestorePassphrase(e.target.value)}
              placeholder="Credential passphrase"
              aria-label="Credential passphrase to restore"
              autoComplete="off"
              disabled={busy}
              className="flex-1 px-2.5 h-8 rounded-md bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none"
              style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void restore()}
              disabled={busy || restorePassphrase.length === 0}
            >
              Restore
            </Button>
          </div>
        </div>
      )}

      {error !== null && (
        <div
          className="text-[11px] text-amber-400/90 mt-2 inline-flex items-start gap-1"
          role="alert"
        >
          <TriangleAlert size={11} className="shrink-0 mt-[1px]" /> {error}
        </div>
      )}
      {message !== null && (
        <div className="text-[11px] text-emerald-400/90 mt-2" role="status">
          {message}
        </div>
      )}
    </div>
  );
}
