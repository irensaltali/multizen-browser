/**
 * Same-port HTTP dispatch for the MCP gateway's project routes.
 *
 * Registered as the `gatewayHandler` of the app's single {@link HttpTransport}
 * so gateway routes share the ONE loopback port with `/mcp`, `/sse`,
 * `/messages`, `/healthz`. It handles exactly:
 *
 *   POST|GET|DELETE /mcp/proxies/:project/:server   — relay to an upstream
 *   POST|GET|DELETE /mcp/projects/:project/browser  — profile-bound browser
 *
 * and returns `false` (fall through to global handling) for every other path,
 * so `/mcp` (broad), `/sse`, `/messages`, `/healthz` behave exactly as before.
 *
 * Security: all gates run through the core {@link Router} — loopback Host/Origin
 * validation, a body-size limit, allowed methods, and the per-project auth
 * policy (default OFF; when enabled, a constant-time device-local bearer). The
 * inbound Authorization is consumed only for that project-auth check and is
 * NEVER forwarded upstream (the connector composes only configured headers).
 * There is NO CORS: no `Access-Control-*` header is ever emitted.
 *
 * Stateful sessions use the core {@link SessionManager} (Streamable HTTP session
 * lifecycle) plus, for proxy routes, a {@link RelaySession} bridged to the
 * upstream through {@link GatewayRuntime}; for browser routes, the SDK's
 * StreamableHTTPServerTransport driving a per-session profile-bound server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  parseBearer,
  Router,
  SessionManager,
  SESSION_ID_HEADER,
  type ClientSink,
  type JsonRpcMessage,
  type ProjectAuthPolicy,
  type Route,
} from "@multizen/mcp-gateway";

import type { GatewayRuntime } from "./GatewayRuntime.ts";
import type { ProfileBoundServer } from "./ProfileBoundServer.ts";

/** Cap on a single gateway request body. Mirrors the core Router default. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Callbacks the router uses to resolve project state without holding secrets. */
export interface GatewayHttpDeps {
  /** The reconciliation runtime that owns upstreams + relay sessions. */
  readonly runtime: GatewayRuntime;
  /**
   * Resolve the per-project auth policy. Returns `{ authRequired:false }` (or
   * undefined) when the project has auth off; when on, returns the resolved
   * expected token. The token is read from the vault here and used only for the
   * constant-time compare inside the core Router — it never leaves this call.
   */
  readonly authPolicyFor: (projectId: string) => Promise<ProjectAuthPolicy | undefined>;
  /** True when the project exists and is enabled. */
  readonly projectEnabled: (projectId: string) => boolean;
  /**
   * Build (or fetch a cached) profile-bound server for a project's browser
   * route. Returns null when the project has no bound profile.
   */
  readonly boundServerFor: (projectId: string) => Promise<ProfileBoundServer | null>;
  /** Extra allowed Host authorities (the fixed loopback bind). */
  readonly allowedHosts: readonly string[];
}

interface BrowserSession {
  readonly transport: StreamableHTTPServerTransport;
}

export class GatewayHttpRouter {
  private readonly router: Router;
  /** Downstream Streamable HTTP sessions for proxy routes. */
  private readonly proxySessions = new SessionManager();
  /** Which upstream a proxy session targets. */
  private readonly proxyTargets = new Map<string, { project: string; server: string }>();
  /** SDK transports for browser-route sessions, keyed by session id. */
  private readonly browserSessions = new Map<string, BrowserSession>();

  constructor(private readonly deps: GatewayHttpDeps) {
    // The core Router's policyFor is synchronous, so we run the (async) auth
    // resolution ourselves before delegating and pass a resolved policy in.
    this.router = new Router(() => ({ authRequired: false }), {
      allowedHosts: deps.allowedHosts,
      maxBodyBytes: MAX_BODY_BYTES,
    });
  }

  /** matchRoute without running gates — to decide fall-through cheaply. */
  private matches(path: string): Route | null {
    return this.router.matchRoute(path);
  }

