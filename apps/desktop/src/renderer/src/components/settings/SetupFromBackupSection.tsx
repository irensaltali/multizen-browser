import { useEffect, useRef, useState, type JSX } from "react";
import {
  Check,
  CircleDashed,
  DownloadCloud,
  Loader2,
  Minus,
  TriangleAlert,
} from "lucide-react";

import { Button } from "../atoms/Button";
import type { SetupFromBackupInput, SetupResultView, SetupStageView } from "../../types";

/**
 * "Set up this device from a backup" — the whole restore in one form.
 *
 * Every field here could be entered individually elsewhere in settings, and the
 * restore could be driven by hand in the right order. The point of this section
 * is that the operator does not have to know the order, or which failure means
 * "stop" and which means "carry on without that part".
 *
 * The report is deliberately per-stage rather than a single success banner:
 * partial recovery is the normal outcome (a folder that no longer exists, a
 * credential passphrase not to hand) and hiding that behind one green tick would
 * leave people believing they had more back than they do.
 */

/** Stage order and labels. Mirrors the main-process stage ids. */
const STAGE_LABELS: Record<string, string> = {
  storage: "Connect to storage",
  trust: "Establish device trust",
  settings: "Restore preferences",
  projects: "Restore MCP projects",
  bindings: "Relink project folders",
  credentials: "Restore server credentials",
  profiles: "Restore browser profiles",
};

const STAGE_ORDER = [
  "storage",
  "trust",
  "settings",
  "projects",
  "bindings",
  "credentials",
  "profiles",
];

function StageIcon({ status }: { status: SetupStageView["status"] }): JSX.Element {
  if (status === "running") return <Loader2 size={12} className="animate-spin text-sky-400" />;
  if (status === "done") return <Check size={12} className="text-emerald-400" />;
  if (status === "skipped") return <Minus size={12} className="text-slate-500" />;
  if (status === "failed") return <TriangleAlert size={12} className="text-amber-400" />;
  return <CircleDashed size={12} className="text-slate-600" />;
}

