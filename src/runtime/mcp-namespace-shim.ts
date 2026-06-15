import type { MCPServer } from '@openai/agents';
import pino from 'pino';
import { decideToolApproval } from '../agents/tool-taxonomy.js';
import { beginToolEvent } from '../agents/tool-observability.js';
import { BoundaryError } from './boundary-error.js';
import { rateLimitedAlert } from './rate-limited-alert.js';
import { withTimeout, harnessRunContextStorage } from './harness/brackets.js';
import { appendFanoutAdvisory } from './harness/fanout-advisory.js';
import {
  isGroundingGateEnabled,
  evaluateGrounding,
  detectDuplicateTarget,
  extractDuplicateIdentityKeys,
  markDuplicateWarned,
  GroundingCheckFailedError,
  DuplicateExternalWriteError,
} from './harness/grounding-gate.js';
import { appendEvent, listEvents } from './harness/eventlog.js';
import { classifyShellNetworkMutation } from './harness/destination-gate.js';
import { formatRecallableToolText } from './harness/tool-output-format.js';

// Bound MCP startup below the SDK's default (~60s), but leave enough
// room for `npx`/`uvx` based servers on fresh machines. 5s/8s was too
// aggressive: DataForSEO would print "running on stdio" just after
// Clementine had already marked it unavailable.
function positiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MCP_LIST_TOOLS_TIMEOUT_MS = positiveIntEnv('MCP_LIST_TOOLS_TIMEOUT_MS', 20_000);
const MCP_CONNECT_TIMEOUT_MS = positiveIntEnv('MCP_CONNECT_TIMEOUT_MS', 30_000);
const MCP_EAGER_CONNECT_BLOCKING =
  /^(1|true|on|yes)$/i.test(process.env.MCP_EAGER_CONNECT_BLOCKING ?? '');

type MCPTool = Awaited<ReturnType<MCPServer['listTools']>>[number];
type CallToolResultContent = Awaited<ReturnType<MCPServer['callTool']>>;

// Audit #6: an MCP EXECUTE/write tool can perform a network mutation through its
// args — kernel `exec_command({command:'curl', args:['-X','POST',…]})` or
// `browser_curl({method:'POST', url, body})`. These classify as execute/write,
// NOT send, so the send-grounding path misses them. Detect the arg shape so they
// get the same grounding as a send. Reuses the shell network-mutation classifier.
function detectMcpArgsNetworkMutation(
  args: Record<string, unknown> | null,
): { isNetworkMutation: boolean; shapeKey?: string } {
  if (!args || typeof args !== 'object') return { isNetworkMutation: false };
  // `command` + `args[]` shape (kernel exec_command and generic command runners).
  const command = typeof args.command === 'string' ? args.command : '';
  if (command) {
    const argv = Array.isArray(args.args) ? (args.args as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    const m = classifyShellNetworkMutation(`${command} ${argv.join(' ')}`);
    if (m.isNetworkMutation) return { isNetworkMutation: true, shapeKey: m.shapeKey };
  }
  // Structured HTTP-request shape (browser_curl and HTTP-client MCP tools).
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : '';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && (typeof args.url === 'string' || 'body' in args)) {
    return { isNetworkMutation: true, shapeKey: 'mcp:http_mutation' };
  }
  return { isNetworkMutation: false };
}

