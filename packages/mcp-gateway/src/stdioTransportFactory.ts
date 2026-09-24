/**
 * Production stdio transport factory.
 *
 * Wraps the MCP SDK `StdioClientTransport` (exact SDK 1.29.0) so the supervisor
 * can remain SDK-agnostic and testable. The child is spawned shell-free by the
 * SDK from `command` + `args`; we set `stderr: "pipe"` and forward chunks to the
 * supervisor's bounded buffer. The SDK's JSONRPCMessage type is structurally
 * compatible with our GatewayTransport message type, so a thin cast bridges the
 * two without changing wire behavior.
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { type GatewayTransport, type JsonRpcMessage } from "./jsonrpc.js";
import { type StdioTransportFactory, type StdioTransportSpec } from "./stdioSupervisor.js";

interface StderrCapable {
  onStderr?: (chunk: string) => void;
}

export function createStdioTransportFactory(): StdioTransportFactory {
  return (spec: StdioTransportSpec): GatewayTransport & StderrCapable => {
    const inner = new StdioClientTransport({
      command: spec.command,
      args: [...spec.args],
      env: { ...spec.env },
      stderr: "pipe",
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    });

    const wrapper: GatewayTransport & StderrCapable = {
      async start(): Promise<void> {
        await inner.start();
        const stderr = inner.stderr;
        if (stderr) {
          stderr.on("data", (buf: Buffer) => {
            wrapper.onStderr?.(buf.toString("utf8"));
          });
        }
      },
      async close(): Promise<void> {
        await inner.close();
      },
      async send(message: JsonRpcMessage): Promise<void> {
        // SDK JSONRPCMessage is structurally the same 2.0 envelope.
        await inner.send(message as never);
      },
    };

    inner.onmessage = (m): void => wrapper.onmessage?.(m as unknown as JsonRpcMessage);
    inner.onerror = (e): void => wrapper.onerror?.(e);
    inner.onclose = (): void => wrapper.onclose?.();

    return wrapper;
  };
}
