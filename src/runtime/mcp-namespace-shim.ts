import type { MCPServer } from '@openai/agents';
import pino from 'pino';
import { decideToolApproval } from '../agents/tool-taxonomy.js';
import { beginToolEvent } from '../agents/tool-observability.js';
import { BoundaryError } from './boundary-error.js';
import { rateLimitedAlert } from './rate-limited-alert.js';
import { withTimeout } from './harness/brackets.js';

// Tighter client-side timeouts than the MCP SDK's default (~60s). Each
// server that's unreachable used to burn the full 60s before
// surfacing as a stub; on a daemon with 5 dead servers that's a
// noticeable boot stall. With 5s/8s, a dead server fast-fails into the
// backoff loop and stops being probed until its nextRetryAt elapses.
const MCP_LIST_TOOLS_TIMEOUT_MS = 5_000;
const MCP_CONNECT_TIMEOUT_MS = 8_000;

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

  // Track per-server connection state. The OpenAI Agents SDK's
  // MCPServerStdio.connect() unconditionally spawns a fresh child
  // process every call (overwriting the previous transport without
  // closing it). Repeated shim.connect() calls — which happen once per
  // OpenAI Runner run and once per Codex tool-defs build — would
  // otherwise leak N child processes per call. Guarding with a per-
  // server "in flight" promise dedupes concurrent callers too.
  const connectPromises = new WeakMap<MCPServer, Promise<void>>();

  // T2.3 — per-server health tracking. The previous implementation
  // dropped failed servers' tools silently from the model's surface,
  // so a connect error looked exactly like "this server was never
  // installed." With health tracking + a stub `<slug>__unavailable`
  // tool, the model SEES the failure in its tool catalog and can
  // tell the user "DataForSEO is offline" instead of pretending the
  // tool never existed.
  interface ServerHealth {
    state: 'connected' | 'degraded' | 'unavailable';
    lastError?: Error;
    failureCount: number;
    nextRetryAt: number; // epoch ms; 0 = retry now
    reconnectBackoffMs: number;
  }
  const serverHealth = new Map<MCPServer, ServerHealth>();
  // Bounded exponential backoff: 1s → 5s → 30s → 5min, capped.
  const BACKOFF_LADDER_MS = [1_000, 5_000, 30_000, 300_000];
  const MAX_BACKOFF_MS = 5 * 60 * 1000;

  function recordHealth(
    server: MCPServer,
    update: Partial<ServerHealth> & { state: ServerHealth['state'] },
  ): ServerHealth {
    const existing = serverHealth.get(server) ?? {
      state: 'connected' as const,
      failureCount: 0,
      nextRetryAt: 0,
      reconnectBackoffMs: BACKOFF_LADDER_MS[0],
    };
    const next: ServerHealth = { ...existing, ...update };
    serverHealth.set(server, next);
    return next;
  }

  function markServerFailed(server: MCPServer, err: unknown): ServerHealth {
    const existing = serverHealth.get(server) ?? {
      state: 'connected' as const,
      failureCount: 0,
      nextRetryAt: 0,
      reconnectBackoffMs: BACKOFF_LADDER_MS[0],
    };
    const failureCount = existing.failureCount + 1;
    const backoff = BACKOFF_LADDER_MS[Math.min(failureCount - 1, BACKOFF_LADDER_MS.length - 1)] ?? MAX_BACKOFF_MS;
    const errorObj = err instanceof Error ? err : new Error(String(err));
    const next: ServerHealth = {
      state: failureCount >= 3 ? 'unavailable' : 'degraded',
      lastError: errorObj,
      failureCount,
      nextRetryAt: Date.now() + backoff,
      reconnectBackoffMs: backoff,
    };
    serverHealth.set(server, next);

    // Fire ONE user notification per server-down event (rate-limited
    // to 10 min). Without this, a flapping server spams the log; with
    // it the user gets one actionable message and the rest aggregate.
    if (next.state === 'unavailable') {
      const slug = serverSlugs.get(server) ?? server.name;
      rateLimitedAlert(`mcp-server-down-${slug}`, {
        title: `MCP server "${server.name}" is unavailable`,
        body:
          `${server.name} failed to connect ${failureCount} times in a row. ` +
          `Last error: ${errorObj.message.slice(0, 200)}. ` +
          `Reconnect from Settings → MCP Servers or check the server's config.`,
        kind: 'system',
        metadata: { slug, failureCount, lastError: errorObj.message },
      }).catch(() => { /* alert is best-effort */ });
    }
    return next;
  }

  function markServerConnected(server: MCPServer): void {
    serverHealth.set(server, {
      state: 'connected',
      failureCount: 0,
      nextRetryAt: 0,
      reconnectBackoffMs: BACKOFF_LADDER_MS[0],
    });
  }

  function isServerInBackoffWindow(server: MCPServer): boolean {
    const h = serverHealth.get(server);
    return !!h && h.nextRetryAt > Date.now() && h.state !== 'connected';
  }

  async function ensureConnected(server: MCPServer): Promise<void> {
    if (typeof server.connect !== 'function') return;
    // Backoff guard — if we just tried and failed, don't immediately
    // retry; let the next listTools call after nextRetryAt elapses
    // re-attempt. The previous impl deleted connectPromises on error
    // so every subsequent caller would retry from scratch with no
    // pacing; one downed server could trigger 100 reconnects/sec.
    if (isServerInBackoffWindow(server)) {
      const h = serverHealth.get(server)!;
      throw h.lastError ?? new Error('server in backoff window');
    }
    const existing = connectPromises.get(server);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      try {
        await withTimeout(server.connect!(), MCP_CONNECT_TIMEOUT_MS, `mcp.connect[${server.name}]`);
        markServerConnected(server);
      } catch (err) {
        // Clear so a future call can retry instead of resolving instantly.
        connectPromises.delete(server);
        markServerFailed(server, err);
        throw err;
      }
    })();
    connectPromises.set(server, promise);
    await promise;
  }

  /**
   * T2.3 — synthetic stub tool for a server that's currently
   * unavailable. The model sees it, so a request that would have gone
   * to that server now gets a clear "server down" tool output it can
   * verbalize to the user, instead of the previous behavior where the
   * tool simply disappeared from the catalog.
   *
   * The stub's name is intentionally invalid as a real tool call —
   * starts with `<slug>__` so the routing map can match it to the
   * downed server and emit the BoundaryError.
   */
  function buildUnavailableStubTool(server: MCPServer, slug: string, health: ServerHealth): MCPTool {
    const lastErr = health.lastError?.message ?? 'unknown error';
    return {
      name: namespaceToolName(slug, 'unavailable'),
      description:
        `[${slug}] UNAVAILABLE — ${server.name} failed to connect ` +
        `(${health.failureCount} consecutive failures: ${lastErr.slice(0, 160)}). ` +
        `Tools from this server are temporarily unavailable. ` +
        `If you need a capability from this server, tell the user the data source is offline ` +
        `and propose an alternative or ask them to reconnect via Settings → MCP Servers.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    } as unknown as MCPTool;
  }

  /** Flatten + rename every underlying server's tools. */
  async function buildFlattenedTools(): Promise<{ tools: MCPTool[]; routing: Map<string, MCPServer> }> {
    const tools: MCPTool[] = [];
    const routing = new Map<string, MCPServer>(); // namespaced name -> underlying server

    // Connect + list per server in parallel. If one fails, log and continue.
    const results = await Promise.allSettled(
      servers.map(async (server) => {
        const slug = serverSlugs.get(server)!;
        try {
          await ensureConnected(server);
          const list = await withTimeout(
            server.listTools(),
            MCP_LIST_TOOLS_TIMEOUT_MS,
            `mcp.listTools[${server.name}]`,
          );
          markServerConnected(server);
          return { server, slug, list, status: 'ok' as const };
        } catch (err) {
          logger.warn({ server: server.name, err: err instanceof Error ? err.message : String(err) }, 'MCP server listTools failed; surfacing as unavailable stub');
          markServerFailed(server, err);
          return { server, slug, list: [] as MCPTool[], status: 'failed' as const };
        }
      }),
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { server, slug, list, status } = result.value;
      if (status === 'failed') {
        // T2.3 — emit the unavailable stub instead of silently dropping
        // the server's tools. The model can read its description and
        // SEE that this server is offline.
        const health = serverHealth.get(server);
        if (health) {
          const stub = buildUnavailableStubTool(server, slug, health);
          tools.push(stub);
          routing.set(stub.name, server);
        }
        continue;
      }
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
      // Eager connect for the easy servers so first listTools() is
      // faster. Each call is deduped via `ensureConnected` — repeated
      // shim.connect() calls don't respawn child processes.
      await Promise.allSettled(
        servers.map(async (server) => {
          try {
            await ensureConnected(server);
          } catch (err) {
            logger.warn({ server: server.name, err: err instanceof Error ? err.message : String(err) }, 'MCP server connect failed; will retry on first use');
          }
        }),
      );
    },

    async close() {
      await Promise.allSettled(
        servers.map(async (server) => {
          // Drop the connect record so a subsequent connect() on this
          // shim spawns a fresh child for any server we close here.
          connectPromises.delete(server);
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
      // T2.3 — if the model called the synthetic "<slug>__unavailable"
      // stub or any tool on a known-unavailable server, throw a
      // structured BoundaryError instead of dispatching. The runtime
      // catches and feeds it back as tool output so the model's next
      // turn explains "Server X is offline" to the user.
      if (parsed.toolName === 'unavailable' || serverHealth.get(server)?.state === 'unavailable') {
        const slug = parsed.serverSlug;
        const health = serverHealth.get(server);
        throw new BoundaryError({
          kind: 'mcp.server_unavailable',
          retryable: true,
          userMessage:
            `${server.name} is offline (${health?.failureCount ?? '?'} consecutive failures: ` +
            `${health?.lastError?.message?.slice(0, 160) ?? 'unknown error'}). ` +
            `Reconnect via Settings → MCP Servers or use an alternative source.`,
          operatorMessage: `mcp.server_unavailable slug=${slug} failureCount=${health?.failureCount ?? 'n/a'}`,
          context: {
            slug,
            toolName,
            originalToolName: parsed.toolName,
            failureCount: health?.failureCount,
            lastError: health?.lastError?.message,
          },
        });
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
        // T2.5 — Throw a structured BoundaryError instead of a bare
        // Error. The Codex runtime's MCP catch path used to receive a
        // plain Error and stringify it into the tool's output; the
        // model then read "Approval required to call X" as a tool
        // result and either gave up or tried something different —
        // never triggering the real PendingApproval flow. With the
        // structured error, the runtime can detect the kind and
        // create an actual approval (mirroring the local-tool path)
        // so the user sees the apr-xxxx prompt and can resolve it.
        throw new BoundaryError({
          kind: 'mcp.approval_blocked',
          retryable: false,
          userMessage:
            `Approval required to call \`${toolName}\` ` +
            `(${decision.kind} action: ${decision.reason}). ` +
            `Reply \`approve\` to proceed.`,
          operatorMessage:
            `mcp.approval_blocked tool=${toolName} kind=${decision.kind} reason=${decision.reason}`,
          context: {
            toolName,
            originalToolName: parsed.toolName,
            slug: parsed.serverSlug,
            kind: decision.kind,
            reason: decision.reason,
            args,
          },
        });
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
