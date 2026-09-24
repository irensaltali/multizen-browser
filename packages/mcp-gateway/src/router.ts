/**
 * Framework-agnostic gateway router.
 *
 * This module owns the *decision* of how an inbound HTTP request maps to a
 * gateway target, plus the security gates that must pass before any upstream is
 * touched. It is deliberately independent of Electron's HttpTransport (or any
 * server): it operates on a plain, minimal request description and returns a
 * plain decision. The desktop can compose it into its own transport later.
 *
 * Routes:
 *   /mcp/proxies/:project/:server   -> proxy to a configured upstream server
 *   /mcp/projects/:project/browser  -> the project's browser endpoint
 *
 * Security gates (applied in order):
 *   1. Host/Origin loopback validation — refuse cross-origin / non-loopback
 *      hosts to prevent DNS-rebinding and remote access.
 *   2. Body size limit — refuse oversized bodies before buffering upstream.
 *   3. Project auth policy — default OFF. When a project enables localAuth, a
 *      bearer token is required and compared in constant time.
 *
 * The inbound Authorization header is consumed only for local auth; it is never
 * forwarded upstream (that is the connector's contract, enforced there too).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { isSafeId, type ProjectId, type ServerId } from "./ids.js";

export type RouteKind = "proxy" | "browser";

export interface ProxyRoute {
  readonly kind: "proxy";
  readonly project: ProjectId;
  readonly server: ServerId;
}

export interface BrowserRoute {
  readonly kind: "browser";
  readonly project: ProjectId;
}

export type Route = ProxyRoute | BrowserRoute;

export interface RouterRequest {
  readonly method: string;
  /** Path portion of the URL (no query string), e.g. "/mcp/proxies/p/s". */
  readonly path: string;
  /** Lower-cased header lookup. Values may be arrays (as Node provides). */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Declared body byte length, if known (e.g. Content-Length). */
  readonly contentLength?: number;
}

export type DenyReason =
  | "not-found"
  | "bad-host"
  | "bad-origin"
  | "body-too-large"
  | "unauthorized"
  | "method-not-allowed";

export interface RouteDenied {
  readonly ok: false;
  readonly status: number;
  readonly reason: DenyReason;
  readonly message: string;
}

export interface RouteAllowed {
  readonly ok: true;
  readonly route: Route;
}

export type RouteResult = RouteAllowed | RouteDenied;

export interface ProjectAuthPolicy {
  /** When false (default) no inbound bearer is required. */
  readonly authRequired: boolean;
  /** Resolved expected token (already env-resolved). Required iff authRequired. */
  readonly expectedToken?: string;
}

export interface RouterOptions {
  /** Max inbound body size in bytes. Default 4 MiB. */
  readonly maxBodyBytes?: number;
  /**
   * Extra host:port authorities to accept beyond loopback literals. Useful for
   * a fixed localhost bind. Compared case-insensitively against the Host header.
   */
  readonly allowedHosts?: readonly string[];
  /** Allowed HTTP methods for gateway routes. Default POST/GET/DELETE. */
  readonly allowedMethods?: readonly string[];
}

const DEFAULT_MAX_BODY = 4 * 1024 * 1024;
const DEFAULT_METHODS = ["POST", "GET", "DELETE"] as const;

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** True when a hostname (no port) is a loopback literal or "localhost". */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  if (h === "127.0.0.1" || h.startsWith("127.")) return true;
  if (h === "::1" || h === "[::1]") return true;
  return false;
}

function splitAuthority(authority: string): { host: string; port?: string } {
  // IPv6 literal in brackets, optionally with port.
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end === -1) return { host: authority };
    const host = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    const port = rest.startsWith(":") ? rest.slice(1) : undefined;
    return port !== undefined ? { host, port } : { host };
  }
  const idx = authority.lastIndexOf(":");
  if (idx === -1) return { host: authority };
  return { host: authority.slice(0, idx), port: authority.slice(idx + 1) };
}

/**
 * Constant-time comparison of two UTF-8 strings. Both inputs are reduced to a
 * fixed-length SHA-256 digest first, so `timingSafeEqual` always sees
 * equal-length buffers and neither the length nor the content of the secret is
 * leaked through timing.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** Extract a bearer token from an Authorization header value. */
export function parseBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? (m[1] as string).trim() : null;
}

