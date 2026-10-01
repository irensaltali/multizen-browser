/**
 * Production streamable-http transport factory.
 *
 * Wraps the MCP SDK `StreamableHTTPClientTransport` (exact SDK 1.29.0). The
 * resolved upstream headers are attached via `requestInit.headers`; the SDK
 * manages the Mcp-Session-Id, SSE stream, reconnection, and DELETE-based
 * termination internally. OAuth servers supply a per-server `authProvider`;
 * header-auth servers continue to use configured header references.
 *
 * The inbound local Authorization is never passed here: only the resolved
 * config headers reach `requestInit`.
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { type GatewayTransport, type JsonRpcMessage } from "./jsonrpc.js";
import { type HttpTransportFactory, type HttpTransportSpec } from "./httpConnector.js";

export function createHttpTransportFactory(): HttpTransportFactory {
  return (spec: HttpTransportSpec): GatewayTransport => {
    const endpoint = new URL(spec.url);
    if (
      spec.authProvider &&
      endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      )
    ) {
      throw new Error("OAuth MCP endpoints must use HTTPS or a loopback HTTP URL.");
    }
    const inner = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { ...spec.headers } },
      ...(spec.authProvider !== undefined ? { authProvider: spec.authProvider } : {}),
      ...(spec.fetch !== undefined ? { fetch: spec.fetch as never } : {}),
    });

    const wrapper: GatewayTransport = {
      setProtocolVersion(version: string): void {
        inner.setProtocolVersion(version);
      },
      async finishAuth(code: string): Promise<void> {
        await inner.finishAuth(code);
      },
      async start(): Promise<void> {
        await inner.start();
      },
      async close(): Promise<void> {
        // terminateSession issues the DELETE when a session exists; close()
        // then tears down the SSE stream. Guard terminate for servers that
        // never established a session.
        try {
          await inner.terminateSession();
        } catch {
          // Non-fatal: server may not support session termination.
        }
        await inner.close();
      },
      async send(message: JsonRpcMessage): Promise<void> {
        await inner.send(message as never);
      },
      get sessionId(): string | undefined {
        return inner.sessionId;
      },
    };

    inner.onmessage = (m): void => wrapper.onmessage?.(m as unknown as JsonRpcMessage);
    inner.onerror = (e): void => wrapper.onerror?.(e);
    inner.onclose = (): void => wrapper.onclose?.();

    return wrapper;
  };
}
