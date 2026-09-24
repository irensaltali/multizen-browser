import { useCallback, useState, type JSX } from "react";
import { KeyRound } from "lucide-react";

import type { GatewayOpResult, SecretRefStatusView } from "../../types";
import { Button } from "../atoms/Button";
import { Modal, Pill } from "../atoms";
import { Section } from "./ProjectDetail";

/**
 * Availability of every `${NAME}` the project's servers reference, and the two
 * ways to satisfy one.
 *
 * A reference can be backed either by an environment variable this device is
 * approved to read, or by a value MultiZen stores in the OS keychain. This
 * screen only ever shows the NAME and whether a value is present — there is no
 * control, and no API, that reads a stored value back. Saving is one-way.
 */

export interface ReferencesSectionProps {
  readonly projectId: string;
  readonly refs: readonly SecretRefStatusView[];
  readonly onChanged: () => void;
  readonly onError: (message: string | null) => void;
}

export function ReferencesSection({
  projectId,
  refs,
  onChanged,
  onError,
}: ReferencesSectionProps): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [provideFor, setProvideFor] = useState<string | null>(null);
  const [value, setValue] = useState("");

  const run = useCallback(
    async <T,>(op: () => Promise<GatewayOpResult<T>>): Promise<boolean> => {
      setBusy(true);
      onError(null);
      try {
        const res = await op();
        if (!res.ok) {
          onError(res.error.message);
          return false;
        }
        onChanged();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onError],
  );

  const closeProvide = useCallback(() => {
    // Never keep a secret in component state after the dialog closes.
    setValue("");
    setProvideFor(null);
  }, []);

  const saveValue = useCallback(async () => {
    if (provideFor === null || value.length === 0) return;
    const name = provideFor;
    const secret = value;
    // Clear local state before awaiting, so the value does not linger in memory
    // any longer than the call itself needs it.
    setValue("");
    const ok = await run(() =>
      window.multizen.gateway.saveManagedSecret(projectId, name, secret),
    );
    if (ok) setProvideFor(null);
  }, [projectId, provideFor, run, value]);

  // Nothing referenced: the section would be an empty box, so omit it entirely.
  if (refs.length === 0) return null;

  return (
    <>
      <Section title={`References (${refs.length})`}>
        <div className="text-[11.5px] text-slate-500 leading-relaxed mb-3">
          Your servers reference these environment variables. Each one can read from this
          computer’s environment, or hold a value MultiZen keeps in your keychain. Values are
          never shown again after you save them, and never written into a project or an
          agent’s configuration file.
        </div>
        <div className="space-y-2" data-testid="reference-list">
          {refs.map((ref) => (
            <div
              key={ref.name}
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(255,255,255,0.02)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
              }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="mono text-[12px] text-slate-200">{ref.name}</span>
                {ref.present ? (
                  <Pill kind="running">
                    {ref.source === "managed" ? "stored by MultiZen" : "from environment"}
                  </Pill>
                ) : (
                  <Pill kind="error">no value</Pill>
                )}
                <div className="flex-1" />
                {ref.managed ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        window.multizen.gateway.deleteManagedSecret(projectId, ref.name),
                      )
                    }
                  >
                    Remove stored value
                  </Button>
                ) : (
                  <>
                    {ref.approved ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(() => window.multizen.gateway.revokeEnvName(ref.name))
                        }
                      >
                        Stop using environment
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(() => window.multizen.gateway.approveEnvName(ref.name))
                        }
                      >
                        Use environment
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<KeyRound size={12} />}
                      disabled={busy}
                      onClick={() => setProvideFor(ref.name)}
                    >
                      Provide value
                    </Button>
                  </>
                )}
              </div>
              {!ref.present && (
                <div className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                  {ref.approved
                    ? `Approved to read ${ref.name} from this computer’s environment, but it is not set. Export it before launching MultiZen, or provide a value instead.`
                    : "Approve reading it from this computer’s environment, or let MultiZen store the value in your keychain."}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Modal
        open={provideFor !== null}
        onClose={closeProvide}
        title={provideFor !== null ? `Value for ${provideFor}` : "Provide a value"}
        subtitle="Stored in your operating system’s keychain. MultiZen never displays it again and never writes it into a file."
        width={460}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeProvide} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void saveValue()}
              disabled={busy || value.length === 0}
            >
              Save value
            </Button>
          </>
        }
      >
        <div className="px-5 py-4">
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
              Value
            </span>
            <input
              data-autofocus
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label={
                provideFor !== null ? `Value for ${provideFor}` : "Value"
              }
              className="w-full mono text-[12.5px] text-slate-200 outline-none"
              style={{
                height: 34,
                padding: "0 11px",
                borderRadius: 9,
                background: "rgba(0,0,0,0.25)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
              }}
            />
          </label>
        </div>
      </Modal>
    </>
  );
}
