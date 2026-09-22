import { useCallback, useEffect, useState, type JSX } from "react";
import { Check, Copy, Loader2, TriangleAlert, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../atoms/Button";
import { Pill } from "../atoms";
import type { ProfileSyncStatusView, SyncProgressEvent } from "../../types";

/**
 * Per-profile Cloud Sync panel inside the edit sheet.
 *
 * Normal path: sync is AUTOMATIC and whole-library. This profile is part of the
 * library sync — its data + sanitized metadata back up automatically after the
 * browser closes, and it restores/uploads automatically as part of the library
 * bootstrap. The operator does NOT press Acquire/Restore/Back up/Release in the
 * normal workflow.
 *
 * The per-profile checkbox is a DESTRUCTIVE remote-disable: unchecking it
 * deletes this profile's cloud backup (tombstone + snapshot manifests) after a
 * STRONG typed confirmation, while keeping the local profile + data. Re-checking
 * revives sync and uploads the profile as a fresh backup.
 *
 * Advanced controls (Acquire/Restore/Back up now/Release/Copy Sync ID) are
 * tucked behind a disclosure as retry/fallback tools, not the normal path.
 */

interface Props {
  profileId: string;
  profileName: string;
}

export function ProfileSyncSection({ profileId, profileName }: Props): JSX.Element {
  const [status, setStatus] = useState<ProfileSyncStatusView | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Strong-typed delete confirmation state.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const refresh = useCallback(async () => {
    if (!window.multizen?.sync) {
      setAvailable(false);
      return;
    }
    const res = await window.multizen.sync.status(profileId);
    if (res.ok) setStatus(res.value);
    else setAvailable(false);
  }, [profileId]);

  useEffect(() => {
    void refresh();
    if (!window.multizen?.sync) return;
    return window.multizen.sync.onProgress((e) => {
      if (e.profileId !== profileId) return;
      setProgress(e);
      if (e.phase === "error") setError(e.message);
      if (e.phase === "done") setError(null);
      if (e.phase === "done" || e.phase === "error") void refresh();
    });
  }, [profileId, refresh]);

  if (!available) {
    return (
      <div className="text-[12px] text-slate-500 leading-relaxed">
        Cloud Sync is unavailable on this device.
      </div>
    );
  }
  if (!status) return <div className="text-[12px] text-slate-500">Loading…</div>;

  const globalOff = !status.globalEnabled;
  const sync = window.multizen.sync;

  async function run(
    label: string,
    fn: () => Promise<{ ok: boolean; error?: { message: string } }>,
  ): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok && res.error) setError(res.error.message);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function copyId(): void {
    navigator.clipboard.writeText(profileId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  // The exact token the operator must type to confirm a destructive delete: the
  // profile NAME, or — when the name is empty/whitespace or would be ambiguous —
  // the profile ID. We accept EITHER the exact name or the exact id so a
  // duplicate/empty name never blocks the operator.
  const nameToken = profileName.trim();
  const expectedTokenLabel = nameToken.length > 0 ? nameToken : profileId;
  const confirmMatches =
    confirmText === nameToken && nameToken.length > 0 ? true : confirmText === profileId;

  async function confirmDeleteRemote(): Promise<void> {
    if (!confirmMatches) return; // no exact match → never call the destructive IPC
    setBusy("delete");
    setError(null);
    try {
      const res = await sync.disableAndDeleteRemote(profileId);
      if (!res.ok) setError(res.error.message);
      setConfirmingDelete(false);
      setConfirmText("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function onToggleSync(next: boolean): void {
    if (next) {
      // Re-enable → explicit revive + fresh upload (never silently reuses a
      // deleted remote line).
      void run("reenable", () => sync.reEnable(profileId));
    } else {
      // Uncheck is destructive: require a strong typed confirmation BEFORE any
      // IPC call. Open the inline confirmation instead of toggling immediately.
      setConfirmingDelete(true);
      setConfirmText("");
    }
  }

  return (
    <div className="space-y-3">
      {globalOff && (
        <div
          className="p-2.5 rounded-lg text-[11px] text-amber-200/90 leading-relaxed"
          style={{
            background: "rgba(245,158,11,0.06)",
            boxShadow: "inset 0 0 0 1px rgba(245,158,11,0.20)",
          }}
        >
          <div className="flex items-center gap-1.5 font-medium mb-1">
            <TriangleAlert size={12} /> Cloud Sync is turned off
          </div>
          Turn on Cloud Sync in Settings to sync your whole profile library. This
          profile still runs locally as normal.
        </div>
      )}

      {/* Normal path: automatic library sync explainer. */}
      <div className="text-[12px] text-slate-300 leading-relaxed">
        This profile is part of your <b>automatic library sync</b>. Its browser
        data and sanitized settings back up automatically after the browser
        closes, and restore automatically on your other devices. Secrets (S3
        keys, encryption password, proxy passwords) are never synced.
      </div>

      <label
        className={`flex items-center gap-2 text-[12px] text-slate-300 ${
          globalOff ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        }`}
      >
        <input
          type="checkbox"
          checked={status.syncEnabled}
          disabled={busy !== null || confirmingDelete || globalOff}
          onChange={(e) => onToggleSync(e.target.checked)}
          className="w-3.5 h-3.5 rounded accent-purple-500"
        />
        Sync this profile to the cloud
      </label>

      {/* Strong-typed destructive delete confirmation. */}
      {confirmingDelete && (
        <div
          className="p-3 rounded-lg text-[11px] text-red-200/90 leading-relaxed space-y-2"
          style={{
            background: "rgba(239,68,68,0.06)",
            boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.30)",
          }}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <TriangleAlert size={12} /> Delete this profile's cloud backup?
          </div>
          <div>
            This <b>removes the remote backup and synced profile data</b> for this
            profile from cloud storage. Your <b>local profile and its data stay on
            this device</b>. Shared, deduplicated storage chunks may be reclaimed
            later by maintenance — this is an immediate logical deletion, not an
            immediate byte-level erase.
          </div>
          <div>
            Type <b className="mono">{expectedTokenLabel}</b> to confirm:
          </div>
          <input
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={expectedTokenLabel}
            className="w-full px-2.5 h-8 rounded-md bg-white/[0.03] text-[12px] text-slate-100 placeholder:text-slate-600 outline-none mono"
            style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.10)" }}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="warning"
              onClick={() => void confirmDeleteRemote()}
              disabled={!confirmMatches || busy !== null}
              title={confirmMatches ? "Delete the cloud backup" : "Type the exact name or id to enable"}
            >
              Delete cloud backup
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirmingDelete(false);
                setConfirmText("");
              }}
              disabled={busy !== null}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {status.syncEnabled && !confirmingDelete && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <Pill kind={status.dirty ? "pending" : "running"}>
              {status.dirty ? "changes pending upload" : "backed up"}
            </Pill>
            {status.running && <Pill kind="running" dot>running</Pill>}
            {status.lastSyncedAt && (
              <span className="text-slate-600">
                Last synced {new Date(status.lastSyncedAt).toLocaleString()}
              </span>
            )}
          </div>

          {/* Advanced / retry disclosure. */}
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300"
          >
            {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Advanced (manual retry tools)
          </button>

          {showAdvanced && (
            <div className="space-y-2 pl-3" style={{ borderLeft: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="text-[11px] text-slate-500 leading-relaxed">
                You normally never need these — sync is automatic. Use them only to
                retry after a failure.
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void run("acquire", () => sync.acquire(profileId))}
                  disabled={busy !== null || status.running || status.hasLease || globalOff}
                >
                  Acquire lease
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void run("backup", () => sync.backup(profileId))}
                  disabled={busy !== null || status.running || !status.hasLease || globalOff}
                  title="Force a backup now (normally automatic after close)."
                >
                  Back up now
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void run("restore", () => sync.restore(profileId, false))}
                  disabled={busy !== null || status.running || !status.hasLease || globalOff}
                >
                  Restore latest
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void run("release", () => sync.release(profileId))}
                  disabled={busy !== null || status.running || !status.hasLease || globalOff}
                >
                  Release lease
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={copyId}
                  leftIcon={copied ? <Check size={12} /> : <Copy size={12} />}
                >
                  {copied ? "Copied" : "Copy Sync ID"}
                </Button>
              </div>
              <div className="text-[11px] text-slate-600">
                local r{status.localRevision} · base r{status.baseRevision} · remote r
                {status.remoteRevision}
                {status.hasLease ? " · lease held" : ""}
              </div>

              {status.dirty && (
                <div
                  className="p-2.5 rounded-lg text-[11px] text-amber-200/90 leading-relaxed"
                  style={{
                    background: "rgba(245,158,11,0.06)",
                    boxShadow: "inset 0 0 0 1px rgba(245,158,11,0.20)",
                  }}
                >
                  <div className="flex items-center gap-1.5 font-medium mb-1">
                    <TriangleAlert size={12} /> Conflict-safe restore
                  </div>
                  Restoring the remote version keeps your local state as a separate{" "}
                  <b>unsynced conflict copy</b> so nothing is lost.
                  <div className="mt-1.5">
                    <Button
                      size="sm"
                      variant="warning"
                      onClick={() => void run("restore-keep", () => sync.restore(profileId, true))}
                      disabled={busy !== null || status.running || !status.hasLease || globalOff}
                    >
                      Restore &amp; keep local as conflict copy
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {(busy || progress) && (
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          {busy && <Loader2 size={11} className="animate-spin" />}
          <span>{progress?.message ?? `${busy}…`}</span>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
          <TriangleAlert size={11} className="shrink-0 mt-[1px]" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
