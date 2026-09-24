/**
 * Deterministic test doubles for the gateway integration tests. No Electron, no
 * child processes, no network — everything is in-memory and synchronous where
 * possible.
 */

import type { CredentialVault } from "../../sync/CredentialVault.ts";
import type {
  GatewayTransport,
  JsonRpcMessage,
  StdioTransportFactory,
  StdioTransportSpec,
} from "@multizen/mcp-gateway";

/** In-memory credential vault (never persists, never encrypts). */
export class MemoryVault implements CredentialVault {
  private readonly store = new Map<string, string>();
  async set(name: string, value: string): Promise<void> {
    this.store.set(name, value);
  }
  async get(name: string): Promise<string | null> {
    return this.store.has(name) ? (this.store.get(name) as string) : null;
  }
  async has(name: string): Promise<boolean> {
    return this.store.has(name);
  }
  async delete(name: string): Promise<void> {
    this.store.delete(name);
  }
  async names(): Promise<string[]> {
    return [...this.store.keys()];
  }
  /** Test-only: raw dump for secret-canary assertions. */
  dump(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

/** A fake upstream stdio transport that answers `initialize` + echoes tool calls. */
export interface FakeUpstream extends GatewayTransport {
  readonly spec: StdioTransportSpec;
  readonly sent: JsonRpcMessage[];
  /** Push a message from the "upstream" toward the gateway. */
  emit(message: JsonRpcMessage): void;
}

/**
 * Build a stdio transport factory whose children reply to any request with a
 * success result echoing the method + params, and forward notifications. Lets
 * relay/session/runtime tests exercise real message flow deterministically.
 */
export function fakeStdioFactory(
  onCreate?: (t: FakeUpstream) => void,
): StdioTransportFactory {
  return (spec: StdioTransportSpec): FakeUpstream => {
    const sent: JsonRpcMessage[] = [];
    const t: FakeUpstream = {
      spec,
      sent,
      async start(): Promise<void> {
        /* immediately "running" */
      },
      async close(): Promise<void> {
        this.onclose?.();
      },
      async send(message: JsonRpcMessage): Promise<void> {
        sent.push(message);
        // Auto-answer requests so the relay's response path is exercised.
        if ("id" in message && "method" in message && message.id !== undefined) {
          const req = message as { id: string | number; method: string; params?: unknown };
          queueMicrotask(() => {
            this.onmessage?.({
              jsonrpc: "2.0",
              id: req.id,
              result: { echoed: req.method, params: req.params ?? null },
            });
          });
        }
      },
      emit(message: JsonRpcMessage): void {
        this.onmessage?.(message);
      },
    };
    onCreate?.(t);
    return t;
  };
}
