import { useCallback, useEffect, useState, type JSX } from "react";
import { GitMerge, ShieldAlert } from "lucide-react";

import type { ConflictView, QuarantineView } from "../../types";
import { Button } from "../atoms/Button";
import { Modal, Pill, confirm } from "../atoms";

/**
 * Sync records that need a decision: conflicting edits, and remote records that
 * failed verification.
 *
 * Conflicts are kept rather than merged. When two devices edit the same project,
 * the one that published second loses the compare-and-swap; its edit is stored
 * locally instead of being applied over the winner, and the operator chooses.
 * That choice cannot be inferred — "the other machine is newer" says nothing
 * about which change was wanted — so it is asked, not guessed.
 *
 * Quarantine is different: those records were refused, not merely superseded. A
 * record whose signer is unknown or revoked, or whose bytes do not verify, is
 * never applied. When this device already holds the project, the local copy
 * keeps running and the refusal is informational.
 */

export interface SyncIssuesModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Re-read projects and sync status after a resolution changes state. */
  readonly onResolved: () => void;
}

export function SyncIssuesModal({
  open,
  onClose,
  onResolved,
}: SyncIssuesModalProps): JSX.Element {
  const [conflicts, setConflicts] = useState<ConflictView[] | null>(null);
  const [quarantined, setQuarantined] = useState<QuarantineView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, q] = await Promise.all([
      window.multizen.gateway.conflicts(),
      window.multizen.gateway.quarantine(),
    ]);
    if (c.ok) setConflicts(c.value);
    else setError(c.error.message);
    if (q.ok) setQuarantined(q.value);
    else setError(q.error.message);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void load();
  }, [open, load]);

  const run = useCallback(
    async (op: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await op();
        if (!res.ok) {
          setError(res.error?.message ?? "That did not work.");
          return;
        }
        await load();
        onResolved();
      } finally {
        setBusy(false);
      }
    },
    [load, onResolved],
  );

  const keepMine = useCallback(
    async (c: ConflictView) => {
      const confirmed = await confirm({
        title: `Keep this device’s version of ${c.projectId}?`,
        body: "Your copy is published as the newest revision, so every other device picks it up. The version currently in the cloud is replaced.",
        confirmLabel: "Publish my version",
      });
      if (!confirmed) return;
      await run(() => window.multizen.gateway.resolveConflicts(c.projectId, "mine"));
    },
    [run],
  );

  const keepTheirs = useCallback(
    async (c: ConflictView) => {
      const confirmed = await confirm({
        title: `Discard this device’s version of ${c.projectId}?`,
        body: "The version from the other device is already in use here. Your unsaved copy of this change is discarded and cannot be recovered.",
        confirmLabel: "Discard my version",
        destructive: true,
      });
      if (!confirmed) return;
      await run(() => window.multizen.gateway.resolveConflicts(c.projectId, "theirs"));
    },
    [run],
  );

  const nothing =
    conflicts !== null &&
    quarantined !== null &&
    conflicts.length === 0 &&
    quarantined.length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sync issues"
      subtitle="Edits that clashed, and records that were refused."
      width={620}
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="px-5 py-4">
        {error !== null && (
          <div
            role="alert"
            className="mb-3 px-3 py-2.5 text-[12px] text-red-300 leading-relaxed"
            style={{
              borderRadius: 10,
              background: "rgba(239,68,68,0.06)",
              boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)",
            }}
          >
            {error}
          </div>
        )}

        {conflicts === null || quarantined === null ? (
          <div className="text-[12px] text-slate-500" role="status">
            Loading…
          </div>
        ) : nothing ? (
          <div className="text-[12px] text-slate-500 leading-relaxed">
            Nothing needs attention. Conflicting edits and refused records would
            show up here.
          </div>
        ) : (
          <div className="space-y-4">
            {conflicts.length > 0 && (
              <div>
                <SectionHeading icon={<GitMerge size={12} />} text="Clashing edits" />
                <div className="space-y-2" data-testid="conflict-list">
                  {conflicts.map((c) => (
                    <div
                      key={`${c.projectId}-${c.detectedAt}`}
                      data-testid={`conflict-${c.projectId}`}
                      style={{
                        padding: 10,
                        borderRadius: 10,
                        background: "rgba(255,255,255,0.02)",
                        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="mono text-[12px] text-slate-200">{c.projectId}</span>
                        <Pill kind="pending">needs a choice</Pill>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                        Another device published revision {c.remoteRevision} while this one
                        was on {c.attemptedRevision}.
                      </div>
                      {c.differences !== undefined && c.differences.length > 0 && (
                        <div className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                          Keeping this device’s version would change:{" "}
                          {c.differences.join(", ")}.
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 mt-2.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void keepMine(c)}
                        >
                          Keep mine
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void keepTheirs(c)}
                        >
                          Use theirs
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {quarantined.length > 0 && (
              <div>
                <SectionHeading icon={<ShieldAlert size={12} />} text="Refused records" />
                <div className="space-y-2" data-testid="quarantine-list">
                  {quarantined.map((q) => (
                    <div
                      key={q.projectId}
                      data-testid={`quarantine-${q.projectId}`}
                      style={{
                        padding: 10,
                        borderRadius: 10,
                        background: "rgba(255,255,255,0.02)",
                        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="mono text-[12px] text-slate-200">{q.projectId}</span>
                        <Pill kind="error">{q.code}</Pill>
                        {q.localRetained && <Pill kind="running">still running here</Pill>}
                      </div>
                      <div className="text-[11px] text-red-200/90 mt-1 leading-relaxed break-words">
                        {q.reason}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                        {q.localRetained
                          ? "This device’s own copy is unaffected and still serving. Approve the other device under Devices if its changes should be accepted."
                          : "Nothing from this record is running. Approve the signing device under Devices, or dismiss to re-check it on the next sync."}
                      </div>
                      <div className="mt-2.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              window.multizen.gateway.releaseQuarantine(q.projectId),
                            )
                          }
                        >
                          Dismiss and re-check
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function SectionHeading({
  icon,
  text,
}: {
  icon: JSX.Element;
  text: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 mb-2 text-[11px] uppercase tracking-wider font-semibold text-slate-500">
      {icon}
      {text}
    </div>
  );
}