// Append the global fan-out advisory to a native MCP result when the model is
// looping the same tool serially for N>=3 distinct items in one turn. This is
// the ONLY place native MCP calls (dataforseo__*/firecrawl__* — the read-heavy
// path in the sess-mpxpl2l9 incident) are observable: they go through this shim,
// NOT through wrapToolForHarness, so without this hook they get no behavioral
// fan-out trigger. sessionId comes from the harness run context, which the loop
// installs around every turn regardless of HARNESS_TOOL_BRACKETS. Best-effort:
// never alters the result on any error.
// Native MCP calls bypass wrapToolForHarness, so their RAW results landed
// uncapped in chat history (context blowup in long, tool-heavy sessions). Route
// them through the SAME formatRecallableToolText primitive every other tool uses:
// large outputs are parked in tool_outputs (recoverable via recall_tool_result)
// and replaced with a structure-aware digest; small ones pass through unchanged.
// Native MCP calls have no SDK callId at this layer, so synthesize a stable one.
let mcpRecallSeq = 0;
function clipMcpResultForRecall(toolName: string, result: CallToolResultContent): CallToolResultContent {
  try {
    const sessionId = harnessRunContextStorage.getStore()?.sessionId;
    if (!sessionId || !Array.isArray(result)) return result;
    const combined = result
      .map((block) => {
        const text = (block as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
    if (!combined) return result;
    mcpRecallSeq += 1;
    const callId = `mcp_${toolName}_${mcpRecallSeq}`;
    const clipped = formatRecallableToolText(combined, { sessionId, callId, toolName });
    if (clipped === combined) return result; // under the cap → byte-identical, no-op
    // Replace the (possibly multi-block) text with one clipped block; preserve any
    // non-text blocks (images, resource refs) untouched.
    const nonText = result.filter((block) => (block as { type?: string } | null)?.type !== 'text');
    return [{ type: 'text', text: clipped }, ...nonText] as CallToolResultContent;
  } catch {
    return result; // clipping must NEVER break a tool call
  }
}

function appendMcpFanoutAdvisory(
  toolName: string,
  args: Record<string, unknown> | null,
  result: CallToolResultContent,
): CallToolResultContent {
  try {
    const sessionId = harnessRunContextStorage.getStore()?.sessionId;
    if (!sessionId || !Array.isArray(result)) return result;
    const resultText = result
      .map((block) => {
        const text = (block as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
    const advisory = appendFanoutAdvisory({ toolName, args: args ?? {}, sessionId, resultText });
    if (!advisory) return result;
    return [...result, { type: 'text', text: advisory }];
  } catch {
    return result; // a nudge must never break a tool call
  }
}

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
/**
 * Lightweight, serializable MCP server status used by the dashboard's
 * header pill + the /api/console/mcp/health endpoint. The slug is the
 * stable identifier the UI displays. Tool count is reported on the
 * latest successful listTools; `pending` means the shim has issued
 * connect but neither connect nor failure has resolved yet.
 */
export interface MCPServerHealthSnapshot {
  slug: string;
  name: string;
  state: 'connected' | 'connecting' | 'degraded' | 'unavailable';
  toolCount: number;
  failureCount: number;
  lastError?: string;
  nextRetryAt?: number;
}

// Module-level registry of all active shims' per-server health, keyed
// by slug. Multiple shims can register into the same registry (today
// there's only one shim — the global namespace shim — but the registry
// is shim-agnostic so /api/console/mcp/health doesn't need to know
// which shim each server belongs to). Cleared on shim close().
const HEALTH_REGISTRY = new Map<string, MCPServerHealthSnapshot>();

/** Read-only snapshot of all MCP server health. Sorted by slug for
 *  stable rendering. */
export function listMcpServerHealth(): MCPServerHealthSnapshot[] {
  return Array.from(HEALTH_REGISTRY.values())
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

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
    // Seed registry with a "connecting" snapshot so the dashboard
    // immediately shows what servers exist even before any connect
    // attempt has resolved. Updated by syncHealthRegistry on transitions.
    HEALTH_REGISTRY.set(slug, {
      slug,
      name: server.name,
      state: 'connecting',
      toolCount: 0,
      failureCount: 0,
    });
  }

  let cachedTools: MCPTool[] | null = null;
  let cachedToolToServer: Map<string, MCPServer> | null = null;

  // Snapshot used by the dashboard's MCP status pill — last known
  // health of each underlying server, keyed by slug (the stable string
  // the UI displays). Updated synchronously inside markServerConnected
  // / markServerFailed so the dashboard sees a fresh value on every
  // /api/console/mcp/health poll. Module-scoped (not per-shim) so the
  // dashboard route doesn't need a reference to the shim instance.
  // KEY: slug. VALUE: lightweight serializable status.

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
    // Clear the (possibly resolved) connect promise so the NEXT attempt after
    // the backoff window actually re-runs server.connect() and respawns the
    // child. Without this, a server that connected once and whose transport
    // later died (detected in listTools/callTool, not in connect) keeps the
    // stale resolved promise forever — ensureConnected short-circuits with
    // `await existing; return`, so it never truly reconnects ("keeps
    // disconnecting"), and syncHealthRegistry reads connectPromises.has() as
    // still-inflight and reports a permanent "connecting…". The connect-path
    // catch already deletes this; doing it here covers the transport-death path
    // too, making the fix general for every way a server can fail.
    connectPromises.delete(server);
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
        silent: true,
        metadata: { slug, failureCount, lastError: errorObj.message },
      }).catch(() => { /* alert is best-effort */ });
    }
    syncHealthRegistry(server);
    return next;
  }

  function markServerConnected(server: MCPServer): void {
    serverHealth.set(server, {
      state: 'connected',
      failureCount: 0,
      nextRetryAt: 0,
      reconnectBackoffMs: BACKOFF_LADDER_MS[0],
    });
    syncHealthRegistry(server);
  }

  /** Mirror the in-shim ServerHealth into the module-level registry
   *  the dashboard reads from. Called from every state transition so
   *  /api/console/mcp/health is always fresh. `lastToolCount` is read
   *  off the most recent successful listTools (cachedTools length for
   *  THIS server). */
  function syncHealthRegistry(server: MCPServer): void {
    const slug = serverSlugs.get(server);
    if (!slug) return;
    const health = serverHealth.get(server);
    const inflight = connectPromises.has(server);
    let state: MCPServerHealthSnapshot['state'];
    if (!health) {
      state = inflight ? 'connecting' : 'connecting'; // unconnected yet
    } else if (health.state === 'connected') {
      state = 'connected';
    } else if (inflight) {
      state = 'connecting';
    } else if (health.state === 'unavailable') {
      state = 'unavailable';
    } else {
      state = 'degraded';
    }
    let toolCount = 0;
    if (cachedTools) {
      const prefix = `${slug}${SEPARATOR}`;
      toolCount = cachedTools.filter((t) => t.name.startsWith(prefix) && !t.name.endsWith(`${SEPARATOR}unavailable`)).length;
    }
    HEALTH_REGISTRY.set(slug, {
      slug,
      name: server.name,
      state,
      toolCount,
      failureCount: health?.failureCount ?? 0,
      lastError: health?.lastError?.message,
      nextRetryAt: health?.nextRetryAt && health.nextRetryAt > Date.now() ? health.nextRetryAt : undefined,
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
      // faster. By default this is deliberately non-blocking: a dead
      // local MCP server should not make daemon startup look hung.
      // listTools() still awaits connection when a run actually needs
      // tool definitions. Set MCP_EAGER_CONNECT_BLOCKING=true for old
      // blocking behavior in diagnostics.
      const tasks = servers.map(async (server) => {
        try {
          await ensureConnected(server);
        } catch (err) {
          logger.warn({ server: server.name, err: err instanceof Error ? err.message : String(err) }, 'MCP server connect failed; will retry on first use');
        }
      });
      if (MCP_EAGER_CONNECT_BLOCKING) {
        await Promise.allSettled(tasks);
      } else {
        for (const task of tasks) task.catch(() => { /* logged above */ });
      }
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

      // Integrity gates for irreversible MCP SENDS (blind-spot audit #1).
      // Native MCP tools bypass wrapToolForHarness, so a Gmail/Slack/etc. send
      // never got the grounding + duplicate-target protection that composio
      // sends get — a corrupted/wrong-target send (the Eley/mailbox incident
      // class) or a silent double-send sailed straight through. Run the SAME
      // gates here for send-kind tools, reusing the same fail-open functions.
      // Blocks surface as soft tool errors the model recovers from. The
      // external_write ledger (emitted on success below) is SHARED with the
      // composio path so duplicate detection spans both surfaces.
      const integritySessionId = harnessRunContextStorage.getStore()?.sessionId;
      // Gate as a send when the tool is send-kind (audit #1) OR its args describe
      // a network mutation (audit #6 — kernel exec_command/browser_curl etc.).
      const argMutation = detectMcpArgsNetworkMutation(args);
      const gateAsSend = decision.kind === 'send' || argMutation.isNetworkMutation;
      const integrityShapeKey = decision.kind === 'send' ? toolName : (argMutation.shapeKey ?? toolName);
      if (gateAsSend && isGroundingGateEnabled() && integritySessionId) {
        try {
          // Duplicate-target speed bump: a same-shape send to a target already
          // written this session bumps ONCE (approval is not idempotency).
          const dupTargets = extractDuplicateIdentityKeys(args ?? {});
          if (dupTargets.length > 0) {
            const priorWrites = listEvents(integritySessionId, { types: ['external_write'] })
              .map((ev) => ev.data as { shapeKey?: string; targets?: string[] });
            const failures = listEvents(integritySessionId, { types: ['external_write_failed'] })
              .map((ev) => ev.data as { shapeKey?: string; targets?: string[] });
            for (const failure of failures) {
              const failTargets = new Set((failure.targets ?? []).map((t) => String(t).toLowerCase()));
              const idx = priorWrites.findIndex((w) => w.shapeKey === failure.shapeKey
                && (w.targets ?? []).some((t) => failTargets.has(String(t).toLowerCase())));
              if (idx >= 0) priorWrites.splice(idx, 1);
            }
            const dup = detectDuplicateTarget({ sessionId: integritySessionId, shapeKey: integrityShapeKey, targets: dupTargets, priorWrites });
            if (dup.duplicate && dup.warnedKey) {
              markDuplicateWarned(dup.warnedKey);
              throw new DuplicateExternalWriteError({ toolName, shapeKey: integrityShapeKey, target: dup.target ?? 'unknown' });
            }
          }
          // Grounding: verify the outgoing payload against this target's own
          // session artifacts (fail-open on no-target / no-sources / judge error).
          const verdict = await evaluateGrounding(integritySessionId, toolName, args ?? {});
          if (verdict.action === 'block') {
            throw new GroundingCheckFailedError({
              toolName,
              reason: verdict.reason,
              targets: verdict.targets,
              sourceCallIds: verdict.sourceCallIds,
              failureCount: verdict.failureCount ?? 1,
            });
          }
        } catch (err) {
          if (err instanceof GroundingCheckFailedError || err instanceof DuplicateExternalWriteError) throw err;
          // Any other evaluation error is fail-open — never block a legit send.
        }
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
        const rawResult = await server.callTool(parsed.toolName, args);
        finish('success');
        // Cap + park a large raw result for recall BEFORE the fan-out nudge, so a
        // 200KB MCP dump can't flood the chat context window unrecoverably.
        const result = clipMcpResultForRecall(toolName, rawResult);
        // Record the irreversible send in the SHARED external_write ledger so a
        // later same-shape send (composio OR MCP) to the same target gets the
        // duplicate bump. Best-effort; telemetry must never affect the result.
        if (gateAsSend && integritySessionId) {
          try {
            appendEvent({
              sessionId: integritySessionId,
              turn: 0,
              role: 'system',
              type: 'external_write',
              data: {
                shapeKey: integrityShapeKey,
                toolName,
                irreversible: true,
                mcp: true,
                targets: extractDuplicateIdentityKeys(args ?? {}).slice(0, 8),
              },
            });
          } catch { /* telemetry write must never block */ }
        }
        // Global fan-out trigger: native MCP calls bypass wrapToolForHarness,
        // so this is where serial same-shape MCP work (N>=3 distinct items) gets
        // the run_worker advisory appended. Best-effort; no-op when not looping.
        return appendMcpFanoutAdvisory(toolName, args, result);
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
