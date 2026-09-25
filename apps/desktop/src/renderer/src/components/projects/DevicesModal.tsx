import { useCallback, useEffect, useState, type JSX } from "react";
import { Check, Laptop, ShieldCheck, ShieldX } from "lucide-react";

import type { TrustDeviceView } from "../../types";
import { Button } from "../atoms/Button";
import { Modal, Pill, confirm, type PillKind } from "../atoms";

/**
 * The devices allowed to publish project configuration to the shared bucket.
 *
 * Why this screen has to exist: a device signs its configs with a key only it
 * holds, and a config is only accepted if its signer is a trusted entry in the
 * signed trust registry. A second machine therefore starts out able to READ
 * everything but unable to share anything, and it cannot promote itself — the
 * registry refuses any update that is not signed by an already-trusted admin.
 * Approving from a machine that is already trusted is the only way through, so
 * without this list a second device stays read-only forever.
 *
 * A device that is not yet an entry announces itself into the bucket (public key
 * and name only) purely so it can be listed here. Announcing grants nothing.
 */

export interface DevicesModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Re-run a sync pass after a trust change, so refused records get re-judged. */
  readonly onTrustChanged: () => void;
}

function rolePill(role: TrustDeviceView["role"]): { kind: PillKind; text: string } {
  switch (role) {
    case "trusted":
      return { kind: "running", text: "trusted" };
    case "revoked":
      return { kind: "error", text: "revoked" };
    case "pending":
      return { kind: "pending", text: "waiting" };
  }
}

export function DevicesModal({
  open,
  onClose,
  onTrustChanged,
}: DevicesModalProps): JSX.Element {
  const [devices, setDevices] = useState<TrustDeviceView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await window.multizen.gateway.trustList();
    if (!res.ok) {
      setError(res.error.message);
      setDevices([]);
      return;
    }
    setDevices(res.value);
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
          setError(res.error?.message ?? "The change was refused.");
          return;
        }
        await load();
        // A newly trusted device's already-published records can now be accepted,
        // and a revoked one's must stop being accepted — both need a fresh pass.
        onTrustChanged();
      } finally {
        setBusy(false);
      }
    },
    [load, onTrustChanged],
  );

  const approve = useCallback(
    (d: TrustDeviceView) =>
      void run(() => window.multizen.gateway.approveDevice(d.deviceId, d.publicKeyHex)),
    [run],
  );

  const revoke = useCallback(
    async (d: TrustDeviceView) => {
      const confirmed = await confirm({
        title: `Revoke ${d.name ?? d.deviceId}?`,
        body: "Configuration this device publishes from now on will be refused on every other device. Anything it already published stays, and it can still read. You can approve it again later.",
        confirmLabel: "Revoke device",
        destructive: true,
      });
      if (!confirmed) return;
      await run(() => window.multizen.gateway.revokeDevice(d.deviceId));
    },
    [run],
  );

  const waiting = (devices ?? []).filter((d) => d.role === "pending");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Devices"
      subtitle="Which of your machines may publish project configuration to the shared bucket."
      width={600}
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

        {devices === null ? (
          <div className="text-[12px] text-slate-500" role="status">
            Loading devices…
          </div>
        ) : devices.length === 0 ? (
          <div className="text-[12px] text-slate-500 leading-relaxed">
            No devices yet. This list fills in once Cloud Sync is running and a
            device has published or announced itself.
          </div>
        ) : (
          <>
            {waiting.length > 0 && (
              <div className="text-[11.5px] text-slate-400 leading-relaxed mb-3">
                {waiting.length === 1 ? "A device is" : `${waiting.length} devices are`}{" "}
                waiting to be approved. Until then {waiting.length === 1 ? "it" : "they"}{" "}
                can read your projects but cannot change them.
              </div>
            )}
            <div className="space-y-2" data-testid="device-list">
              {devices.map((d) => {
                const pill = rolePill(d.role);
                return (
                  <div
                    key={d.deviceId}
                    data-testid={`device-${d.deviceId}`}
                    className="flex items-center gap-2.5"
                    style={{
                      padding: 10,
                      borderRadius: 10,
                      background: "rgba(255,255,255,0.02)",
                      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
                    }}
                  >
                    <Laptop size={14} className="text-slate-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12.5px] text-slate-200 truncate">
                          {d.name ?? d.deviceId}
                        </span>
                        {d.isSelf && <Pill kind="idle">this device</Pill>}
                        <Pill kind={pill.kind}>{pill.text}</Pill>
                      </div>
                      <div className="mono text-[10.5px] text-slate-500 truncate">
                        {d.deviceId}
                        {d.announcedAt !== undefined &&
                          ` · first seen ${new Date(d.announcedAt).toLocaleDateString()}`}
                      </div>
                    </div>

                    {d.role !== "trusted" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<ShieldCheck size={12} />}
                        disabled={busy}
                        onClick={() => approve(d)}
                      >
                        {d.role === "revoked" ? "Re-approve" : "Approve"}
                      </Button>
                    )}
                    {d.role === "trusted" && !d.isSelf && (
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<ShieldX size={12} />}
                        disabled={busy}
                        onClick={() => void revoke(d)}
                      >
                        Revoke
                      </Button>
                    )}
                    {d.role === "trusted" && d.isSelf && (
                      <Check size={13} className="text-emerald-300 flex-shrink-0 mr-1" />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
