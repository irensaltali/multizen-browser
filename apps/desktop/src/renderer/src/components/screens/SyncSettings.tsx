import { useCallback, useEffect, useState, type JSX } from "react";
import { Cloud, Check, Loader2, TriangleAlert, FileDown, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../atoms/Button";
import { CredentialBackupSection } from "../settings/CredentialBackupSection";
import { SetupFromBackupSection } from "../settings/SetupFromBackupSection";
import type { SyncConfigView, SyncDiagnostics, SecretKind, BootstrapSummary } from "../../types";

/**
 * Global Cloud Sync configuration. Shows only NON-SECRET fields for the storage
 * + coordination plane, plus write-only secret inputs (values are never read
 * back — the UI only shows whether a secret is present). A "Test storage
 * coordination" button probes store health AND runs a forced conditional-write
 * capability probe. A "Connect existing profile" action pulls a profile that
 * lives only in the remote repo.
 *
 * Everything degrades gracefully when the preload bridge or controller is
 * absent (sync disabled): the section explains that sync is unavailable.
 */

const SECRET_FIELDS: Array<{ kind: SecretKind; label: string; hint: string }> = [
  {
    kind: "kopiaPassword",
    label: "Encryption password (required for backups)",
    hint: "Not required for the S3 connection test. Use the same password on every device.",
  },
  { kind: "s3AccessKeyId", label: "S3 access key ID", hint: "Storage credential." },
  { kind: "s3SecretAccessKey", label: "S3 secret access key", hint: "Storage credential." },
];

export function SyncSettings(): JSX.Element {
  const [config, setConfig] = useState<SyncConfigView | null>(null);
  const [diag, setDiag] = useState<SyncDiagnostics | null>(null);
  const [available, setAvailable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [connectId, setConnectId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [library, setLibrary] = useState<BootstrapSummary | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.multizen?.sync) {
      setAvailable(false);
      return;
    }
    try {
      const cfg = await window.multizen.sync.getConfig();
      setConfig(cfg);
      const d = await window.multizen.sync.diagnostics();
      if (d.ok) setDiag(d.value);
      const b = await window.multizen.sync.bootstrapStatus();
      if (b.ok) setLibrary(b.value);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll the library status while a bootstrap is running so the UI reflects
  // per-profile progress without a manual reload.
  useEffect(() => {
    if (!library?.running) return;
    const t = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(t);
  }, [library?.running, refresh]);

  if (!available) {
    return (
      <div className="text-[12px] text-slate-500 leading-relaxed max-w-[480px]">
        Cloud Sync is unavailable on this device — OS secure storage could not be initialized, so
        secrets cannot be stored safely. Everything else works normally.
      </div>
    );
  }

  if (!config) {
    return <div className="text-[12px] text-slate-500">Loading…</div>;
  }

  async function patch(p: Partial<SyncConfigView>): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await window.multizen.sync.updateConfig(p);
      if (res.ok) setConfig(res.value);
      else setError(res.error.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveSecret(kind: SecretKind): Promise<void> {
    const value = secretDrafts[kind] ?? "";
    setError(null);
    const res = await window.multizen.sync.saveSecret(kind, value);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    // Never keep the plaintext around after a successful save.
    setSecretDrafts((d) => ({ ...d, [kind]: "" }));
    setMessage(value.length === 0 ? "Secret cleared" : "Secret saved");
    window.setTimeout(() => setMessage(null), 2000);
    await refresh();
  }

  async function testStorageCoordination(): Promise<void> {
    setTesting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await window.multizen.sync.testCoordination();
      if (res.ok) {
        const r = res.value;
        if (r.conditionalWritesSupported) {
          const encryptionNote = secretsPresent?.kopiaPassword
            ? "Backup encryption was not tested."
            : "Set an encryption password before the first backup.";
          setMessage(
            `S3 connection passed ✓ · conditional writes supported ✓ · ${encryptionNote}`,
          );
        } else if (!r.healthy) {
          const check = r.capability.failedCheck ? ` [${r.capability.failedCheck}]` : "";
          const detail = r.capability.message
            ? ` — ${r.capability.message}`
            : " — bucket health check failed; verify endpoint, region, bucket, and credentials";
          setError(`S3 connection failed${check}${detail}`);
        } else {
          const check = r.capability.failedCheck ? ` [${r.capability.failedCheck}]` : "";
          const detail = r.capability.message ? ` — ${r.capability.message}` : "";
          setError(
            `S3 connection passed, but conditional writes are not supported${check}${detail}`,
          );
        }
      } else {
        setError(res.error.message);
      }
      await refresh();
    } finally {
      setTesting(false);
    }
  }

  async function exportDiagnostics(): Promise<void> {
    setExporting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await window.multizen.sync.exportDiagnosticsToFile();
      if (res.ok) {
        setMessage(`Diagnostics saved to ${res.path}`);
        window.setTimeout(() => setMessage(null), 4000);
      } else if (!res.canceled) {
        setError(res.error ?? "Export failed");
      }
    } finally {
      setExporting(false);
    }
  }

  async function connectExisting(): Promise<void> {
    const id = connectId.trim();
    if (!id) return;
    setConnecting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await window.multizen.sync.connectExisting(id);
      if (res.ok) {
        setMessage(`Connected profile ${res.value.profileId}`);
        setConnectId("");
      } else {
        setError(res.error.message);
      }
    } finally {
      setConnecting(false);
    }
  }

  const secretsPresent = diag?.secretsPresent;

  async function syncAllNow(): Promise<void> {
    setSyncingAll(true);
    setError(null);
    setMessage(null);
    try {
      const res = await window.multizen.sync.syncAll();
      if (res.ok) {
        setLibrary(res.value);
        if (res.value.phase === "error" && res.value.error) setError(res.value.error);
      } else {
        setError(res.error.message);
      }
      await refresh();
    } finally {
      setSyncingAll(false);
    }
  }

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2.5 text-[12px] text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => void patch({ enabled: e.target.checked })}
          className="w-3.5 h-3.5 rounded accent-purple-500"
        />
        Enable Cloud Sync
      </label>

      {!config.enabled && (
        <div className="text-[11px] text-amber-400/80 leading-relaxed max-w-[520px]">
          Cloud Sync is off. Storage tests, per-profile enable, and all
          Acquire/Restore/Backup/Release actions are disabled until you turn it
          on. Your profiles still run locally as normal.
        </div>
      )}

      <div className="grid gap-2.5 sm:grid-cols-2">
        <TextField
          label="S3 endpoint"
          value={config.s3Endpoint}
          onCommit={(v) => void patch({ s3Endpoint: v })}
          placeholder="s3.example.com"
        />
        <TextField
          label="Region"
          value={config.s3Region}
          onCommit={(v) => void patch({ s3Region: v })}
          placeholder="auto"
        />
        <TextField
          label="Bucket"
          value={config.s3Bucket}
          onCommit={(v) => void patch({ s3Bucket: v })}
        />
        <TextField
          label="Backup data prefix"
          value={config.s3Prefix}
          onCommit={(v) => void patch({ s3Prefix: v })}
          placeholder="profiles/"
        />
        <TextField
          label="Control prefix"
          value={config.controlPrefix}
          onCommit={(v) => void patch({ controlPrefix: v })}
          placeholder="multizen-control"
        />
        <TextField
          label="Lease TTL (ms)"
          value={String(config.leaseTtlMs)}
          onCommit={(v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0) void patch({ leaseTtlMs: n });
          }}
          placeholder="60000"
        />
        <TextField
          label="Renewal interval (ms)"
          value={String(config.renewalMs)}
          onCommit={(v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0) void patch({ renewalMs: n });
          }}
          placeholder="15000"
        />
        <TextField
          label="Clock-skew safety (ms)"
          value={String(config.clockSkewSafetyMs)}
          onCommit={(v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0) void patch({ clockSkewSafetyMs: n });
          }}
          placeholder="10000"
        />
        <TextField
          label="Device name"
          value={config.deviceDisplayName}
          onCommit={(v) => void patch({ deviceDisplayName: v })}
        />
      </div>

      <label className="flex items-center gap-2.5 text-[12px] text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          checked={config.s3ForcePathStyle}
          onChange={(e) => void patch({ s3ForcePathStyle: e.target.checked })}
          className="w-3.5 h-3.5 rounded accent-purple-500"
        />
        Force path-style S3 addressing (required by some S3-compatible providers)
      </label>

      <div className="text-[11px] text-slate-600">
        Device id: <span className="mono text-slate-500">{config.deviceId}</span>
      </div>

      <div className="space-y-2">
        <div className="text-[11px] font-medium text-slate-500">Secrets (write-only)</div>
        {SECRET_FIELDS.map((f) => {
          const present = secretsPresent?.[f.kind];
          return (
            <div key={f.kind} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
                  {f.label}
                  {present ? (
                    <span className="text-emerald-400/80 inline-flex items-center gap-0.5">
                      <Check size={11} /> set
                    </span>
                  ) : (
                    <span className="text-slate-600">not set</span>
                  )}
                </div>
                <input
                  type="password"
                  value={secretDrafts[f.kind] ?? ""}
                  onChange={(e) =>
                    setSecretDrafts((d) => ({ ...d, [f.kind]: e.target.value }))
                  }
                  placeholder={present ? "•••••••• (enter to replace)" : f.hint}
                  className="w-full px-2.5 h-8 rounded-md bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none mt-1"
                  style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                />
              </div>
              <Button size="sm" variant="secondary" onClick={() => void saveSecret(f.kind)}>
                Save
              </Button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2.5 flex-wrap">
        <Button
          size="sm"
          variant="accent"
          onClick={() => void testStorageCoordination()}
          disabled={testing || !config.enabled}
          leftIcon={testing ? <Loader2 size={12} className="animate-spin" /> : <Cloud size={12} />}
        >
          Test S3 connection
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          leftIcon={
            exporting ? <Loader2 size={12} className="animate-spin" /> : <FileDown size={12} />
          }
        >
          Export diagnostics
        </Button>
        {saving && <span className="text-[11px] text-slate-500">Saving…</span>}
        {message && (
          <span className="text-[11px] text-emerald-400/90 inline-flex items-center gap-1">
            <Check size={11} /> {message}
          </span>
        )}
        {error && (
          <span className="text-[11px] text-amber-400/90 inline-flex items-center gap-1">
            <TriangleAlert size={11} /> {error}
          </span>
        )}
      </div>

      <div className="pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="flex items-center justify-between mt-3 mb-1.5">
          <div className="text-[11px] font-medium text-slate-500">Whole-library sync</div>
          <Button
            size="sm"
            variant="accent"
            onClick={() => void syncAllNow()}
            disabled={syncingAll || !config.enabled || library?.running}
            leftIcon={
              syncingAll || library?.running ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )
            }
          >
            {library?.running ? "Syncing…" : "Sync all"}
          </Button>
        </div>
        <div className="text-[11px] text-slate-500 leading-relaxed max-w-[520px]">
          Your whole profile library syncs <strong>automatically</strong>: once
          Cloud Sync is ready, missing profiles are restored and local changes
          upload after each browser closes. Use <strong>Sync all</strong> to
          re-run the library sync manually (e.g. to retry after a failure).
        </div>
        {library && library.phase !== "idle" && (
          <div className="mt-2 text-[11px] leading-relaxed">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-400">
              <span>
                Status:{" "}
                <span
                  className={
                    library.phase === "error"
                      ? "text-amber-400/90"
                      : library.phase === "done"
                        ? "text-emerald-400/90"
                        : "text-slate-300"
                  }
                >
                  {library.phase}
                </span>
              </span>
              <span>discovered {library.remoteDiscovered}</span>
              <span>restored {library.restored}</span>
              <span>uploaded {library.uploaded}</span>
              {library.deferred > 0 && <span>deferred {library.deferred}</span>}
              {library.reconciled > 0 && <span>reconciled {library.reconciled}</span>}
              {library.failed > 0 && (
                <span className="text-amber-400/90">failed {library.failed}</span>
              )}
            </div>
            {library.remoteTruncated && (
              <div className="text-amber-400/80 mt-1">
                Remote listing hit the scan cap — some profiles may not be listed.
              </div>
            )}
            {library.error && (
              <div className="text-amber-400/90 mt-1 inline-flex items-start gap-1">
                <TriangleAlert size={11} className="shrink-0 mt-[1px]" /> {library.error}
              </div>
            )}
            {library.finishedAt && (
              <div className="text-slate-600 mt-1">
                Last run finished {new Date(library.finishedAt).toLocaleString()}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 mt-3"
        >
          {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Advanced — connect a single profile by ID
        </button>
        {showAdvanced && (
          <div className="mt-2">
            <div className="text-[11px] text-slate-600 mb-1.5 leading-relaxed max-w-[520px]">
              Normally unnecessary — the whole library syncs automatically. This
              fallback pulls one specific profile id into a new local profile.
            </div>
            <div className="flex items-center gap-2">
              <input
                value={connectId}
                onChange={(e) => setConnectId(e.target.value)}
                placeholder="Sync ID from another device"
                className="flex-1 px-2.5 h-8 rounded-md bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none mono"
                style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void connectExisting()}
                disabled={connecting || !connectId.trim() || !config.enabled}
              >
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            </div>
          </div>
        )}
      </div>

      <CredentialBackupSection />

      <SetupFromBackupSection />

      <div className="pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="text-[11px] text-slate-500 leading-relaxed mt-3 max-w-[520px]">
          Encrypted storage is created <strong>automatically</strong> the first time you run{" "}
          <strong>Backup &amp; Publish</strong> on a profile. You can test the S3 connection before
          setting an encryption password, but you must save one before the first backup. Use the
          same password on every device that backs up or restores from this storage.
        </div>
      </div>
    </div>
  );
}

/** Text input that commits on blur / Enter (so patch fires once, not per keystroke). */
function TextField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder={placeholder}
        className="w-full px-2.5 h-8 rounded-md bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05]"
        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
      />
    </div>
  );
}
