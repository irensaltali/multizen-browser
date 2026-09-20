import { useCallback, useEffect, useState, type JSX } from "react";
import { Cloud, Check, Loader2, TriangleAlert, FileDown, Database } from "lucide-react";
import { Button } from "../atoms/Button";
import type { SyncConfigView, SyncDiagnostics, SecretKind } from "../../types";

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
  { kind: "kopiaPassword", label: "Kopia repository password", hint: "Encrypts the backup repo." },
  { kind: "s3AccessKeyId", label: "S3/R2 access key id", hint: "Storage credential." },
  { kind: "s3SecretAccessKey", label: "S3/R2 secret access key", hint: "Storage credential." },
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
  const [initConfirm, setInitConfirm] = useState(false);
  const [initializing, setInitializing] = useState(false);

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
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
          setMessage("Storage reachable ✓ · conditional writes supported ✓");
        } else if (!r.healthy) {
          setError("Storage did not respond healthy — check endpoint/bucket/credentials");
        } else {
          const why = r.capability.failedCheck ? ` (${r.capability.failedCheck})` : "";
          setError(
            `Storage reachable, but conditional writes are NOT supported${why} — coordination cannot run against this store`,
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

  async function initializeRepository(): Promise<void> {
    setInitializing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await window.multizen.sync.initializeRepository();
      if (res.ok) {
        setMessage(
          `Repository created in bucket "${res.value.target.bucket}"` +
            (res.value.target.prefix ? ` (prefix ${res.value.target.prefix})` : ""),
        );
        window.setTimeout(() => setMessage(null), 5000);
      } else {
        setError(res.error.message);
      }
      await refresh();
    } finally {
      setInitializing(false);
      setInitConfirm(false);
    }
  }

  const secretsPresent = diag?.secretsPresent;

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

      <div className="grid gap-2.5 sm:grid-cols-2">
        <TextField
          label="S3/R2 endpoint"
          value={config.s3Endpoint}
          onCommit={(v) => void patch({ s3Endpoint: v })}
          placeholder="<account>.r2.cloudflarestorage.com"
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
          label="Kopia prefix"
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
        <TextField
          label="Kopia binary override (optional)"
          value={config.kopiaBinPath}
          onCommit={(v) => void patch({ kopiaBinPath: v })}
          placeholder="/usr/local/bin/kopia"
        />
      </div>

      <label className="flex items-center gap-2.5 text-[12px] text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          checked={config.s3ForcePathStyle}
          onChange={(e) => void patch({ s3ForcePathStyle: e.target.checked })}
          className="w-3.5 h-3.5 rounded accent-purple-500"
        />
        Force path-style S3 addressing (R2 / MinIO)
      </label>

      <div className="text-[11px] text-slate-600">
        Device id: <span className="mono text-slate-500">{config.deviceId}</span>
        {diag && (
          <>
            {" · "}
            Kopia: <span className="mono text-slate-500">{diag.kopiaBinPath}</span>
          </>
        )}
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
          disabled={testing}
          leftIcon={testing ? <Loader2 size={12} className="animate-spin" /> : <Cloud size={12} />}
        >
          Test storage coordination
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
        <div className="text-[11px] font-medium text-slate-500 mb-1.5 mt-3">
          Connect an existing remote profile
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
            disabled={connecting || !connectId.trim()}
          >
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        </div>
        <div className="text-[11px] text-slate-600 mt-1.5">
          Pulls the latest snapshot for that profile id into a new local profile.
        </div>
      </div>

      <div className="pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="text-[11px] font-medium text-amber-400/80 mb-1.5 mt-3 inline-flex items-center gap-1.5">
          <TriangleAlert size={12} /> First-run: initialize repository
        </div>
        <div className="text-[11px] text-slate-500 leading-relaxed mb-2 max-w-[520px]">
          Creates a brand-new Kopia repository in the configured S3/R2 bucket so
          you don&apos;t need an external CLI. Run this <strong>once</strong>, on your{" "}
          <strong>primary device only</strong>. Do <strong>not</strong> run it on a
          second device (Mac B) — that machine connects to the existing repository
          automatically during backup or restore. Running it against a bucket that
          already holds a repository will fail rather than overwrite.
        </div>
        {!initConfirm ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setInitConfirm(true)}
            disabled={initializing}
            leftIcon={<Database size={12} />}
          >
            Initialize repository…
          </Button>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-amber-400/90">
              This creates a NEW repository. Continue only on the primary device.
            </span>
            <Button
              size="sm"
              variant="accent"
              onClick={() => void initializeRepository()}
              disabled={initializing}
              leftIcon={
                initializing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Database size={12} />
                )
              }
            >
              {initializing ? "Creating…" : "Yes, create repository"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setInitConfirm(false)}
              disabled={initializing}
            >
              Cancel
            </Button>
          </div>
        )}
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
