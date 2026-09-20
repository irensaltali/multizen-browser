/**
 * Shell-free process execution primitives for the Kopia adapter.
 *
 * Everything here is built on Node built-ins only (`node:child_process`).
 * The concrete runner NEVER uses a shell: it calls `spawn` with
 * `shell: false` and an explicit argv array, so argument values can never be
 * re-interpreted by a shell. Callers inject a {@link ProcessRunner}, which
 * makes command construction and failure paths fully testable with a fake.
 */

import { spawn } from "node:child_process";

/** A single process invocation request. */
export interface ProcessRequest {
  /** Absolute path to the executable. Never passed through a shell. */
  readonly bin: string;
  /** Argument vector. Each element is passed verbatim as a single argv entry. */
  readonly args: readonly string[];
  /**
   * The COMPLETE environment for the child. The runner does not merge with
   * `process.env`; the caller is responsible for building a minimal env. This
   * keeps secrets from leaking in via ambient inheritance.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Working directory for the child process. */
  readonly cwd?: string;
  /** Hard timeout in milliseconds. On expiry the child is killed. */
  readonly timeoutMs?: number;
  /** External cancellation. When aborted, the child is killed. */
  readonly signal?: AbortSignal;
  /**
   * Values that must be scrubbed from any captured output before it is
   * surfaced (stdout/stderr in results and error messages). Empty strings are
   * ignored. These are typically secret values that could otherwise appear in
   * Kopia's diagnostic output.
   */
  readonly redact?: readonly string[];
}

/** The outcome of a completed process invocation. */
export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Redacted stdout. */
  readonly stdout: string;
  /** Redacted stderr. */
  readonly stderr: string;
  /** True when the process was killed because the timeout elapsed. */
  readonly timedOut: boolean;
  /** True when the process was killed because the AbortSignal fired. */
  readonly aborted: boolean;
}

/**
 * Injectable process execution contract. Production code uses
 * {@link NodeProcessRunner}; tests inject a fake implementation to assert on
 * the exact argv/env and to simulate timeouts, aborts, and output.
 */
export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

/**
 * Replace every occurrence of each secret value in `text` with a fixed marker.
 * Longer secrets are redacted first so that a secret which is a substring of
 * another is not left partially exposed.
 */
export function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  const values = [...new Set(secrets.filter((s) => s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of values) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/** Error thrown when the injected runner is misused with an unsafe request. */
export class UnsafeSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSpawnError";
  }
}

/**
 * Default {@link ProcessRunner} backed by `child_process.spawn` with
 * `shell: false`. Enforces the safety invariants that the rest of the adapter
 * relies on, applies the timeout + AbortSignal, and redacts captured output.
 */
export class NodeProcessRunner implements ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult> {
    const { bin, args, env, cwd, timeoutMs, signal, redact = [] } = request;

    if (typeof bin !== "string" || bin.length === 0) {
      throw new UnsafeSpawnError("bin must be a non-empty string");
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new UnsafeSpawnError("args must be an array of strings");
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      if (signal?.aborted) {
        resolve({
          code: null,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: true,
        });
        return;
      }

      const child = spawn(bin, [...args], {
        cwd,
        env: { ...env },
        // Hard invariant: no shell interpretation, ever.
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;

      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        aborted = true;
        child.kill("SIGKILL");
      };

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        // Do not keep the event loop alive solely for this timer.
        if (typeof timer.unref === "function") timer.unref();
      }

      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      child.on("close", (code, closeSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          code,
          signal: closeSignal,
          stdout: redactString(stdout, redact),
          stderr: redactString(stderr, redact),
          timedOut,
          aborted,
        });
      });
    });
  }
}
