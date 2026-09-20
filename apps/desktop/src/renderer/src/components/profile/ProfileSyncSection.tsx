import { useCallback, useEffect, useState, type JSX } from "react";
import { Check, Copy, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "../atoms/Button";
import { Pill } from "../atoms";
import type { ProfileSyncStatusView, SyncProgressEvent } from "../../types";

/**
 * Per-profile Cloud Sync controls inside the edit sheet. Shows the profile's
 * sync status and exposes the manual lifecycle actions: Enable, Acquire lease,
 * Backup & Publish, Restore, Release, plus Copy Sync ID and a conflict-aware
 * restore ("keep local as conflict copy"). Progress + errors are surfaced
 * inline. Never displays secrets.
 */

interface Props {
  profileId: string;
}

export function ProfileSyncSection({ profileId }: Props): JSX.Element {
  const [status, setStatus] = useState<ProfileSyncStatusView | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  const sync = window.multizen.sync;

  function copyId(): void {
    navigator.clipboard.writeText(profileId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-[12px] text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          checked={status.syncEnabled}
          onChange={(e) => void run("enable", () => sync.enable(profileId, e.target.checked))}
          className="w-3.5 h-3.5 rounded accent-purple-500"
        />
        Sync this profile
      </label>

      {status.syncEnabled && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <Pill kind={status.dirty ? "pending" : "running"}>
              {status.dirty ? "unpublished changes" : "clean"}
            </Pill>
            <Pill kind={status.hasLease ? "running" : "idle"} dot={status.hasLease}>
              {status.hasLease ? "lease held" : "no lease"}
            </Pill>
            <span className="text-slate-500">
              local r{status.localRevision} · base r{status.baseRevision} · remote r
              {status.remoteRevision}
            </span>
            {status.running && <Pill kind="running" dot>running</Pill>}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="accent"
              onClick={() => void run("acquire", () => sync.acquire(profileId))}
              disabled={busy !== null || status.running}
            >
              Acquire lease
            </Button>
            <Button
              size="sm"
              variant="success"
              onClick={() => void run("backup", () => sync.backup(profileId))}
              disabled={busy !== null || status.running || !status.hasLease}
            >
              Backup &amp; Publish
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void run("restore", () => sync.restore(profileId, false))}
              disabled={busy !== null || status.running || !status.hasLease}
            >
              Restore latest
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void run("release", () => sync.release(profileId))}
              disabled={busy !== null || status.running || !status.hasLease}
            >
              Release lease
            </Button>
            <Button size="sm" variant="ghost" onClick={copyId} leftIcon={copied ? <Check size={12} /> : <Copy size={12} />}>
              {copied ? "Copied" : "Copy Sync ID"}
            </Button>
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
              This profile has local changes. Restoring the remote version keeps your local state
              as a separate <b>unsynced conflict copy</b> so nothing is lost.
              <div className="mt-1.5">
                <Button
                  size="sm"
                  variant="warning"
                  onClick={() => void run("restore-keep", () => sync.restore(profileId, true))}
                  disabled={busy !== null || status.running || !status.hasLease}
                >
                  Restore &amp; keep local as conflict copy
                </Button>
              </div>
            </div>
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
          {status.lastSyncedAt && (
            <div className="text-[11px] text-slate-600">
              Last synced: {new Date(status.lastSyncedAt).toLocaleString()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