export function SetupFromBackupSection(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [bucket, setBucket] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("auto");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [encryptionPassword, setEncryptionPassword] = useState("");
  const [credentialPassphrase, setCredentialPassphrase] = useState("");
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<SetupStageView[]>([]);
  const [result, setResult] = useState<SetupResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = typeof window.multizen?.gateway?.setupFromBackup === "function";
  const unsubscribe = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      unsubscribe.current?.();
    },
    [],
  );

  if (!available) return null;

  const canRun =
    !running &&
    bucket.trim().length > 0 &&
    accessKeyId.trim().length > 0 &&
    secretAccessKey.length > 0 &&
    encryptionPassword.length > 0;

  /** Merge a live stage event into the list, preserving the documented order. */
  function applyStage(stage: SetupStageView): void {
    setStages((prev) => {
      const next = prev.filter((s) => s.id !== stage.id).concat(stage);
      next.sort((a, b) => STAGE_ORDER.indexOf(a.id) - STAGE_ORDER.indexOf(b.id));
      return next;
    });
  }

  async function run(): Promise<void> {
    const gw = window.multizen?.gateway;
    if (!gw?.setupFromBackup) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setStages([]);
    unsubscribe.current?.();
    unsubscribe.current = gw.onSetupProgress?.(applyStage) ?? null;

    const input: SetupFromBackupInput = {
      storage: {
        s3Bucket: bucket.trim(),
        ...(endpoint.trim() !== "" ? { s3Endpoint: endpoint.trim() } : {}),
        ...(region.trim() !== "" ? { s3Region: region.trim() } : {}),
      },
      secrets: {
        kopiaPassword: encryptionPassword,
        s3AccessKeyId: accessKeyId.trim(),
        s3SecretAccessKey: secretAccessKey,
      },
      // Omitted rather than sent empty, so the backend skips the stage instead of
      // failing on a passphrase the operator never supplied.
      ...(credentialPassphrase.length > 0 ? { credentialPassphrase } : {}),
    };

    try {
      const res = await gw.setupFromBackup(input);
      if (res.ok) {
        setResult(res.value);
        setStages([...res.value.stages]);
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Secrets do not outlive the call. The non-secret coordinates stay so a
      // retry after approval does not mean retyping the bucket.
      setSecretAccessKey("");
      setEncryptionPassword("");
      setCredentialPassphrase("");
      unsubscribe.current?.();
      unsubscribe.current = null;
      setRunning(false);
    }
  }

  return (
    <div className="pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-[12px] text-slate-200 font-medium mt-3"
      >
        <DownloadCloud size={13} className="text-slate-400" />
        Set up this device from a backup
      </button>
      <div className="text-[11px] text-slate-500 leading-relaxed mt-1.5 max-w-[560px]">
        For a new or rebuilt machine. Restores preferences, MCP projects, project
        folders, server credentials and browser profiles from an existing bucket, in
        the order they depend on each other. Safe to run more than once — it only
        fills in what is missing.
      </div>

      {open && (
        <div className="mt-3 space-y-2 max-w-[440px]">
          <Field label="Bucket" value={bucket} onChange={setBucket} disabled={running} />
          <Field
            label="Endpoint (optional)"
            value={endpoint}
            onChange={setEndpoint}
            placeholder="https://…"
            disabled={running}
          />
          <Field label="Region" value={region} onChange={setRegion} disabled={running} />
          <Field
            label="S3 access key ID"
            value={accessKeyId}
            onChange={setAccessKeyId}
            disabled={running}
          />
          <Field
            label="S3 secret access key"
            value={secretAccessKey}
            onChange={setSecretAccessKey}
            secret
            disabled={running}
          />
          <Field
            label="Encryption password"
            value={encryptionPassword}
            onChange={setEncryptionPassword}
            secret
            disabled={running}
          />
          <Field
            label="Credential passphrase (optional)"
            value={credentialPassphrase}
            onChange={setCredentialPassphrase}
            secret
            disabled={running}
            hint="Only if you enabled credential backup. Leave blank to skip restoring server secrets."
          />

          <Button size="sm" onClick={() => void run()} disabled={!canRun}>
            {running ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" /> Setting up…
              </span>
            ) : (
              "Start setup"
            )}
          </Button>
        </div>
      )}

      {stages.length > 0 && (
        <ul className="mt-3 space-y-1" data-testid="setup-stages">
          {stages.map((s) => (
            <li key={s.id} className="flex items-start gap-2 text-[11px]" data-testid={`stage-${s.id}`}>
              <span className="mt-[2px] shrink-0">
                <StageIcon status={s.status} />
              </span>
              <span className="min-w-[160px] text-slate-300">{STAGE_LABELS[s.id] ?? s.id}</span>
              <span
                className={
                  s.status === "failed"
                    ? "text-amber-400/90"
                    : s.status === "skipped"
                      ? "text-slate-500"
                      : "text-slate-500"
                }
              >
                {s.detail ?? (s.status === "pending" ? "Not reached" : "")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {result !== null && (
        <div className="mt-2 text-[11px]" role="status" data-testid="setup-summary">
          {result.ok ? (
            <span className="text-emerald-400/90">
              Setup finished. Everything available in the bucket was restored.
            </span>
          ) : (
            <span className="text-amber-400/90">
              Setup finished with gaps — see the stages above. You can run it again once
              the cause is fixed.
            </span>
          )}
          {result.awaitingApproval && (
            <div className="text-amber-400/90 mt-1" data-testid="setup-awaiting-approval">
              This device is waiting for approval. It can read everything above, but
              changes made here will not reach your other devices until an existing
              device approves it under Devices.
            </div>
          )}
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
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
  disabled?: boolean;
  hint?: string;
}): JSX.Element {
  return (
    <label className="block">
      <span className="text-[11px] text-slate-500">{label}</span>
      <input
        type={secret === true ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        autoComplete={secret === true ? "new-password" : "off"}
        disabled={disabled}
        className="mt-1 w-full px-2.5 h-8 rounded-md bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none"
        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
      />
      {hint !== undefined && <span className="text-[10px] text-slate-600">{hint}</span>}
    </label>
  );
}