export class Router {
  private readonly maxBodyBytes: number;
  private readonly allowedHosts: Set<string>;
  private readonly allowedMethods: Set<string>;

  constructor(
    /** Resolve the per-project auth policy. Called only after route match. */
    private readonly policyFor: (project: ProjectId) => ProjectAuthPolicy | undefined,
    options: RouterOptions = {},
  ) {
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
    this.allowedHosts = new Set(
      (options.allowedHosts ?? []).map((h) => h.toLowerCase()),
    );
    this.allowedMethods = new Set(
      (options.allowedMethods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()),
    );
  }

  /** Parse a path into a Route, or null if it does not match a gateway route. */
  matchRoute(path: string): Route | null {
    const clean = path.split("?")[0] ?? path;
    const segments = clean.split("/").filter((s) => s.length > 0);
    // ["mcp","proxies",project,server]
    if (
      segments.length === 4 &&
      segments[0] === "mcp" &&
      segments[1] === "proxies" &&
      isSafeId(segments[2]) &&
      isSafeId(segments[3])
    ) {
      return {
        kind: "proxy",
        project: segments[2] as ProjectId,
        server: segments[3] as ServerId,
      };
    }
    // ["mcp","projects",project,"browser"]
    if (
      segments.length === 4 &&
      segments[0] === "mcp" &&
      segments[1] === "projects" &&
      isSafeId(segments[2]) &&
      segments[3] === "browser"
    ) {
      return { kind: "browser", project: segments[2] as ProjectId };
    }
    return null;
  }

  private validateHost(req: RouterRequest): RouteDenied | null {
    const host = firstHeader(req.headers["host"]);
    if (!host) {
      return { ok: false, status: 400, reason: "bad-host", message: "Missing Host header" };
    }
    if (this.allowedHosts.has(host.toLowerCase())) return null;
    const { host: hostname } = splitAuthority(host);
    if (!isLoopbackHost(hostname)) {
      return {
        ok: false,
        status: 403,
        reason: "bad-host",
        message: `Non-loopback Host rejected: ${host}`,
      };
    }
    return null;
  }

  private validateOrigin(req: RouterRequest): RouteDenied | null {
    const origin = firstHeader(req.headers["origin"]);
    if (origin === undefined) return null; // Non-browser clients omit Origin.
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return { ok: false, status: 403, reason: "bad-origin", message: "Malformed Origin" };
    }
    if (!isLoopbackHost(url.hostname)) {
      return {
        ok: false,
        status: 403,
        reason: "bad-origin",
        message: `Non-loopback Origin rejected: ${origin}`,
      };
    }
    return null;
  }

  private checkAuth(project: ProjectId, req: RouterRequest): RouteDenied | null {
    const policy = this.policyFor(project) ?? { authRequired: false };
    if (!policy.authRequired) return null; // Default: no auth.
    const expected = policy.expectedToken;
    const provided = parseBearer(firstHeader(req.headers["authorization"]));
    if (expected === undefined || provided === null || !constantTimeEquals(provided, expected)) {
      return {
        ok: false,
        status: 401,
        reason: "unauthorized",
        message: "Invalid or missing bearer token",
      };
    }
    return null;
  }

  /**
   * Evaluate a request end-to-end: match route, validate host/origin, enforce
   * body limit and method, then apply the project auth policy. Returns either
   * an allowed route or a structured denial with an HTTP status.
   */
  evaluate(req: RouterRequest): RouteResult {
    const route = this.matchRoute(req.path);
    if (!route) {
      return { ok: false, status: 404, reason: "not-found", message: "No matching route" };
    }
    if (!this.allowedMethods.has(req.method.toUpperCase())) {
      return {
        ok: false,
        status: 405,
        reason: "method-not-allowed",
        message: `Method ${req.method} not allowed`,
      };
    }
    const hostDenied = this.validateHost(req);
    if (hostDenied) return hostDenied;
    const originDenied = this.validateOrigin(req);
    if (originDenied) return originDenied;

    if (req.contentLength !== undefined && req.contentLength > this.maxBodyBytes) {
      return {
        ok: false,
        status: 413,
        reason: "body-too-large",
        message: `Body exceeds ${this.maxBodyBytes} bytes`,
      };
    }

    const authDenied = this.checkAuth(route.project, req);
    if (authDenied) return authDenied;

    return { ok: true, route };
  }

  get maxBody(): number {
    return this.maxBodyBytes;
  }
}
