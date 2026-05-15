import type { MCPServer } from '@openai/agents';
import pino from 'pino';
import { decideToolApproval } from '../agents/tool-taxonomy.js';
import { beginToolEvent } from '../agents/tool-observability.js';

type MCPTool = Awaited<ReturnType<MCPServer['listTools']>>[number];
type CallToolResultContent = Awaited<ReturnType<MCPServer['callTool']>>;

/**
 * MCP namespace shim — flattens N installed MCP servers into a single
 * synthetic MCPServer whose tools are renamed `<server>__<tool>`.
 *
 * Why this exists:
 *   The OpenAI Agents SDK throws `UserError("Duplicate tool names
 *   found across MCP servers: …")` from `mcp.js:300` when two
 *   installed servers expose a tool with the same name. With the
 *   built-in 7+ MCP servers a typical user has (filesystem, github,
 *   playwright, pinecone, ...) collisions like `search`, `list`,
 *   `read_file` are inevitable.
 *
 *   Wrapping all servers in this single shim:
 *     - Guarantees unique tool names (prefix by server slug).
 *     - Lets the Agent receive a single `mcpServers: [shim]` — the
 *       SDK never sees the underlying server list, so its duplicate-
 *       name check is never tripped.
 *     - Centralizes connect/close lifecycle.
 *     - Gives us a single point to add filtering (`toolFilter`),
 *       caching, telemetry, and per-tool `isEnabled` hooks later.
 *
 * Design notes:
 *   - Server slug uses lowercase letters, digits, dot, dash, underscore;
 *     other chars become `_`. The original server.name is preserved
 *     internally so dispatch by prefix is deterministic.
 *   - Separator is `__` (two underscores). MCP tool names don't
 *     conventionally use double-underscore, so collisions on the
 *     namespaced form are extremely unlikely. We still detect and
 *     warn if a server name itself would collide after slug
 *     normalisation.
 *   - `listTools()` flattens lazily on each call. Each underlying
 *     server's `cacheToolsList` behaviour is preserved — we just
 *     concatenate.
 *   - `callTool(name, args)` parses the prefix, looks up the server,
 *     forwards the call with the *original* tool name.
 *   - Connection failures on one server don't kill the shim. We log
 *     and continue — partial discovery beats full failure.
 */

const logger = pino({ name: 'clementine-next.mcp-namespace' });

const SEPARATOR = '__';

export interface MCPNamespaceShimOptions {
  /** Servers to wrap. Order doesn't matter for behaviour. */
  servers: MCPServer[];
  /** Public name exposed to the SDK as `shim.name`. Default: 'clemmy-mcp'. */
  name?: string;
  /** Cache the flattened tool list on the shim itself. Default: true. */
  cacheToolsList?: boolean;
}

/**
 * Normalize a server name into a tool-name-safe slug.
 * Examples: "Bright Data" -> "bright_data", "ElevenLabs" -> "elevenlabs"
 *           "dataforseo" -> "dataforseo", "hostinger-mcp" -> "hostinger-mcp"
 */
export function slugifyServerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  return slug || 'server';
}

export function namespaceToolName(serverSlug: string, toolName: string): string {
  return `${serverSlug}${SEPARATOR}${toolName}`;
}

export function parseNamespacedTool(namespaced: string): { serverSlug: string; toolName: string } | null {
  const idx = namespaced.indexOf(SEPARATOR);
  if (idx <= 0) return null;
  const serverSlug = namespaced.slice(0, idx);
  const toolName = namespaced.slice(idx + SEPARATOR.length);
  if (!serverSlug || !toolName) return null;
  return { serverSlug, toolName };
}

/**
 * Construct a single `MCPServer`-shaped object that fronts all given
 * servers. Pass this to `new Agent({ mcpServers: [shim] })`.
 */
