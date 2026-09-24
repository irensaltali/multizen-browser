/**
 * Supervised stdio upstream.
 *
 * Wraps a stdio MCP server child process with lifecycle supervision:
 *  - Shell-free launch: command + literal argv, never a shell string.
 *  - Allowlisted base env plus strict `${VAR}` resolution for declared env.
 *  - Trusted+enabled servers start at launch; disabled servers never start.
 *  - Bounded stderr ring buffer (never unbounded memory growth).
 *  - Crash recovery with capped exponential backoff and a circuit breaker that
 *    opens after too many consecutive failures.
 *  - Runtime state (phase, restarts, breaker) is kept strictly separate from
 *    the desired StdioServerConfig.
 *
 * All time and process creation are injected, so tests use a deterministic fake
 * clock and fake transport with no real sleeps or child processes. In
 * production the transport factory returns the SDK's StdioClientTransport (see
 * `createStdioTransportFactory`).
 */

import { EnvResolver } from "./env.js";
import { type GatewayTransport, type JsonRpcMessage } from "./jsonrpc.js";
import { type StdioServerConfig } from "./projectConfig.js";

export type SupervisorPhase =
  | "idle"
  | "starting"
  | "running"
  | "backoff"
  | "circuit-open"
  | "stopped";

export interface Clock {
  now(): number;
  /** Schedule a callback after `ms`. Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
}

/** Real wall-clock implementation. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export interface StdioTransportSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export type StdioTransportFactory = (spec: StdioTransportSpec) => GatewayTransport & {
  /** Optional stderr stream hookup; supervisor calls this if present. */
  onStderr?: (chunk: string) => void;
};

export interface BackoffPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  /** Consecutive failures before the breaker opens. */
  readonly breakerThreshold: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  breakerThreshold: 5,
};

export interface SupervisorOptions {
  readonly config: StdioServerConfig;
  readonly resolver: EnvResolver;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly factory: StdioTransportFactory;
  readonly clock?: Clock;
  readonly backoff?: Partial<BackoffPolicy>;
  /** Max bytes retained in the stderr ring buffer. Default 64 KiB. */
  readonly maxStderrBytes?: number;
  /** Called for every message received from the upstream. */
  readonly onMessage?: (message: JsonRpcMessage) => void;
}

export interface RuntimeState {
  readonly phase: SupervisorPhase;
  readonly consecutiveFailures: number;
  readonly restarts: number;
  readonly lastError?: string;
}

export class StdioSupervisor {
  private readonly config: StdioServerConfig;
  private readonly resolver: EnvResolver;
  private readonly baseEnv: Readonly<Record<string, string>>;
  private readonly factory: StdioTransportFactory;
  private readonly clock: Clock;
  private readonly backoff: BackoffPolicy;
  private readonly maxStderrBytes: number;
  private readonly onMessage?: (message: JsonRpcMessage) => void;

  private transport: (GatewayTransport & { onStderr?: (c: string) => void }) | null = null;
  private cancelTimer: (() => void) | null = null;
  private stderrBuf = "";
  private phase: SupervisorPhase = "idle";
  private consecutiveFailures = 0;
  private restarts = 0;
  private lastError: string | undefined;
  private desiredRunning = false;

  constructor(options: SupervisorOptions) {
    this.config = options.config;
    this.resolver = options.resolver;
    this.baseEnv = options.baseEnv;
    this.factory = options.factory;
    this.clock = options.clock ?? systemClock;
    this.backoff = { ...DEFAULT_BACKOFF, ...(options.backoff ?? {}) };
    this.maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
    this.onMessage = options.onMessage;
  }

  get state(): RuntimeState {
    return {
      phase: this.phase,
      consecutiveFailures: this.consecutiveFailures,
      restarts: this.restarts,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  /** Snapshot of the bounded stderr buffer. */
  get stderr(): string {
    return this.stderrBuf;
  }

  /** True iff the desired config permits this server to run. */
  get eligible(): boolean {
    return !this.config.disabled;
  }

  /**
   * Build the concrete launch spec by resolving env references against the
   * allowlisted base env. Throws if a reference is unresolved/forbidden.
   */
  private buildSpec(): StdioTransportSpec {
    const resolvedEnv = this.resolver.resolveMap(this.config.env, `server.${this.config.id}.env`);
    return {
      command: this.config.command,
      args: [...this.config.args],
      // Child sees the allowlisted base env plus explicitly declared vars.
      env: { ...this.baseEnv, ...resolvedEnv },
      ...(this.config.cwd !== undefined ? { cwd: this.config.cwd } : {}),
    };
  }

  private appendStderr(chunk: string): void {
    this.stderrBuf += chunk;
    if (this.stderrBuf.length > this.maxStderrBytes) {
      this.stderrBuf = this.stderrBuf.slice(this.stderrBuf.length - this.maxStderrBytes);
    }
  }

  /** Start the upstream if eligible. Disabled servers never start. */
  async start(): Promise<void> {
    if (!this.eligible) {
      this.phase = "idle";
      return;
    }
    this.desiredRunning = true;
    await this.launch();
  }

  private async launch(): Promise<void> {
    if (!this.desiredRunning || !this.eligible) return;
    this.phase = "starting";
    const spec = this.buildSpec();
    const transport = this.factory(spec);
    this.transport = transport;
    transport.onmessage = (m) => this.onMessage?.(m);
    transport.onStderr = (c) => this.appendStderr(c);
    transport.onerror = (err) => {
      this.lastError = err.message;
    };
    transport.onclose = () => {
      this.handleExit();
    };
    try {
      await transport.start();
      this.phase = "running";
      this.consecutiveFailures = 0;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.transport = null;
      this.scheduleRetry();
    }
  }

  private handleExit(): void {
    if (!this.desiredRunning) {
      this.phase = "stopped";
      return;
    }
    // Unexpected exit while we wanted it running -> treat as a crash.
    this.transport = null;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.backoff.breakerThreshold) {
      this.phase = "circuit-open";
      return;
    }
    const attempt = this.consecutiveFailures - 1;
    const delay = Math.min(
      this.backoff.maxDelayMs,
      this.backoff.initialDelayMs * this.backoff.factor ** attempt,
    );
    this.phase = "backoff";
    this.cancelTimer?.();
    this.cancelTimer = this.clock.setTimeout(() => {
      this.restarts += 1;
      void this.launch();
    }, delay);
  }

  /** Manually reset the breaker and attempt a relaunch. */
  async resetAndStart(): Promise<void> {
    this.consecutiveFailures = 0;
    this.desiredRunning = true;
    await this.launch();
  }

  /** Send a message to the running upstream. */
  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.transport || this.phase !== "running") {
      throw new Error(`Server ${this.config.id} is not running (phase=${this.phase})`);
    }
    await this.transport.send(message);
  }

  /** Graceful stop: cancels retries and closes the transport. */
  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.transport) {
      const t = this.transport;
      this.transport = null;
      await t.close();
    }
    this.phase = "stopped";
  }
}
