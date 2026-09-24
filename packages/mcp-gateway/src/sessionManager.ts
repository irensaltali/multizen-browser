/**
 * Stateful downstream Streamable HTTP session manager.
 *
 * This owns the server-side session lifecycle of the gateway's own MCP
 * endpoint — the transport a local client (Cursor, Claude Desktop, Codex)
 * connects to. It is framework-agnostic: it decides, per HTTP verb, what the
 * gateway should do and which headers to emit, without binding to any concrete
 * HTTP server. The desktop composes it into its real transport.
 *
 * Protocol shape implemented (MCP Streamable HTTP):
 *
 *  - **POST** carries JSON-RPC. The first POST is an `initialize` request; it
 *    allocates a cryptographically-random session id returned in the
 *    `Mcp-Session-Id` response header. Subsequent POSTs MUST echo that id and
 *    are validated against the live session set.
 *  - **GET** opens the server->client SSE stream for a session (server-initiated
 *    requests, notifications, progress). Requires a valid `Mcp-Session-Id`.
 *  - **DELETE** terminates a session; the id is invalidated and any further use
 *    is rejected.
 *  - **Mcp-Protocol-Version** is validated on non-initialize requests against
 *    the set of supported versions. An unsupported/malformed version is a 400.
 *
 * Session ids are 256 bits of CSPRNG entropy, hex-encoded, so they are
 * unguessable and safe to place in a header. Ids are the only client-visible
 * handle; all server state hangs off them here.
 *
 * SSE / resumption: the manager tracks whether a session has an open stream and
 * assigns monotonic event ids for resumption. True byte-level replay of missed
 * events requires a durable event store, which is a transport-layer concern and
 * intentionally left to the composing HTTP transport; see the limitations note
 * in the package README/summary.
 */

import { randomBytes } from "node:crypto";

/** MCP-supported protocol versions (mirrors SDK SUPPORTED_PROTOCOL_VERSIONS). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

export const SESSION_ID_HEADER = "mcp-session-id";
export const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

export type HttpVerb = "POST" | "GET" | "DELETE";

export interface SessionRequest {
  readonly method: HttpVerb;
  /** Lower-cased header lookup. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /**
   * Parsed JSON-RPC body for POST (may be a single message or a batch). Used
   * only to detect whether the POST is an `initialize` request.
   */
  readonly body?: unknown;
}

export type SessionDecisionKind =
  | "created" // initialize accepted; new session established
  | "accepted" // valid existing-session request
  | "stream-opened" // GET opened an SSE stream for a session
  | "terminated" // DELETE removed a session
  | "rejected"; // validation failure

export interface SessionDecision {
  readonly kind: SessionDecisionKind;
  readonly status: number;
  /** Session id involved (present on success and on most rejections). */
  readonly sessionId?: string;
  /** Response headers the transport should set. */
  readonly headers: Readonly<Record<string, string>>;
  /** Human-readable reason on rejection. */
  readonly message?: string;
}

export interface SessionState {
  readonly id: string;
  readonly createdAt: number;
  streamOpen: boolean;
  /** Monotonic SSE event counter for resumption ids. */
  lastEventId: number;
}

export interface SessionManagerOptions {
  /** Injectable id generator (tests). Default: 32 random bytes as hex. */
  readonly generateId?: () => string;
  /** Injectable clock. Default Date.now. */
  readonly now?: () => number;
  /** Max concurrent sessions. Default 256. */
  readonly maxSessions?: number;
}

function defaultId(): string {
  return randomBytes(32).toString("hex");
}