export function createMcpNamespaceShim(options: MCPNamespaceShimOptions): MCPServer {
  const { servers, name = 'clemmy-mcp', cacheToolsList = true } = options;

  // Index servers by their slugified name. Detect collisions on slug
  // (rare but possible: "Foo Bar" and "foo-bar" both → "foo_bar").
  // First-registration wins; subsequent collisions get a numeric suffix
  // so neither server is silently dropped.
  const slugToServer = new Map<string, MCPServer>();
  const serverSlugs = new Map<MCPServer, string>();
  for (const server of servers) {
    let slug = slugifyServerName(server.name);
    if (slugToServer.has(slug)) {
      let n = 2;
      while (slugToServer.has(`${slug}_${n}`)) n++;
      const newSlug = `${slug}_${n}`;
      logger.warn(
        { original: server.name, slug, resolvedSlug: newSlug },
        'MCP server slug collision — assigning suffixed slug',
      );
      slug = newSlug;
    }
    slugToServer.set(slug, server);
    serverSlugs.set(server, slug);
  }

  let cachedTools: MCPTool[] | null = null;
  let cachedToolToServer: Map<string, MCPServer> | null = null;

  /** Flatten + rename every underlying server's tools. */
  async function buildFlattenedTools(): Promise<{ tools: MCPTool[]; routing: Map<string, MCPServer> }> {
    const tools: MCPTool[] = [];
    const routing = new Map<string, MCPServer>(); // namespaced name -> underlying server

    // Connect + list per server in parallel. If one fails, log and continue.
    const results = await Promise.allSettled(
      servers.map(async (server) => {
        const slug = serverSlugs.get(server)!;
        try {
          // Most SDK servers connect lazily; calling connect() is idempotent
          // and safe. Catch + log so one broken server doesn't poison the rest.
          if (typeof server.connect === 'function') {
            await server.connect();
          }
          const list = await server.listTools();
          return { server, slug, list };
        } catch (err) {
          logger.warn({ server: server.name, err: err instanceof Error ? err.message : String(err) }, 'MCP server listTools failed; skipping its tools');
          return { server, slug, list: [] as MCPTool[] };
        }
      }),
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { server, slug, list } = result.value;
      for (const tool of list) {
        const namespaced = namespaceToolName(slug, tool.name);
        if (routing.has(namespaced)) {
          // Astronomically unlikely after slug resolution, but defensive.
          logger.warn({ namespaced, server: server.name }, 'duplicate namespaced tool after flatten — skipping');
          continue;
        }
        // Re-emit the MCPTool with the namespaced name. Description and
        // inputSchema are preserved verbatim — the SDK passes those
        // straight to the model, which is exactly what we want.
        tools.push({
          ...tool,
          name: namespaced,
          description: tool.description
            ? `[${slug}] ${tool.description}`
            : `[${slug}] tool from ${server.name}`,
        });
        routing.set(namespaced, server);
      }
    }

    return { tools, routing };
  }

  const shim: MCPServer = {
    cacheToolsList,
    // `toolFilter` is intentionally unset — filtering is the right
    // place for `isEnabled`-style per-turn pruning, but that's Move 3.
    toolFilter: undefined,
    get name() {
      return name;
    },

    async connect() {
      // Lazy connect happens during buildFlattenedTools() so a slow
      // server doesn't block the shim's own readiness. Eagerly connect
      // the easy ones up front so first listTools() is faster.
      await Promise.allSettled(
        servers.map(async (server) => {
          if (typeof server.connect !== 'function') return;
          try {
            await server.connect();
          } catch (err) {
            logger.warn({ server: server.name, err: err instanceof Error ? err.message : String(err) }, 'MCP server connect failed; will retry on first use');
          }
        }),
      );
    },

    async close() {
      await Promise.allSettled(
        servers.map(async (server) => {
          if (typeof server.close !== 'function') return;
          try {
            await server.close();
          } catch {
            // Best-effort cleanup; never throw from close.
          }
        }),
      );
      cachedTools = null;
      cachedToolToServer = null;
    },

    async listTools(): Promise<MCPTool[]> {
      if (cacheToolsList && cachedTools && cachedToolToServer) {
        return cachedTools;
      }
      const { tools, routing } = await buildFlattenedTools();
      if (cacheToolsList) {
        cachedTools = tools;
        cachedToolToServer = routing;
      } else {
        // We still need the routing map for the immediately-following
        // callTool, so cache transiently — invalidated on next listTools.
        cachedTools = null;
        cachedToolToServer = routing;
      }
      return tools;
    },

    async callTool(toolName: string, args: Record<string, unknown> | null): Promise<CallToolResultContent> {
      // Ensure we have a routing map. The SDK always calls listTools()
      // before callTool() on a given run, but be defensive.
      if (!cachedToolToServer) {
        await this.listTools();
      }
      const server = cachedToolToServer?.get(toolName);
      if (!server) {
        // The tool name didn't resolve. Either the model invented one,
        // or the cache is stale and the underlying tool has been
        // removed. Surface a real error so the model's next turn
        // sees what actually failed.
        throw new Error(
          `Unknown MCP tool: "${toolName}". Available tools come from the namespaced shim with names like "<server>__<tool>".`,
        );
      }
      const parsed = parseNamespacedTool(toolName);
      if (!parsed) {
        throw new Error(`Malformed namespaced tool name: "${toolName}".`);
      }

      // Apply the unified approval taxonomy to MCP calls invoked
      // through the SDK Runner path. The Codex runtime gates approval
      // before dispatching here (it has the sessionId + approval-store
      // and can pause the run), so this branch is the safety net for
      // the OpenAI runtime path which goes directly into the SDK. The
      // hard `assertCommandAllowed`-style denylist for arbitrary shell
      // commands does NOT apply at the MCP level — MCP servers don't
      // expose `run_shell_command` — but `admin` and `destructive`
      // tools still must not run silently. We throw a structured
      // error so the model's next turn sees an explicit "needs
      // approval" rather than silent execution.
      const decision = decideToolApproval({ toolName, args });
      if (decision.needsApproval) {
        throw new Error(
          `Approval required to call ${toolName} (kind=${decision.kind}, reason=${decision.reason}). The trust gradient is set so this kind of action must be approved before running. Either ask the user to approve, or upgrade the scope policy.`,
        );
      }

      const finish = beginToolEvent({
        toolName,
        kind: decision.kind,
        approvalReason: decision.reason,
        args,
        mcp: true,
      });
      try {
        // Forward to the underlying server with the ORIGINAL tool name.
        const result = await server.callTool(parsed.toolName, args);
        finish('success');
        return result;
      } catch (err) {
        finish('error', err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    async invalidateToolsCache() {
      cachedTools = null;
      cachedToolToServer = null;
      await Promise.allSettled(
        servers.map((server) => {
          if (typeof server.invalidateToolsCache !== 'function') return;
          return server.invalidateToolsCache().catch(() => undefined);
        }),
      );
    },
  };

  return shim;
}
