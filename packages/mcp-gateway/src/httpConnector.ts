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

import { EnvResolver } from "./env.js";
import { type GatewayTransport, type JsonRpcMessage } from "./jsonrpc.js";
import { type HttpServerConfig } from "./projectConfig.js";

/** Minimal fetch signature compatible with the SDK's FetchLike. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpTransportSpec {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
}

export type HttpTransportFactory = (spec: HttpTransportSpec) => GatewayTransport;

export interface HttpConnectorOptions {
  readonly config: HttpServerConfig;
  readonly resolver: EnvResolver;
  readonly factory: HttpTransportFactory;
  readonly fetch?: FetchLike;
  readonly onMessage?: (message: JsonRpcMessage) => void;
}

export type HttpConnectorPhase = "idle" | "connecting" | "connected" | "terminated";

export class HttpConnector {
  private readonly config: HttpServerConfig;
  private readonly resolver: EnvResolver;
  private readonly factory: HttpTransportFactory;
  private readonly fetch?: FetchLike;
  private readonly onMessage?: (message: JsonRpcMessage) => void;

  private transport: GatewayTransport | null = null;
  private phase: HttpConnectorPhase = "idle";

  constructor(options: HttpConnectorOptions) {
    this.config = options.config;
    this.resolver = options.resolver;
    this.factory = options.factory;
    this.fetch = options.fetch;
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
    };
  }

  /** Connect if eligible. Disabled servers issue no requests. */
  async connect(): Promise<void> {
    if (!this.eligible) {
      this.phase = "idle";
      return;
    }
    this.phase = "connecting";
    const transport = this.factory(this.buildSpec());
    this.transport = transport;
    transport.onmessage = (m) => this.onMessage?.(m);
    transport.onclose = () => {
      if (this.phase !== "terminated") this.phase = "idle";
    };
    await transport.start();
    this.phase = "connected";
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.transport || this.phase !== "connected") {
      throw new Error(`HTTP connector ${this.config.id} not connected (phase=${this.phase})`);
    }
    await this.transport.send(message);
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
