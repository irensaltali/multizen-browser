/**
 * Full MCP JSON-RPC relay.
 *
 * A `RelaySession` bidirectionally bridges exactly one *downstream* client
 * (something a local MCP client drives — e.g. Cursor talking to the gateway)
 * to exactly one *upstream* server transport (a supervised stdio child or a
 * streamable-http connector). It is transport-agnostic: it consumes and
 * produces raw JSON-RPC 2.0 messages (see jsonrpc.ts) so that params, results,
 * errors, cursors, structured content, annotations, and `_meta` pass through
 * verbatim. The relay never inspects or rewrites payload bodies beyond the
 * `id` field it must remap.
 *
 * What the relay guarantees:
 *
 *  - **Client→server requests** are forwarded with a gateway-allocated upstream
 *    id so that multiple sessions multiplexed onto one upstream never collide.
 *    The matching response is mapped back to the client's original id, error
 *    object, and `_meta` intact.
 *  - **Server→client requests** (`roots/list`, `sampling/createMessage`,
 *    `elicitation/create`) are routed to *this* originating downstream session —
 *    the session isolation guarantee. If the session has no live client the
 *    relay answers the upstream deterministically with a JSON-RPC error rather
 *    than hanging.
 *  - **Notifications** flow in both directions untouched: progress, cancelled,
 *    list-changed, resource updated, logging message, initialized.
 *  - **Cancellation** (`notifications/cancelled`) is remapped like a request so
 *    the upstream cancels the correct in-flight id, and any pending client
 *    request is cleaned up.
 *  - **Close** rejects every outstanding request on both directions with a
 *    deterministic error; nothing is left dangling.
 *
 * The relay does NOT implement the MCP capability handshake policy itself — it
 * forwards `initialize` transparently so the downstream client negotiates
 * directly with the upstream server. This keeps the gateway honest about which
 * features the upstream actually supports.
 */

