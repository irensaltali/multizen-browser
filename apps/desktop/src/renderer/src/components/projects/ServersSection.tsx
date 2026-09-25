import { useCallback, useState, type JSX } from "react";
import { Pencil, Plus, RotateCw, Trash2 } from "lucide-react";

import type {
  GatewayOpResult,
  ProjectRuntimeView,
  ProjectView,
  ServerRuntimeView,
  ServerView,
} from "../../types";
import { Button } from "../atoms/Button";
import { Modal, Pill, Toggle, confirm, type PillKind } from "../atoms";
import {
  draftFromServerInput,
  emptyServerDraft,
  ServerForm,
  serverDraftToInput,
  validateServerDraft,
  type ServerDraft,
} from "./ServerForm";
import { Section } from "./ProjectDetail";

/**
 * The project's upstream MCP servers: what they are, whether they are actually
 * running, and the controls to add, edit, enable, restart, and remove them.
 *
 * Runtime phase comes from the gateway, so a server that cannot start (for
 * example because an environment reference has no value on this device) reports
 * that honestly instead of appearing configured-and-fine.
 */

export interface ServersSectionProps {
  readonly project: ProjectView;
  readonly runtime: ProjectRuntimeView | null;
  /**
   * Reference names that already have a value in secure storage. Used so editing
   * a server shows a stored credential as stored, rather than mistaking it for an
   * environment reference and offering to overwrite it.
   */
  readonly managedRefNames: readonly string[];
  /** Re-read the project and its runtime after a mutation. */
  readonly onChanged: () => void;
  readonly onError: (message: string | null) => void;
}

/** Map a runtime phase onto a status pill. */
function phasePill(phase: ServerRuntimeView["phase"]): { kind: PillKind; text: string } {
  switch (phase) {
    case "running":
    case "connected":
      return { kind: "running", text: phase === "running" ? "running" : "connected" };
    case "starting":
    case "connecting":
      return { kind: "pending", text: phase };
    case "backoff":
      return { kind: "pending", text: "retrying" };
    case "circuit-open":
      return { kind: "error", text: "giving up" };
    case "env-error":
      return { kind: "error", text: "needs a value" };
    case "disabled":
      return { kind: "idle", text: "off" };
    case "stopped":
    case "terminated":
      return { kind: "idle", text: "stopped" };
    default:
      return { kind: "idle", text: "idle" };
  }
}

type EditorState =
  | { kind: "closed" }
  | { kind: "add"; draft: ServerDraft }
  | { kind: "edit"; serverId: string; draft: ServerDraft };

