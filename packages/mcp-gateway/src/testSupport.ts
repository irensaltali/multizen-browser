/**
 * Deterministic test fakes shared across supervisor / connector / relay tests.
 * No real timers, no real processes, no sleeps.
 */

import { type Clock } from "./stdioSupervisor.js";
import { type GatewayTransport, type JsonRpcMessage, type JsonRpcId } from "./jsonrpc.js";

/** A manually-advanced clock. Timers fire in scheduled order when advanced. */
export class FakeClock implements Clock {
  private current = 0;
  private seq = 0;
  private timers: Array<{ at: number; seq: number; fn: () => void; cancelled: boolean }> = [];

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const entry = { at: this.current + ms, seq: this.seq++, fn, cancelled: false };
    this.timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** Advance time by `ms`, firing due timers in (at, seq) order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
      const next = due[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.current = next.at;
      next.fn();
    }
    this.current = target;
  }

  get pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

export interface FakeTransportController {
  readonly transport: GatewayTransport & { onStderr?: (c: string) => void };
  /** Sent messages captured for assertions. */
  readonly sent: JsonRpcMessage[];
  started: boolean;
  closed: boolean;
  /** Simulate the upstream delivering a message. */
  deliver(message: JsonRpcMessage): void;
  /** Simulate an unexpected process exit. */
  crash(): void;
  /** Simulate a stderr chunk. */
  emitStderr(chunk: string): void;
  /** Make the next start() reject. */
  failNextStart(message: string): void;
}

export function makeFakeTransport(): FakeTransportController {
  const sent: JsonRpcMessage[] = [];
  let failMessage: string | null = null;
  const ctrl = {
    sent,
    started: false,
    closed: false,
  } as FakeTransportController & { transport: GatewayTransport & { onStderr?: (c: string) => void } };

  const transport: GatewayTransport & { onStderr?: (c: string) => void } = {
    async start(): Promise<void> {
      if (failMessage) {
        const m = failMessage;
        failMessage = null;
        throw new Error(m);
      }
      ctrl.started = true;
    },
    async close(): Promise<void> {
      ctrl.closed = true;
    },
    async send(message: JsonRpcMessage): Promise<void> {
      sent.push(message);
    },
  };

  ctrl.transport = transport;
  ctrl.deliver = (m): void => transport.onmessage?.(m);
  ctrl.crash = (): void => {
    ctrl.started = false;
    transport.onclose?.();
  };
  ctrl.emitStderr = (c): void => transport.onStderr?.(c);
  ctrl.failNextStart = (m): void => {
    failMessage = m;
  };
  return ctrl;
}

/** Build a JSON-RPC request quickly in tests. */
export function rpcRequest(id: JsonRpcId, method: string, params?: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

export function rpcResponse(id: JsonRpcId, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

export function rpcNotification(method: string, params?: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
}

/**
 * Flush pending microtasks so awaited promises inside synchronously-fired timer
 * callbacks settle. Deterministic: uses setImmediate, not a wall-clock delay.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A controllable upstream transport for relay tests. Captures everything the
 * relay sends upstream and lets the test simulate upstream-originated messages
 * (responses, server-initiated requests, notifications).
 */
export interface FakeUpstreamController {
  readonly transport: GatewayTransport;
  readonly sent: JsonRpcMessage[];
  /** Deliver a message from the upstream toward the relay. */
  deliver(message: JsonRpcMessage): void;
  /** Make the next send() reject with the given message. */
  failNextSend(message: string): void;
}

export function makeFakeUpstream(): FakeUpstreamController {
  const sent: JsonRpcMessage[] = [];
  let failMessage: string | null = null;
  const transport: GatewayTransport = {
    async start(): Promise<void> {},
    async close(): Promise<void> {},
    async send(message: JsonRpcMessage): Promise<void> {
      if (failMessage) {
        const m = failMessage;
        failMessage = null;
        throw new Error(m);
      }
      sent.push(message);
    },
  };
  return {
    transport,
    sent,
    deliver: (m): void => transport.onmessage?.(m),
    failNextSend: (m): void => {
      failMessage = m;
    },
  };
}

/** A client sink that records everything the relay delivers downstream. */
export class CapturingClientSink {
  readonly received: JsonRpcMessage[] = [];
  private failNext: string | null = null;

  deliver(message: JsonRpcMessage): void {
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = null;
      throw new Error(m);
    }
    this.received.push(message);
  }

  /** Arrange for the next deliver() to throw (simulate a dead client). */
  failNextDeliver(message: string): void {
    this.failNext = message;
  }
}

