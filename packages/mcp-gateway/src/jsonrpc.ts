/**
 * Minimal JSON-RPC 2.0 message model and a transport interface that is
 * structurally compatible with the MCP SDK's `Transport` (start/close/send plus
 * onmessage/onerror/onclose callbacks). Keeping our own thin types lets the
 * relay and session manager operate on raw JSON-RPC — preserving params,
 * results, errors, cursors, structured content, annotations, and `_meta`
 * verbatim — while still accepting the SDK's real transports at the edges.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m && m.id !== null && m.id !== undefined;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !("method" in m) && "id" in m;
}

export function isError(m: JsonRpcMessage): m is JsonRpcError {
  return isResponse(m) && "error" in m;
}

/**
 * Transport contract. Deliberately matches the shape of the MCP SDK Transport
 * so the real StdioClientTransport / StreamableHTTPClientTransport can be used
 * directly, and fakes can stand in for deterministic tests.
 */
export interface GatewayTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  send(message: JsonRpcMessage, options?: { relatedRequestId?: JsonRpcId }): Promise<void>;
  onmessage?: (message: JsonRpcMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  /** Optional session id assigned by a streamable-http transport. */
  sessionId?: string;
}

/** Standard JSON-RPC error codes used by the relay. */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** MCP-specific error codes. */
export const MCP_ERROR = {
  /** No eligible downstream client to route a server-initiated request to. */
  NO_ELIGIBLE_CLIENT: -32010,
  /** Request cancelled. */
  REQUEST_CANCELLED: -32001,
} as const;