export function ServersSection({
  project,
  runtime,
  managedRefNames,
  onChanged,
  onError,
}: ServersSectionProps): JSX.Element {
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [busy, setBusy] = useState(false);

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

  const submitEditor = useCallback(async () => {
    if (editor.kind === "closed") return;
    const problem = validateServerDraft(editor.draft);
    if (problem !== null) {
      onError(problem);
      return;
    }
    const input = serverDraftToInput(editor.draft);
    const ok =
      editor.kind === "add"
        ? await run(() => window.multizen.gateway.addServer(project.id, input))
        : await run(() => window.multizen.gateway.updateServer(project.id, input));
    if (ok) setEditor({ kind: "closed" });
  }, [editor, onError, project.id, run]);

  const remove = useCallback(
    async (server: ServerView) => {
      const confirmed = await confirm({
        title: `Remove “${server.label ?? server.id}”?`,
        body: "Its endpoint is removed from every folder’s agent configuration. The upstream server itself is not affected.",
        confirmLabel: "Remove server",
        destructive: true,
      });
      if (!confirmed) return;
      await run(() => window.multizen.gateway.removeServer(project.id, server.id));
    },
    [project.id, run],
  );

  const runtimeById = new Map(
    (runtime?.servers ?? []).map((s) => [s.serverId, s] as const),
  );
  const draftError = editor.kind === "closed" ? null : validateServerDraft(editor.draft);

  return (
    <>
      <Section
        title={`Servers (${project.servers.length})`}
        action={
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Plus size={12} />}
            onClick={() => setEditor({ kind: "add", draft: emptyServerDraft() })}
          >
            Add server
          </Button>
        }
      >
        {project.servers.length === 0 ? (
          <div className="text-[12px] text-slate-500 leading-relaxed">
            No servers yet. Add one to expose it to the agents in this project’s folders.
          </div>
        ) : (
          <div className="space-y-2" data-testid="server-list">
            {project.servers.map((server) => {
              const rt = runtimeById.get(server.id);
              const pill = rt ? phasePill(rt.phase) : { kind: "idle" as PillKind, text: "idle" };
              return (
                <div
                  key={server.id}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.02)",
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium text-slate-200 truncate">
                      {server.label ?? server.id}
                    </span>
                    <Pill kind={pill.kind}>{pill.text}</Pill>
                    <div className="flex-1" />
                    <div className="mr-1">
                      <Toggle
                        checked={!server.disabled}
                        disabled={busy}
                        label={`${server.id} enabled`}
                        title={server.disabled ? "Enable this server" : "Disable this server"}
                        onChange={(next) =>
                          void run(() =>
                            window.multizen.gateway.setServerEnabled(
                              project.id,
                              server.id,
                              next,
                            ),
                          )
                        }
                      />
                    </div>
                    <IconButton
                      label={`Restart ${server.id}`}
                      disabled={busy || server.disabled}
                      onClick={() =>
                        void run(() =>
                          window.multizen.gateway.restartServer(project.id, server.id),
                        )
                      }
                    >
                      <RotateCw size={12} />
                    </IconButton>
                    <IconButton
                      label={`Edit ${server.id}`}
                      disabled={busy}
                      onClick={() =>
                        setEditor({
                          kind: "edit",
                          serverId: server.id,
                          draft: draftFromServerInput(server, managedRefNames),
                        })
                      }
                    >
                      <Pencil size={12} />
                    </IconButton>
                    <IconButton
                      label={`Remove ${server.id}`}
                      disabled={busy}
                      danger
                      onClick={() => void remove(server)}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </div>

                  <div className="mono text-[10.5px] text-slate-500 mt-1.5 truncate">
                    {server.id} ·{" "}
                    {server.transport === "stdio"
                      ? `${server.command}${server.args.length > 0 ? ` ${server.args.join(" ")}` : ""}`
                      : server.url}
                  </div>

                  {rt !== undefined && rt.missingEnv.length > 0 && (
                    <div className="text-[11px] text-amber-200/90 mt-1.5 leading-relaxed">
                      Waiting for {rt.missingEnv.join(", ")} — provide a value in References
                      below.
                    </div>
                  )}
                  {rt?.lastError !== undefined && rt.missingEnv.length === 0 && (
                    <div className="text-[11px] text-red-300/90 mt-1.5 leading-relaxed">
                      {rt.lastError}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Modal
        open={editor.kind !== "closed"}
        onClose={() => setEditor({ kind: "closed" })}
        title={editor.kind === "edit" ? `Edit ${editor.serverId}` : "Add server"}
        subtitle="Values that must stay secret are referenced by environment variable name; you provide them in References."
        width={600}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditor({ kind: "closed" })}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submitEditor()}
              disabled={busy || draftError !== null}
            >
              {editor.kind === "edit" ? "Save changes" : "Add server"}
            </Button>
          </>
        }
      >
        <div className="px-5 py-4">
          {editor.kind !== "closed" && (
            <>
              <ServerForm
                draft={editor.draft}
                projectId={project.id}
                idEditable={editor.kind === "add"}
                onChange={(draft) => setEditor({ ...editor, draft })}
              />
              {draftError !== null && (
                <div className="text-[11px] text-red-300 mt-2" role="alert">
                  {draftError}
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
        danger === true
          ? "text-slate-500 hover:text-red-300 hover:bg-white/[0.06]"
          : "text-slate-500 hover:text-slate-200 hover:bg-white/[0.06]"
      }`}
    >
      {children}
    </button>
  );
}
