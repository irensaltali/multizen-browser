import { useCallback, useEffect, useState, type JSX } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { Modal } from "../atoms";
interface DeleteStatus {
  syncEnabled: boolean;
  globalEnabled: boolean;
  cloudAvailable: boolean;
}

interface Props {
  profileId: string;
  profileName: string;
  onCancel: () => void;
  onDeleted: () => void;
}

export function DeleteProfileDialog({
  profileId,
  profileName,
  onCancel,
  onDeleted,
}: Props): JSX.Element {
  const [status, setStatus] = useState<DeleteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await window.multizen.profiles.deleteStatus(profileId));
      setStatusError(null);
    } catch (error) {
      setStatus(null);
      setStatusError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const token = profileName.trim() || profileId;
  const confirmed = confirmText === token || confirmText === profileId;
  const synced = status?.syncEnabled === true;
  const canDelete = !!status && !loading && (!synced || (status.globalEnabled && confirmed)) && !busy;

  async function deleteProfile(): Promise<void> {
    if (!canDelete) return;
    setBusy(true);
    setActionError(null);
    try {
      await window.multizen.profiles.delete(profileId, synced);
      onDeleted();
    } catch (error) {
      setActionError((error as Error).message);
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={`Delete ${profileName || "profile"}?`}
      width={520}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <form
        className="p-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void deleteProfile();
        }}
      >
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" /> Checking Cloud Sync…
          </div>
        ) : statusError ? (
          <div role="alert" className="text-sm text-red-300 space-y-2">
            <p>Could not check this profile’s sync status: {statusError}</p>
            <button
              type="button"
              className="btn-ghost px-3 py-2"
              onClick={() => void refreshStatus()}
            >
              Retry
            </button>
          </div>
        ) : synced ? (
          <>
            <p className="text-sm text-slate-300 leading-relaxed">
              This profile is synced. Deleting it removes its cloud backup and local browser data.
              The browser will close first. This cannot be undone.
            </p>
            {!status?.globalEnabled && (
              <p role="alert" className="flex items-start gap-2 text-sm text-amber-300">
                <TriangleAlert size={16} className="shrink-0 mt-0.5" />
                {status?.cloudAvailable
                  ? "Turn on Cloud Sync in Settings before deleting this profile."
                  : "Cloud Sync is unavailable on this device. Restore it before deleting this synced profile."}
              </p>
            )}
            <label className="block text-sm text-slate-300">
              Type <strong className="font-mono break-all">{token}</strong> to confirm
              <input
                data-autofocus
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                className="mt-2 w-full rounded-md bg-white/[0.04] px-3 py-2 text-slate-100 outline-none font-mono"
                style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)" }}
              />
            </label>
          </>
        ) : (
          <p className="text-sm text-slate-300 leading-relaxed">
            The browser will close and its local cookies, login state, and on-disk data will be
            erased permanently. This cannot be undone.
          </p>
        )}

        {actionError && (
          <p role="alert" className="text-sm text-red-300 break-words">
            {actionError}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            className="btn-ghost px-3 py-2 text-sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canDelete}
            className="px-3 py-2 text-sm rounded-md text-red-200 bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.35)" }}
          >
            {busy ? "Deleting…" : synced ? "Delete cloud backup and profile" : "Delete profile"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
