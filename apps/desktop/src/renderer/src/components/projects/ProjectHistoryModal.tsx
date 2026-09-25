import { useCallback, useEffect, useState, type JSX } from "react";
import { History, Loader2, RotateCcw, Trash2, TriangleAlert } from "lucide-react";

import { Modal } from "../atoms/Modal";
import { Button } from "../atoms/Button";
import type { ProjectHistoryEntryView } from "../../types";

/**
 * A project's configuration timeline, and a way back to any point on it.
 *
 * Two things this deliberately does not pretend:
 *
 *   - A revision with no verifiable timestamp is shown as "date unknown" rather
 *     than given a plausible-looking one. The date comes from a signed stamp; when
 *     that cannot be trusted, the revision number is still true and the date is
 *     not, so only one of them is displayed.
 *   - Restoring is described as "make this the current configuration", because
 *     that is what happens — the old content is republished as a NEW revision. It
 *     is not a rewind, and the intervening revisions stay in the list so the
 *     restore itself can be undone.
 */
export function ProjectHistoryModal({
  projectId,
  onClose,
  onRestored,
}: {
  projectId: string;
  onClose: () => void;
  onRestored?: () => void;
}): JSX.Element {
  const [entries, setEntries] = useState<ProjectHistoryEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const gw = window.multizen?.gateway;
    if (!gw?.projectHistory) {
      setEntries([]);
      return;
    }
    const res = await gw.projectHistory(projectId);
    if (res.ok) {
      setEntries(res.value);
      setError(null);
    } else {
      setEntries([]);
      setError(res.error.message);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function restore(revision: number): Promise<void> {
    const gw = window.multizen?.gateway;
    if (!gw?.restoreProjectRevision) return;
    setBusy(revision);
    setError(null);
    setMessage(null);
    try {
      const res = await gw.restoreProjectRevision(projectId, revision);
      if (res.ok) {
        setMessage(
          `Revision ${res.value.fromRevision} is now the current configuration, published as revision ${res.value.revision}.`,
        );
        await refresh();
        onRestored?.();
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open onClose={onClose} hideHeader ariaLabel={`Configuration history for ${projectId}`} width={640}>
      <div className="flex items-center gap-2 mb-1">
        <History size={14} className="text-slate-400" />
        <span className="text-[13px] text-slate-100 font-medium">Configuration history</span>
        <span className="text-[11px] text-slate-500 mono">{projectId}</span>
      </div>
      <div className="text-[11px] text-slate-500 leading-relaxed mb-3 max-w-[520px]">
        Each saved change is kept in your bucket. Restoring one makes it the current
        configuration by publishing it again — nothing is erased, so you can change
        your mind afterwards. Older revisions beyond the retention limit are removed
        automatically.
      </div>

      {entries === null ? (
        <div className="text-[11px] text-slate-500 inline-flex items-center gap-1">
          <Loader2 size={11} className="animate-spin" /> Loading…
        </div>
      ) : entries.length === 0 ? (
        <div className="text-[11px] text-slate-500" data-testid="history-empty">
          No history yet. Configuration history needs Cloud Sync — until then this
          project is stored on this device only.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="history-list">
          {entries.map((e) => (
            <li
              key={`${e.revision}-${e.deleted ? "d" : "c"}`}
              className="flex items-center gap-2 text-[11px] py-1"
              data-testid={`history-${e.revision}`}
            >
              <span className="mono text-slate-400 w-12 shrink-0">#{e.revision}</span>
              <span className="text-slate-500 w-[150px] shrink-0">
                {e.archivedAt !== null
                  ? new Date(e.archivedAt).toLocaleString()
                  : "date unknown"}
              </span>
              {e.deleted ? (
                <span className="inline-flex items-center gap-1 text-amber-400/90">
                  <Trash2 size={11} /> deleted
                </span>
              ) : e.current ? (
                <span className="text-emerald-400/90">current</span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void restore(e.revision)}
                  disabled={busy !== null}
                >
                  {busy === e.revision ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 size={11} className="animate-spin" /> Restoring…
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <RotateCcw size={11} /> Make current
                    </span>
                  )}
                </Button>
              )}
              <span className="text-slate-600 mono truncate">{e.signer}</span>
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <div
          className="text-[11px] text-amber-400/90 mt-3 inline-flex items-start gap-1"
          role="alert"
        >
          <TriangleAlert size={11} className="shrink-0 mt-[1px]" /> {error}
        </div>
      )}
      {message !== null && (
        <div className="text-[11px] text-emerald-400/90 mt-3" role="status">
          {message}
        </div>
      )}
    </Modal>
  );
}
