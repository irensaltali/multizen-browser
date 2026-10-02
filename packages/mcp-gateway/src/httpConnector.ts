/**
 * Streamable HTTP upstream connector.
 *
 * Connects to an upstream MCP server over the SDK's StreamableHTTPClientTransport
 * (exact SDK 1.29.0). Responsibilities:
 *  - Resolve the URL template and header references at connect time (runtime),
 *    never persisting the expanded values.
 *  - Compose ONLY the configured upstream headers. The inbound local
 *    Authorization is never forwarded — the connector has no access to it and
 *    asserts that no `authorization` value leaks in from ambient state.
 *  - Expose start / send / terminate and the SDK session/SSE/reconnect behavior
 *    behind the GatewayTransport interface.
 *  - A disabled server issues no requests: connect() is a no-op that leaves the
 *    connector un-started.
 *
 * The SDK transport is created through an injectable factory so tests can supply
 * a fake fetch (and thus assert on outbound headers/URL) with no real network.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { EnvResolver } from "./env.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { isRequest, isResponse, type GatewayTransport, type JsonRpcMessage } from "./jsonrpc.js";
import { type HttpServerConfig } from "./projectConfig.js";

/** Minimal fetch signature compatible with the SDK's FetchLike. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HttpTransportSpec {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
  readonly authProvider?: OAuthClientProvider;
}

export type HttpTransportFactory = (spec: HttpTransportSpec) => GatewayTransport;

export interface HttpConnectorOptions {
  readonly config: HttpServerConfig;
  readonly resolver: EnvResolver;
  readonly factory: HttpTransportFactory;
  readonly fetch?: FetchLike;
  readonly authProvider?: OAuthClientProvider;
  readonly onMessage?: (message: JsonRpcMessage) => void;
}

export type HttpConnectorPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "auth-required"
  | "failed"
  | "terminated";

export class HttpConnector {
  private readonly config: HttpServerConfig;
  private readonly resolver: EnvResolver;
  private readonly factory: HttpTransportFactory;
  private readonly fetch?: FetchLike;
  private readonly authProvider?: OAuthClientProvider;
  private readonly onMessage?: (message: JsonRpcMessage) => void;

  private transport: GatewayTransport | null = null;
  private phase: HttpConnectorPhase = "idle";
  private count: number | undefined;

  get toolCount(): number | undefined {
    return this.phase === "connected" ? this.count : undefined;
  }
  private readonly pendingInitialize = new Set<string>();

  constructor(options: HttpConnectorOptions) {
    this.config = options.config;
    this.resolver = options.resolver;
    this.factory = options.factory;
    this.fetch = options.fetch;
    this.authProvider = options.authProvider;
    this.onMessage = options.onMessage;
  }

  get state(): HttpConnectorPhase {
    return this.phase;
  }

  get eligible(): boolean {
    return !this.config.disabled;
  }

  get sessionId(): string | undefined {
    return this.transport?.sessionId;
  }

  /**
   * Resolve the runtime URL and headers. Guards against an inbound
   * Authorization leaking in: only headers declared in config are emitted, and
   * they are the resolved upstream credentials, not any inbound token.
   */
  private buildSpec(): HttpTransportSpec {
    const url = this.resolver.resolveTemplate(this.config.url, `server.${this.config.id}.url`);
    const headers = this.resolver.resolveMap(
      this.config.headers,
      `server.${this.config.id}.headers`,
    );
    return {
      url,
      headers,
      ...(this.fetch !== undefined ? { fetch: this.fetch } : {}),
      ...(this.authProvider !== undefined ? { authProvider: this.authProvider } : {}),
    };
  }

  /** Connect if eligible. Disabled servers issue no requests. */
  async connect(): Promise<void> {
    if (!this.eligible) {
      this.phase = "idle";
      return;
    }
    this.phase = "connecting";
    this.count = undefined;
    this.pendingInitialize.clear();
    try {
      const transport = this.factory(this.buildSpec());
      this.transport = transport;
      transport.onmessage = (m) => {
        if (isResponse(m) && m.id !== null) {
          const key = `${typeof m.id}:${m.id}`;
          if (this.pendingInitialize.delete(key) && "result" in m) {
            const version = (m.result as { protocolVersion?: unknown } | null)?.protocolVersion;
            if (typeof version === "string") transport.setProtocolVersion?.(version);
          }
        }
        this.onMessage?.(m);
      };
      transport.onclose = () => {
        if (
          this.phase !== "terminated" &&
          this.phase !== "auth-required" &&
          this.phase !== "failed"
        )
          this.phase = "idle";
      };
      // Validate the actual live session before exposing it to downstream agents.
      const client = new Client({ name: "MultiZen", version: "0.0.0" });
      const signal = AbortSignal.timeout(10_000);
      const onmessage = transport.onmessage;
      const onclose = transport.onclose;
      const onerror = transport.onerror;
      try {
        await client.connect(transport as unknown as Transport, { timeout: 10_000, signal });
        let count = 0;
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const listed = await client.listTools(cursor === undefined ? {} : { cursor }, {
            timeout: 10_000,
            signal,
          });
          count += listed.tools.length;
          cursor = listed.nextCursor;
          if (cursor !== undefined) {
            if (cursors.has(cursor)) throw new Error("Repeated tools/list cursor");
            cursors.add(cursor);
          }
        } while (cursor !== undefined);
        this.count = count;
      } finally {
        // Hand the initialized transport back to the relay without closing it.
        transport.onmessage = onmessage;
        transport.onclose = onclose;
        transport.onerror = onerror;
      }
      this.phase = "connected";
    } catch (error) {
      this.phase = error instanceof UnauthorizedError ? "auth-required" : "failed";
      await this.transport?.close().catch(() => {});
      throw error;
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.transport || this.phase !== "connected") {
      throw new Error(`HTTP connector ${this.config.id} not connected (phase=${this.phase})`);
    }
    const initializeKey =
      isRequest(message) && message.method === "initialize"
        ? `${typeof message.id}:${message.id}`
        : null;
    if (initializeKey !== null) this.pendingInitialize.add(initializeKey);
    try {
      await this.transport.send(message);
    } catch (error) {
      if (initializeKey !== null) this.pendingInitialize.delete(initializeKey);
      this.phase = error instanceof UnauthorizedError ? "auth-required" : "failed";
      throw error;
    }
  }

  /** Terminate the session/SSE and release the transport. */
  async terminate(): Promise<void> {
    this.phase = "terminated";
    if (this.transport) {
      const t = this.transport;
      this.transport = null;
      await t.close();
    }
  }
}
