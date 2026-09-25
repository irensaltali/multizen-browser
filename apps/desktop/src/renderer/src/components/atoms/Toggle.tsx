import type { JSX } from "react";

/**
 * A two-state on/off switch.
 *
 * Distinct from a checkbox on purpose. A checkbox means "include this in a set"
 * and is answered when a form is submitted; a switch means "this thing is on or
 * off right now" and takes effect immediately. Using the former for the latter
 * is what made the server rows ambiguous — a ticked box next to the word "on"
 * reads as a question rather than a state.
 *
 * Carries no visible text. Callers that already display the state some other way
 * (a status pill, for instance) would otherwise show the same word twice in one
 * row, which is how the server row ended up reading "off … off". Anything that
 * wants a caption puts its own next to it.
 *
 * Implemented as `role="switch"`, which is what assistive technology needs to
 * announce "on"/"off" rather than "checked"/"unchecked". Keyboard support comes
 * free from using a real `<button>`: Space and Enter both activate it.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Required — a bare switch is meaningless to a screen reader. */
  label: string;
  disabled?: boolean;
  title?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? (checked ? "Turn off" : "Turn on")}
      disabled={disabled === true}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center shrink-0 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
    >
      <span
        aria-hidden="true"
        className="relative inline-block transition-colors"
        style={{
          width: 26,
          height: 15,
          borderRadius: 999,
          background: checked ? "#a855f7" : "rgba(255,255,255,0.12)",
          boxShadow: checked
            ? "inset 0 0 0 1px rgba(168,85,247,0.6)"
            : "inset 0 0 0 1px rgba(255,255,255,0.10)",
        }}
      >
        <span
          className="absolute transition-all"
          style={{
            top: 2,
            left: checked ? 13 : 2,
            width: 11,
            height: 11,
            borderRadius: 999,
            background: checked ? "#fff" : "rgba(255,255,255,0.55)",
          }}
        />
      </span>
    </button>
  );
}