  /**
   * Entry point registered as HttpTransport.gatewayHandler. Returns true when it
   * fully handled the response; false to fall through to global handling.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? url;
    const route = this.matches(path);
    if (!route) return false; // Not a gateway route — fall through.

    // Resolve the project auth policy (may read a token from the vault) and run
    // the full gate suite via a per-request Router bound to that policy.
    let policy: ProjectAuthPolicy | undefined;
    try {
      policy = await this.deps.authPolicyFor(route.project);
    } catch {
      policy = { authRequired: false };
    }
    const gated = new Router(() => policy ?? { authRequired: false }, {
      allowedHosts: this.deps.allowedHosts,
      maxBodyBytes: MAX_BODY_BYTES,
    });
    const decision = gated.evaluate({
      method: req.method ?? "GET",
      path,
      headers: req.headers,
      ...(req.headers["content-length"] !== undefined
        ? { contentLength: Number(req.headers["content-length"]) }
        : {}),
    });
    if (!decision.ok) {
      this.deny(res, decision.status, decision.reason, decision.message);
      return true;
    }

    if (!this.deps.projectEnabled(route.project)) {
      this.deny(res, 404, "not-found", "project not found or disabled");
      return true;
    }

    if (route.kind === "browser") {
      await this.handleBrowser(req, res, route.project);
    } else {
      await this.handleProxy(req, res, route.project, route.server);
    }
    return true;
  }

  // ── browser route (profile-bound) ─────────────────────────────────────────

  private async handleBrowser(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
  ): Promise<void> {
    const bound = await this.deps.boundServerFor(projectId).catch(() => null);
    if (!bound) {
      this.deny(res, 404, "not-found", "no browser profile bound to this project");
      return;
    }
    const sid = firstHeader(req.headers[SESSION_ID_HEADER]);
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "POST") {
      const body = await this.readBody(req, res);
      if (body === undefined) return; // response already written (413/400)
      let existing = sid ? this.browserSessions.get(sid) : undefined;
      if (!existing) {
        // A fresh session: create a per-session SDK transport bound to a NEW
        // bound-server instance so sessions never share upstream state.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => cryptoRandomId(),
          enableJsonResponse: true,
          enableDnsRebindingProtection: true,
          allowedHosts: [...this.deps.allowedHosts],
          onsessioninitialized: (newId: string) => {
            this.browserSessions.set(newId, { transport });
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) this.browserSessions.delete(id);
        };
        await bound.server.connect(transport);
        existing = { transport };
      }
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (method === "GET" || method === "DELETE") {
      const existing = sid ? this.browserSessions.get(sid) : undefined;
      if (!existing) {
        this.deny(res, 404, "not-found", "unknown or terminated session");
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    this.deny(res, 405, "method-not-allowed", `method ${method} not allowed`);
  }

  // ── proxy route (relay to upstream) ───────────────────────────────────────

  private async handleProxy(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    serverId: string,
  ): Promise<void> {
    if (!this.deps.runtime.hasLiveServer(projectId, serverId)) {
      this.deny(res, 503, "not-found", "upstream server is not live");
      return;
    }
    const method = (req.method ?? "GET").toUpperCase() as "POST" | "GET" | "DELETE";
    const sid = firstHeader(req.headers[SESSION_ID_HEADER]);

    if (method === "POST") {
      const body = await this.readBody(req, res);
      if (body === undefined) return;
      const decision = this.proxySessions.handle({
        method: "POST",
        headers: { [SESSION_ID_HEADER]: sid, "mcp-protocol-version": firstHeader(req.headers["mcp-protocol-version"]) },
        body,
      });
      if (decision.kind === "rejected") {
        this.deny(res, decision.status, "not-found", decision.message ?? "rejected");
        return;
      }
      if (decision.kind === "created" && decision.sessionId) {
        // New session: open a relay bound to the upstream. The client sink
        // buffers server->client messages to return in this JSON response and
        // subsequent GET stream.
        this.proxyTargets.set(decision.sessionId, { project: projectId, server: serverId });
      }
      const sessionId = decision.sessionId!;
      await this.relayPost(req, res, sessionId, projectId, serverId, body, decision.headers);
      return;
    }

    if (method === "GET") {
      const decision = this.proxySessions.handle({
        method: "GET",
        headers: { [SESSION_ID_HEADER]: sid, "mcp-protocol-version": firstHeader(req.headers["mcp-protocol-version"]) },
      });
      if (decision.kind === "rejected") {
        this.deny(res, decision.status, "not-found", decision.message ?? "rejected");
        return;
      }
      // Open an SSE stream that flushes relayed server->client messages.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...(decision.sessionId ? { [SESSION_ID_HEADER]: decision.sessionId } : {}),
      });
      const stream = this.streams.get(decision.sessionId!);
      if (stream) stream.res = res;
      req.on("close", () => {
        if (decision.sessionId) this.proxySessions.closeStream(decision.sessionId);
      });
      return;
    }

    // DELETE
    const decision = this.proxySessions.handle({
      method: "DELETE",
      headers: { [SESSION_ID_HEADER]: sid },
    });
    if (decision.kind === "rejected") {
      this.deny(res, decision.status, "not-found", decision.message ?? "rejected");
      return;
    }
    if (decision.sessionId) {
      await this.deps.runtime.closeSession(decision.sessionId);
      this.proxyTargets.delete(decision.sessionId);
      this.streams.delete(decision.sessionId);
    }
    res.writeHead(200).end();
  }

  /** Per-session server->client buffered stream state for proxy routes. */
  private readonly streams = new Map<
    string,
    { res: ServerResponse | null; queue: JsonRpcMessage[]; responder: ((m: JsonRpcMessage) => void) | null }
  >();

