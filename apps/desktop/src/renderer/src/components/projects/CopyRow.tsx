import { useCallback, useState, type JSX } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A read-only value with a copy button — used for endpoint URLs and the
 * environment variable name an agent must have exported.
 *
 * Clipboard access can be denied (or absent, in a non-secure context), so the
 * button reports failure rather than silently pretending to have copied.
 */

export interface CopyRowProps {
  readonly value: string;
  /** Accessible name for the copy button, e.g. "Copy browser endpoint". */
  readonly label: string;
  /** Optional caption rendered above the value. */
  readonly caption?: string;
}

export function CopyRow({ value, label, caption }: CopyRowProps): JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1600);
  }, [value]);

  return (
    <div>
      {caption !== undefined && (
        <div className="text-[10.5px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
          {caption}
        </div>
      )}
      <div
        className="flex items-center gap-2"
        style={{
          borderRadius: 9,
          background: "rgba(0,0,0,0.25)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
          padding: "6px 6px 6px 10px",
        }}
      >
        <code
          className="mono text-[11.5px] text-slate-300 flex-1 min-w-0"
          style={{ overflowX: "auto", whiteSpace: "nowrap" }}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={label}
          title={label}
          className="flex-shrink-0 flex items-center justify-center transition-colors"
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background:
              state === "copied"
                ? "rgba(16,185,129,0.14)"
                : state === "failed"
                  ? "rgba(239,68,68,0.14)"
                  : "rgba(255,255,255,0.04)",
            boxShadow:
              state === "copied"
                ? "inset 0 0 0 1px rgba(16,185,129,0.3)"
                : state === "failed"
                  ? "inset 0 0 0 1px rgba(239,68,68,0.3)"
                  : "inset 0 0 0 1px rgba(255,255,255,0.08)",
            color:
              state === "copied" ? "#6ee7b7" : state === "failed" ? "#fca5a5" : "#94a3b8",
          }}
        >
          {state === "copied" ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      {state === "failed" && (
        <div className="text-[10.5px] text-red-300 mt-1" role="status">
          Couldn’t reach the clipboard — select the text and copy it manually.
        </div>
      )}
    </div>
  );
}