function isInitializeBody(body: unknown): boolean {
  const check = (m: unknown): boolean =>
    typeof m === "object" &&
    m !== null &&
    (m as { method?: unknown }).method === "initialize";
  if (Array.isArray(body)) return body.some(check);
  return check(body);
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly maxSessions: number;

  constructor(options: SessionManagerOptions = {}) {
    this.generateId = options.generateId ?? defaultId;
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? 256;
  }

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Validate the Mcp-Protocol-Version header if present. */
  private validateProtocol(headers: Readonly<Record<string, string | undefined>>): string | null {
    const v = headers[PROTOCOL_VERSION_HEADER];
    if (v === undefined) return null; // Optional; absence is tolerated.
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(v)) {
      return `Unsupported ${PROTOCOL_VERSION_HEADER}: ${v}`;
    }
    return null;
  }

  private reject(status: number, message: string, sessionId?: string): SessionDecision {
    return {
      kind: "rejected",
      status,
      headers: {},
      message,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }

  /**
   * Decide how to handle an inbound request against the session store. Pure
   * with respect to the store except for the explicit create/terminate/stream
   * mutations it performs, which are the whole point of a stateful manager.
   */
  handle(req: SessionRequest): SessionDecision {
    const protocolError = this.validateProtocol(req.headers);
    // initialize requests legitimately omit/precede protocol negotiation, so we
    // only enforce protocol on non-initialize traffic below.

    if (req.method === "POST") {
      const isInit = isInitializeBody(req.body);
      const existingId = req.headers[SESSION_ID_HEADER];

      if (isInit) {
        // An initialize must NOT carry an existing session id.
        if (existingId !== undefined) {
          return this.reject(400, "initialize must not include a session id", existingId);
        }
        if (this.sessions.size >= this.maxSessions) {
          return this.reject(503, "Session limit reached");
        }
        const id = this.generateId();
        this.sessions.set(id, {
          id,
          createdAt: this.now(),
          streamOpen: false,
          lastEventId: 0,
        });
        return {
          kind: "created",
          status: 200,
          sessionId: id,
          headers: { [SESSION_ID_HEADER]: id },
        };
      }

      // Non-initialize POST requires a valid, live session and protocol header.
      if (protocolError) return this.reject(400, protocolError, existingId);
      if (existingId === undefined) {
        return this.reject(400, `Missing ${SESSION_ID_HEADER}`);
      }
      if (!this.sessions.has(existingId)) {
        return this.reject(404, "Unknown or terminated session", existingId);
      }
      return { kind: "accepted", status: 200, sessionId: existingId, headers: {} };
    }

    if (req.method === "GET") {
      if (protocolError) return this.reject(400, protocolError);
      const id = req.headers[SESSION_ID_HEADER];
      if (id === undefined) return this.reject(400, `Missing ${SESSION_ID_HEADER}`);
      const state = this.sessions.get(id);
      if (!state) return this.reject(404, "Unknown or terminated session", id);
      state.streamOpen = true;
      return {
        kind: "stream-opened",
        status: 200,
        sessionId: id,
        headers: { "content-type": "text/event-stream" },
      };
    }

    if (req.method === "DELETE") {
      const id = req.headers[SESSION_ID_HEADER];
      if (id === undefined) return this.reject(400, `Missing ${SESSION_ID_HEADER}`);
      if (!this.sessions.delete(id)) {
        return this.reject(404, "Unknown or terminated session", id);
      }
      return { kind: "terminated", status: 200, sessionId: id, headers: {} };
    }

    return this.reject(405, `Method not allowed: ${req.method as string}`);
  }

  /**
   * Allocate the next SSE event id for a session (resumption support). Returns
   * a string `event: <sessionId>-<n>` id, monotonic per session. Callers attach
   * it to outbound SSE frames so a resuming client can indicate its last id.
   */
  nextEventId(sessionId: string): string | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    state.lastEventId += 1;
    return `${sessionId}-${state.lastEventId}`;
  }

  /** Mark a session's stream closed (client disconnected the SSE channel). */
  closeStream(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.streamOpen = false;
  }

  /** Explicitly terminate a session outside the HTTP path (e.g. shutdown). */
  terminate(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Terminate all sessions (gateway shutdown). */
  terminateAll(): void {
    this.sessions.clear();
  }
}