  private async relayPost(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    projectId: string,
    serverId: string,
    body: unknown,
    extraHeaders: Readonly<Record<string, string>>,
  ): Promise<void> {
    // Ensure a relay session exists for this downstream session id.
    let relay = this.deps.runtime.session(sessionId);
    if (!relay) {
      const state = this.streams.get(sessionId) ?? { res: null, queue: [], responder: null };
      this.streams.set(sessionId, state);
      const sink: ClientSink = {
        deliver: (m: JsonRpcMessage): void => {
          // If a request is awaiting its response, resolve it; else push to the
          // SSE stream (or queue until a GET stream opens).
          if (state.responder) {
            const r = state.responder;
            state.responder = null;
            r(m);
            return;
          }
          if (state.res) {
            state.res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
          } else {
            state.queue.push(m);
          }
        },
      };
      relay = this.deps.runtime.openSession(projectId, serverId, sessionId, sink);
    }

    const messages = Array.isArray(body) ? body : [body];
    const isRequestMsg = (m: unknown): boolean =>
      typeof m === "object" && m !== null && "id" in (m as object) && "method" in (m as object);
    const hasRequest = messages.some(isRequestMsg);

    if (!hasRequest) {
      // Notifications/responses only: forward and 202 with no body.
      for (const m of messages) await relay.fromClient(m as JsonRpcMessage);
      res.writeHead(202, { ...extraHeaders }).end();
      return;
    }

    // Single request/response JSON reply (enableJsonResponse-style). Await the
    // matching response through the sink responder.
    const state = this.streams.get(sessionId)!;
    const responsePromise = new Promise<JsonRpcMessage>((resolve) => {
      state.responder = resolve;
    });
    for (const m of messages) await relay.fromClient(m as JsonRpcMessage);
    const response = await responsePromise;
    res
      .writeHead(200, { "content-type": "application/json", ...extraHeaders })
      .end(JSON.stringify(response));
  }

  // ── shared helpers ────────────────────────────────────────────────────────

  private deny(res: ServerResponse, status: number, reason: string, message: string): void {
    if (res.headersSent) return;
    // No CORS headers are ever emitted.
    res.writeHead(status, { "content-type": "application/json" }).end(
      JSON.stringify({ error: reason, message }),
    );
  }

  /** Read + JSON-parse a bounded POST body. Writes 413/400 and returns undefined on failure. */
  private readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const done = (v: unknown | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          this.deny(res, 413, "body-too-large", "request body too large");
          req.destroy();
          done(undefined);
        } else {
          chunks.push(c);
        }
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          this.deny(res, 400, "bad-request", "empty request body");
          done(undefined);
          return;
        }
        try {
          done(JSON.parse(raw));
        } catch {
          this.deny(res, 400, "bad-request", "invalid JSON body");
          done(undefined);
        }
      });
      req.on("error", () => {
        this.deny(res, 400, "bad-request", "request error");
        done(undefined);
      });
    });
  }

  /** Terminate all sessions (gateway shutdown). */
  async shutdown(): Promise<void> {
    for (const [id] of this.browserSessions) {
      const s = this.browserSessions.get(id);
      await s?.transport.close().catch(() => {});
    }
    this.browserSessions.clear();
    for (const [id] of this.proxyTargets) {
      await this.deps.runtime.closeSession(id).catch(() => {});
    }
    this.proxySessions.terminateAll();
    this.proxyTargets.clear();
    this.streams.clear();
  }
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function cryptoRandomId(): string {
  // 256 bits of CSPRNG entropy, hex — unguessable session handle.
  return randomBytes(32).toString("hex");
}