import {
  isError,
  isNotification,
  isRequest,
  isResponse,
  JSON_RPC,
  MCP_ERROR,
  type GatewayTransport,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";

/** Server-initiated request methods that must be routed back to the client. */
export const SERVER_INITIATED_METHODS: ReadonlySet<string> = new Set([
  "roots/list",
  "sampling/createMessage",
  "elicitation/create",
]);

/** A minimal sink for delivering messages toward the downstream client. */
export interface ClientSink {
  /** Deliver a message to the downstream client. */
  deliver(message: JsonRpcMessage): void | Promise<void>;
}

export interface RelaySessionOptions {
  /** Stable id of this downstream session (for diagnostics/isolation). */
  readonly sessionId: string;
  /** The upstream transport this session is bound to. */
  readonly upstream: GatewayTransport;
  /** Where server->client messages are delivered. */
  readonly client: ClientSink;
  /**
   * Allocate a globally-unique upstream id from a client id. Injectable for
   * deterministic tests; defaults to a monotonic per-session counter with the
   * session id namespaced in so two sessions never collide on one upstream.
   */
  readonly allocateUpstreamId?: (clientId: JsonRpcId) => JsonRpcId;
}

interface PendingClientRequest {
  readonly clientId: JsonRpcId;
  readonly method: string;
}

interface PendingServerRequest {
  readonly upstreamId: JsonRpcId;
}

function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/**
 * One downstream client bound to one upstream server. Constructed by the
 * gateway once a client selects a route/server. Multiple RelaySessions may
 * target the same upstream transport; id remapping keeps them isolated.
 */
export class RelaySession {
  readonly sessionId: string;
  private readonly upstream: GatewayTransport;
  private readonly client: ClientSink;
  private readonly allocateUpstreamId: (clientId: JsonRpcId) => JsonRpcId;

  /** upstreamId -> original client request (for mapping the response back). */
  private readonly clientRequests = new Map<string, PendingClientRequest>();
  /** clientId -> upstreamId, to remap cancellation notifications. */
  private readonly clientToUpstream = new Map<string, JsonRpcId>();
  /** Server-initiated requests awaiting a client answer, keyed by upstream id. */
  private readonly serverRequests = new Map<string, PendingServerRequest>();

  private idSeq = 0;
  private closed = false;

  constructor(options: RelaySessionOptions) {
    this.sessionId = options.sessionId;
    this.upstream = options.upstream;
    this.client = options.client;
    this.allocateUpstreamId =
      options.allocateUpstreamId ??
      ((_clientId): JsonRpcId => `${this.sessionId}#${this.idSeq++}`);

    // Bind upstream -> (client | server-request) demux.
    this.upstream.onmessage = (m): void => {
      void this.onUpstreamMessage(m);
    };
  }

  private key(id: JsonRpcId): string {
    return typeof id === "number" ? `n:${id}` : `s:${id}`;
  }

  /**
   * Handle a message arriving from the downstream client. Returns a promise
   * that settles once the message has been dispatched to the upstream (or a
   * synchronous error has been delivered back to the client).
   */
  async fromClient(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      if (isRequest(message)) {
        await this.client.deliver(
          errorResponse(message.id, MCP_ERROR.REQUEST_CANCELLED, "Session is closed"),
        );
      }
      return;
    }

    if (isRequest(message)) {
      await this.forwardClientRequest(message);
      return;
    }
    if (isResponse(message)) {
      // A response from the client answers a server-initiated request.
      await this.forwardClientResponse(message);
      return;
    }
    if (isNotification(message)) {
      await this.forwardClientNotification(message);
      return;
    }
  }

  private async forwardClientRequest(req: JsonRpcRequest): Promise<void> {
    const upstreamId = this.allocateUpstreamId(req.id);
    this.clientRequests.set(this.key(upstreamId), { clientId: req.id, method: req.method });
    this.clientToUpstream.set(this.key(req.id), upstreamId);
    const forwarded: JsonRpcRequest = { ...req, id: upstreamId };
    try {
      await this.upstream.send(forwarded, { relatedRequestId: upstreamId });
    } catch (err) {
      this.clientRequests.delete(this.key(upstreamId));
      this.clientToUpstream.delete(this.key(req.id));
      await this.client.deliver(
        errorResponse(
          req.id,
          JSON_RPC.INTERNAL_ERROR,
          `Upstream send failed: ${(err as Error).message}`,
        ),
      );
    }
  }

  private async forwardClientNotification(note: JsonRpcNotification): Promise<void> {
    // Cancellation carries a requestId that must be remapped to the upstream id.
    if (note.method === "notifications/cancelled") {
      const params = (note.params ?? {}) as { requestId?: JsonRpcId };
      const clientReqId = params.requestId;
      if (clientReqId !== undefined) {
        const upstreamId = this.clientToUpstream.get(this.key(clientReqId));
        if (upstreamId === undefined) {
          // Nothing in flight for this id; drop silently (idempotent cancel).
          return;
        }
        const remapped: JsonRpcNotification = {
          ...note,
          params: { ...(note.params as object), requestId: upstreamId },
        };
        // Free local bookkeeping; the upstream will (eventually) stop the work.
        this.clientRequests.delete(this.key(upstreamId));
        this.clientToUpstream.delete(this.key(clientReqId));
        await this.upstream.send(remapped, { relatedRequestId: upstreamId });
        return;
      }
    }
    await this.upstream.send(note);
  }

  private async forwardClientResponse(res: JsonRpcResponse): Promise<void> {
    if (res.id === null) return; // Null-id error responses answer nothing.
    const pending = this.serverRequests.get(this.key(res.id));
    if (!pending) {
      // No matching server request; a stray response is dropped.
      return;
    }
    this.serverRequests.delete(this.key(res.id));
    // The server used its own id; the client echoes it back unchanged because
    // server-initiated ids are forwarded verbatim (see routeServerRequest).
    await this.upstream.send(res);
  }

  private async onUpstreamMessage(message: JsonRpcMessage): Promise<void> {
    if (this.closed) return;

    if (isResponse(message)) {
      await this.routeUpstreamResponse(message);
      return;
    }
    if (isRequest(message)) {
      await this.routeServerRequest(message);
      return;
    }
    if (isNotification(message)) {
      // Notifications (progress, list_changed, resources/updated, logging,
      // initialized, ...) pass straight through to the client untouched.
      await this.client.deliver(message);
      return;
    }
  }

  private async routeUpstreamResponse(res: JsonRpcResponse): Promise<void> {
    if (res.id === null) {
      // A protocol-level error with no id cannot be correlated to a client
      // request; there is nothing to route it to. Drop it (isolation-safe).
      return;
    }
    const pending = this.clientRequests.get(this.key(res.id));
    if (!pending) {
      // Response to an id we do not own (e.g. another session). Isolation:
      // never deliver another session's response to this client.
      return;
    }
    this.clientRequests.delete(this.key(res.id));
    this.clientToUpstream.delete(this.key(pending.clientId));
    // Remap the id back to the client's original; preserve result/error/_meta.
    const mapped: JsonRpcResponse = isError(res)
      ? { jsonrpc: "2.0", id: pending.clientId, error: res.error }
      : { jsonrpc: "2.0", id: pending.clientId, result: res.result };
    await this.client.deliver(mapped);
  }

  private async routeServerRequest(req: JsonRpcRequest): Promise<void> {
    if (!SERVER_INITIATED_METHODS.has(req.method)) {
      // The gateway does not implement server->gateway requests itself. Answer
      // deterministically so the upstream is not left hanging.
      await this.upstream.send(
        errorResponse(
          req.id,
          JSON_RPC.METHOD_NOT_FOUND,
          `Server-initiated method not routable: ${req.method}`,
        ),
      );
      return;
    }
    // Route to THIS session's originating client. Forward the upstream id
    // verbatim; the client's response is matched back by that id.
    this.serverRequests.set(this.key(req.id), { upstreamId: req.id });
    try {
      await this.client.deliver(req);
    } catch (err) {
      this.serverRequests.delete(this.key(req.id));
      await this.upstream.send(
        errorResponse(
          req.id,
          MCP_ERROR.NO_ELIGIBLE_CLIENT,
          `No client to service ${req.method}: ${(err as Error).message}`,
        ),
      );
    }
  }

  /** Number of client requests awaiting an upstream response. */
  get pendingClientRequests(): number {
    return this.clientRequests.size;
  }

  /** Number of server-initiated requests awaiting a client response. */
  get pendingServerRequests(): number {
    return this.serverRequests.size;
  }

  /**
   * Close the session. Every outstanding client request is answered with a
   * cancellation error, and every outstanding server request is answered
   * upstream with NO_ELIGIBLE_CLIENT so neither side is left hanging. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const pending of this.clientRequests.values()) {
      await this.client.deliver(
        errorResponse(pending.clientId, MCP_ERROR.REQUEST_CANCELLED, "Session closed"),
      );
    }
    this.clientRequests.clear();
    this.clientToUpstream.clear();

    for (const pending of this.serverRequests.values()) {
      await this.upstream.send(
        errorResponse(pending.upstreamId, MCP_ERROR.NO_ELIGIBLE_CLIENT, "Session closed"),
      );
    }
    this.serverRequests.clear();
  }
}
