/**
 * Profile-bound browser MCP server.
 *
 * A project may bind exactly one browser profile. Its `/mcp/projects/:project/
 * browser` endpoint exposes the SAME page-drive tools the global MCP server
 * offers (navigate, click, type, extract, screenshot, evaluate_js, waits, tab
 * ops, cookies) — but SCOPED to the bound profile:
 *
 *   - The `profile_id` parameter is REMOVED from every advertised tool schema.
 *     Callers on this endpoint neither see nor supply it; the bound id is
 *     injected by the server before the call reaches the real tool body.
 *   - Profile-library tools are BLOCKED entirely: list_profiles,
 *     create_profile, update_profile, delete_profile, list_fingerprint_options,
 *     launch_profile, close_profile. A project-scoped client can never
 *     enumerate, create, mutate, delete, or lifecycle profiles, nor learn that
 *     other profiles exist.
 *   - Any attempt to smuggle a `profile_id` (or other cross-profile field) in
 *     the arguments is rejected before the injected id is applied.
 *
 * Implementation: the real, security-gated global tool dispatch
 * (`createMultizenMcpServer`) is connected to an in-process
 * {@link InMemoryTransport} pair and driven by a private {@link Client}. The
 * public bound {@link Server} filters/rewrites tool metadata and calls, then
 * forwards to that client. This keeps ONE source of truth for tool behaviour —
 * URL-scheme gates, CDP denylist, cookie scoping, activity logging — while the
 * bound id injection and profile-library blocking happen strictly at the
 * boundary.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ProfileManager } from "@multizen/profile-manager";
import {
  createMultizenMcpServer,
  type ActivityLog,
  type BrowserDriver,
  type MultizenMcpServerOptions,
} from "@multizen/mcp-server";

/**
 * Page-drive tools exposed on a project-bound browser endpoint. Every one takes
 * a `profile_id` in the global surface; here it is injected and stripped from
 * the advertised schema. Profile-library / lifecycle tools are intentionally
 * absent so a bound client cannot enumerate or manage the library.
 */
export const BOUND_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "navigate",
  "click",
  "type",
  "extract",
  "screenshot",
  "evaluate_js",
  "wait_for_selector",
  "wait_for_navigation",
  "wait_for_load",
  "list_tabs",
  "activate_tab",
  "close_tab",
  "get_cookies",
  "set_cookies",
  "new_tab",
  // cdp_send stays opt-in via MULTIZEN_MCP_ALLOW_RAW_CDP even here; when the
  // global surface hides it, it is absent from this list too.
  "cdp_send",
]);

/**
 * Fields a bound caller must never set — they would break single-profile
 * isolation. `profile_id` is injected by us; a client-supplied one is rejected.
 */
const FORBIDDEN_ARG_KEYS: ReadonlySet<string> = new Set<string>(["profile_id"]);

export interface ProfileBoundServerOptions {
  readonly profileManager: ProfileManager;
  readonly browserDriver: BrowserDriver;
  /** The single profile id every tool call is pinned to. */
  readonly boundProfileId: string;
  /** Optional shared activity log so bound calls stream into the app feed. */
  readonly activityLog?: ActivityLog;
  /** Optional lifecycle hooks (e.g. sync beforeLaunch) — reused verbatim. */
  readonly profileLifecycle?: MultizenMcpServerOptions["profileLifecycle"];
}

export interface ProfileBoundServer {
  readonly server: Server;
  readonly boundProfileId: string;
  /** Tear down the internal client + linked global server. */
  close(): Promise<void>;
}

/**
 * Strip the `profile_id` property from a tool's advertised JSON input schema and
 * drop it from `required`, so a bound client never sees or supplies it.
 */
function stripProfileId(tool: Tool): Tool {
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  if (!schema) return tool;
  const props = schema.properties;
  const nextProps =
    typeof props === "object" && props !== null
      ? Object.fromEntries(
          Object.entries(props as Record<string, unknown>).filter(([k]) => k !== "profile_id"),
        )
      : props;
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((r) => r !== "profile_id")
    : schema.required;
  return {
    ...tool,
    inputSchema: {
      ...schema,
      ...(nextProps !== undefined ? { properties: nextProps } : {}),
      ...(required !== undefined ? { required } : {}),
    } as Tool["inputSchema"],
  };
}

/**
 * Build a project-bound browser MCP server. It advertises only the page-drive
 * tools (profile_id stripped) and injects the bound profile id on every call,
 * delegating to the shared, security-gated global dispatch for the actual work.
 *
 * `connect()` must be awaited before the returned server handles requests; the
 * exported factory does this and resolves once both ends are live.
 */
export async function createProfileBoundServer(
  opts: ProfileBoundServerOptions,
): Promise<ProfileBoundServer> {
  const { profileManager, browserDriver, boundProfileId } = opts;

  // The canonical, security-gated global server. Its dispatch is the single
  // source of truth for every tool body.
  const global = createMultizenMcpServer({
    profileManager,
    browserDriver,
    ...(opts.activityLog !== undefined ? { activityLog: opts.activityLog } : {}),
    ...(opts.profileLifecycle !== undefined ? { profileLifecycle: opts.profileLifecycle } : {}),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "multizen-bound-proxy", version: "0.3.0-pre" });
  await Promise.all([
    global.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const server = new Server(
    { name: "multizen-project-browser", version: "0.3.0-pre" },
    {
      capabilities: { tools: {} },
      instructions:
        "This endpoint drives ONE browser profile bound to this project. Page tools " +
        "(navigate/click/type/extract/screenshot/…) take no profile_id — it is fixed. " +
        "Profile management (list/create/update/delete/launch/close) is not available here.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await client.listTools();
    const tools = listed.tools
      .filter((t) => BOUND_TOOL_NAMES.has(t.name))
      .map(stripProfileId);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    if (!BOUND_TOOL_NAMES.has(name)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "FORBIDDEN",
                message: `Tool ${name} is not available on a project-bound browser endpoint`,
              },
            }),
          },
        ],
      };
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (FORBIDDEN_ARG_KEYS.has(key)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "FORBIDDEN",
                  message: `Argument "${key}" is not allowed on a project-bound endpoint`,
                },
              }),
            },
          ],
        };
      }
    }
    // Inject the bound profile id AFTER the forbidden-key check so a client can
    // never override it.
    const injected = { ...args, profile_id: boundProfileId };
    const result = await client.callTool({ name, arguments: injected });
    return result as CallToolResult;
  });

  return {
    server,
    boundProfileId,
    close: async (): Promise<void> => {
      await client.close().catch(() => {});
      await global.server.close().catch(() => {});
    },
  };
}
