import path from 'node:path';
import { existsSync } from 'node:fs';
import { MCPServerSSE, MCPServerStdio, MCPServerStreamableHttp, type MCPServer } from '@openai/agents';
import { BASE_DIR, LOCAL_MCP_ENABLED, PKG_DIR } from '../config.js';
import { discoverMcpServers } from './mcp-config.js';
import { mergedSpawnEnv } from './spawn-env.js';
import { createMcpNamespaceShim } from './mcp-namespace-shim.js';
import { filterMcpToolsForScope } from './mcp-tool-filter.js';
import { rankToolsBySemantic, semanticToolRankEnabled } from './mcp-tool-rank.js';
import { isEmbeddingsEnabled } from '../memory/embeddings.js';
import type { McpToolScope } from './mcp-tool-scope.js';
import type { ManagedMcpServer } from '../types.js';

function positiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// The Agents SDK defaults the MCP client initialize/listTools timeout to
// 5 seconds. That is too low for cold `npx` servers and packaged Electron
// startup on slower Macs, so Clementine opts into a bounded but realistic
// handshake window while the namespace shim still caps first-turn discovery.
const MCP_CLIENT_SESSION_TIMEOUT_SECONDS = positiveIntEnv('MCP_CLIENT_SESSION_TIMEOUT_SECONDS', 30);
const MCP_REQUEST_TIMEOUT_MS = positiveIntEnv('MCP_REQUEST_TIMEOUT_MS', 10 * 60 * 1000);

// PATH-augmented spawn env (Homebrew/nvm/user-CLI dirs) — shared with the
// shell-exec and CLI-discovery seams so a packaged .app resolves binaries
// identically everywhere. See src/runtime/spawn-env.ts.
const mergedEnv = mergedSpawnEnv;

function localNodeCommand(): string {
  // In packaged Electron, the daemon itself is already running under
  // Clementine with ELECTRON_RUN_AS_NODE=1. Reuse that executable for
  // the local MCP child so fresh Macs do not need a separate Node.js
  // install just to run Clementine's built-in tools.
  return process.execPath || 'node';
}

function createLocalServer(): MCPServerStdio | null {
  if (!LOCAL_MCP_ENABLED) return null;

  const distEntry = path.join(PKG_DIR, 'dist', 'tools', 'mcp-server.js');
  const srcEntry = path.join(PKG_DIR, 'src', 'tools', 'mcp-server.ts');

  if (existsSync(distEntry)) {
    return new MCPServerStdio({
      name: 'clementine-local',
      command: localNodeCommand(),
      args: [distEntry],
      clientSessionTimeoutSeconds: MCP_CLIENT_SESSION_TIMEOUT_SECONDS,
      timeout: MCP_REQUEST_TIMEOUT_MS,
      env: mergedEnv({
        CLEMENTINE_HOME: BASE_DIR,
      }),
      cwd: BASE_DIR,
    });
  }

  return new MCPServerStdio({
    name: 'clementine-local',
    command: 'npx',
    args: ['tsx', srcEntry],
    clientSessionTimeoutSeconds: MCP_CLIENT_SESSION_TIMEOUT_SECONDS,
    timeout: MCP_REQUEST_TIMEOUT_MS,
    env: mergedEnv({
      CLEMENTINE_HOME: BASE_DIR,
    }),
    cwd: PKG_DIR,
  });
}

function createExternalServer(server: ManagedMcpServer): MCPServer | null {
  if (!server.enabled) return null;

  if (server.type === 'stdio' && server.command) {
    return new MCPServerStdio({
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      clientSessionTimeoutSeconds: MCP_CLIENT_SESSION_TIMEOUT_SECONDS,
      timeout: MCP_REQUEST_TIMEOUT_MS,
      env: mergedEnv(server.env),
      cwd: BASE_DIR,
    });
  }

  if (server.type === 'http' && server.url) {
    return new MCPServerStreamableHttp({
      name: server.name,
      url: server.url,
      clientSessionTimeoutSeconds: MCP_CLIENT_SESSION_TIMEOUT_SECONDS,
      timeout: MCP_REQUEST_TIMEOUT_MS,
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
  }

  if (server.type === 'sse' && server.url) {
    return new MCPServerSSE({
      name: server.name,
      url: server.url,
      clientSessionTimeoutSeconds: MCP_CLIENT_SESSION_TIMEOUT_SECONDS,
      timeout: MCP_REQUEST_TIMEOUT_MS,
      eventSourceInit: server.headers ? { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, headers: server.headers }) } : undefined,
    });
  }

  return null;
}

/**
 * Build the per-server list of MCPServer instances. Internal use only —
 * the Agent should be given the namespace-wrapped result of
 * `createConfiguredMcpServers()` so collisions are impossible.
 *
 * When `excludeLocal: true`, the local clementine MCP server is left
 * out. Use this from the harness Agent path, where the same tools
 * (memory, task, skill, etc.) are already in the surface via
 * getCoreToolsAsync() — including the local server through the shim
 * AND through registry.ts would create dup tools the model has to
 * disambiguate between (memory_remember vs clementine-local__memory_remember).
 */
function normalizeServerSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function serverMatchesAllowedSlugs(server: ManagedMcpServer, allowedServerSlugs?: string[]): boolean {
  if (!allowedServerSlugs || allowedServerSlugs.length === 0) return true;
  const name = normalizeServerSlug(server.name);
  return allowedServerSlugs.some((slug) => {
    const normalized = normalizeServerSlug(slug);
    return normalized.length > 0 && (name === normalized || name.includes(normalized) || normalized.includes(name));
  });
}

function buildRawMcpServers(options: { excludeLocal?: boolean; allowedServerSlugs?: string[] } = {}): MCPServer[] {
  const servers: MCPServer[] = [];
  if (!options.excludeLocal) {
    const local = createLocalServer();
    if (local) servers.push(local);
  }

  for (const config of discoverMcpServers()) {
    if (!serverMatchesAllowedSlugs(config, options.allowedServerSlugs)) continue;
    const server = createExternalServer(config);
    if (server) servers.push(server);
  }

  return servers;
}

/**
 * Public entrypoint — returns a SINGLE MCPServer (namespace shim)
 * wrapping every configured server. Pass directly to
 * `new Agent({ mcpServers: [createConfiguredMcpServers()] })`.
 *
 * Why one instead of N: the SDK throws on duplicate tool names across
 * servers. Wrapping in the shim guarantees uniqueness via
 * `<server>__<tool>` naming and centralises lifecycle, telemetry,
 * and the future per-turn `isEnabled` filter.
 *
 * Note: prefer `getOrCreateConfiguredMcpServers()` so the shim (and
 * its underlying stdio child processes) is constructed once and
 * shared. Use this raw factory only for one-off scripts.
 */
export function createConfiguredMcpServers(): MCPServer {
  return createMcpNamespaceShim({ servers: buildRawMcpServers() });
}

/**
 * Process-level cache of the configured MCP namespace shim. We share
 * the same shim across runtimes (OpenAI, Codex, autonomy) so:
 *   - stdio child MCP processes are spawned ONCE per daemon, not
 *     once-per-chat-request (huge cost difference);
 *   - lifecycle is centralized — close the shim, every server closes;
 *   - dashboard MCP CRUD handlers can invalidate without restarting
 *     the daemon — see invalidateConfiguredMcpServers() below.
 */
let cachedShim: MCPServer | null = null;
let cachedExternalShim: MCPServer | null = null;
// (Scoped shims no longer own a separate base — they wrap the shared all-external
//  base shim, so there are no per-scope base children to track or close.)
let cachedScopedExternalShims: Map<string, MCPServer> = new Map();
// Fail-open shim is a cheap cap-only view over cachedExternalShim (the all-
// external base), so it owns no child processes — clearing the base is enough.
let cachedFailOpenExternalShim: MCPServer | null = null;
let cachedFailOpenKey = '';

const emptyExternalShim: MCPServer = {
  cacheToolsList: false,
  name: 'clementine-external-empty',
  async connect() {},
  async close() {},
  async listTools() {
    return [];
  },
  async callTool(toolName) {
    throw new Error(`external MCP tool is not available in this turn: ${toolName}`);
  },
  async invalidateToolsCache() {},
};

export function getOrCreateConfiguredMcpServers(): MCPServer {
  if (!cachedShim) {
    cachedShim = createConfiguredMcpServers();
  }
  return cachedShim;
}

/**
 * External-only namespace shim — same as `getOrCreateConfiguredMcpServers`
 * but excludes the local clementine MCP server. Used by the harness
 * Agent path so DataForSEO / Supabase / browsermcp / etc. tools reach
 * the model WITHOUT duplicating the memory/task/skill tools that the
 * agent already gets through getCoreToolsAsync().
 *
 * Same daemon-lifetime cache pattern — stdio children spawn once and
 * are reused across every Orchestrator/Executor/Researcher build.
 */
function scopeCacheKey(scope: McpToolScope): string {
  return JSON.stringify({
    allowAll: !!scope.allowAll,
    allowedServerSlugs: [...(scope.allowedServerSlugs ?? [])].sort(),
    toolPatterns: [...(scope.toolPatterns ?? [])].sort(),
    priorityKeywords: [...(scope.priorityKeywords ?? [])].sort(),
    maxTools: scope.maxTools ?? null,
  });
}

function createScopedExternalShim(
  base: MCPServer,
  scope: McpToolScope,
  opts: { semantic?: boolean } = {},
): MCPServer {
  return {
    cacheToolsList: base.cacheToolsList,
    toolFilter: base.toolFilter,
    get name() {
      return `${base.name}:scoped`;
    },
    async connect() {
      await base.connect?.();
    },
    async close() {
      // Shared daemon-lifetime base shim owns the underlying stdio child
      // processes. Per-scope wrappers are cheap views and must not close it.
    },
    async listTools() {
      const tools = await base.listTools();
      // T1: on the fail-open surface, rank the user's connected tools by
      // semantic relevance to the query (returns undefined → keyword/index
      // order, zero behavior change). Only the fresh per-query fail-open shim
      // sets semantic:true — cached keyword shims hold a stale query and must
      // not.
      const semanticScores = opts.semantic
        ? await rankToolsBySemantic(scope.queryText, tools)
        : undefined;
      return filterMcpToolsForScope(tools, scope, semanticScores);
    },
    async callTool(toolName, args) {
      return base.callTool(toolName, args);
    },
    async invalidateToolsCache() {
      await base.invalidateToolsCache?.();
    },
  };
}

function ensureAllExternalBaseShim(): MCPServer {
  if (!cachedExternalShim) {
    cachedExternalShim = createMcpNamespaceShim({
      servers: buildRawMcpServers({ excludeLocal: true }),
    });
  }
  return cachedExternalShim;
}

/**
 * Fail-open per class: an unrecognized-intent turn exposes the user's OWN
 * connected external servers (all of them), bounded by scope.maxTools, instead
 * of the empty shim. Reuses the daemon-lifetime all-external base shim and wraps
 * it with the cap via the standard filter (scope.failOpenCandidate makes the
 * filter match every server but still apply the cap). No allowlist, no keyword
 * branch — candidates are whatever the user has connected.
 */
function getOrCreateFailOpenExternalShim(scope: McpToolScope): MCPServer {
  const base = ensureAllExternalBaseShim();
  // T1 semantic fail-open: rank the user's connected tools by relevance to THIS
  // query, so the cap keeps the N most relevant instead of the first N. A fresh
  // per-query wrapper over the SHARED base — no child re-spawn, deliberately not
  // cached (the ranking is query-specific). Falls back to the cached keyword
  // path when the flag is off or embeddings are unavailable.
  if (semanticToolRankEnabled() && scope.queryText && isEmbeddingsEnabled()) {
    return createScopedExternalShim(base, scope, { semantic: true });
  }
  const key = `failopen:${scope.maxTools ?? ''}`;
  if (cachedFailOpenExternalShim && cachedFailOpenKey === key) return cachedFailOpenExternalShim;
  cachedFailOpenExternalShim = createScopedExternalShim(base, scope);
  cachedFailOpenKey = key;
  return cachedFailOpenExternalShim;
}

export function getOrCreateExternalMcpServers(scope?: McpToolScope): MCPServer {
  if (!scope || scope.allowAll) {
    return ensureAllExternalBaseShim();
  }

  // Fail-open BEFORE the empty-shim guard: a failOpenCandidate scope has no
  // allowedServerSlugs (by design) but must still reach the user's servers.
  if (scope.failOpenCandidate) {
    return getOrCreateFailOpenExternalShim(scope);
  }

  if ((scope.maxTools ?? 0) === 0 || (scope.allowedServerSlugs ?? []).length === 0) {
    return emptyExternalShim;
  }

  const key = scopeCacheKey(scope);
  const cached = cachedScopedExternalShims.get(key);
  if (cached) return cached;

  // Reuse the ONE daemon-lifetime all-external base (the same child processes the
  // prewarm and every other scope share) and narrow it with the scope filter —
  // `toolMatchesScope` drops any tool whose server isn't in allowedServerSlugs, so
  // the model sees an identical surface. Previously this branch spawned a SEPARATE
  // base child per distinct scope key (a fresh DataForSEO/etc. process for every
  // new intent), which is why one server cold-booted several times per turn and
  // leaked children across a session. This mirrors getOrCreateFailOpenExternalShim.
  const base = ensureAllExternalBaseShim();
  const scoped = createScopedExternalShim(base, scope);
  cachedScopedExternalShims.set(key, scoped);
  return scoped;
}

/**
 * Run one pre-warm and retry a few times if not every server connected.
 * Pure + injectable sleep so the retry/backoff is unit-testable without
 * spawning real MCP children. Each retry gap (default 6s) clears the shim's
 * early connect-failure backoff (1s/5s ladder), so a server whose COLD handshake
 * was starved on the first attempt reconnects on a later one.
 */
export async function prewarmWithRetry(
  prewarmOnce: () => Promise<boolean>,
  opts: { attempts?: number; gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ attempts: number; allConnected: boolean }> {
  const maxAttempts = Math.max(1, opts.attempts ?? 3);
  const gapMs = opts.gapMs ?? 6_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempt = 0;
  let allConnected = false;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      allConnected = await prewarmOnce();
    } catch {
      allConnected = false;
    }
    if (allConnected) break;
    if (attempt < maxAttempts) await sleep(gapMs);
  }
  return { attempts: attempt, allConnected };
}

/**
 * Warm the daemon-lifetime external MCP base shim at startup, OFF the hot path.
 * Connecting while the boot loop is idle avoids the synchronous-better-sqlite3
 * event-loop starvation that times out a COLD connect mid-turn and degrades the
 * server (sess-mqg8wdw1: dataforseo "connecting" stalled a Salesforce-CLI turn
 * that never needed it). Connections persist, so every later turn — and every
 * cheap scoped/fail-open VIEW that delegates to this base — reuses them without
 * a per-turn handshake. Best-effort + retried; a still-dead server just stays a
 * stub and the per-turn skip-path (MCP_ATTACH_CONNECTED_ONLY) keeps it from ever
 * blocking a turn. Kill-switch (CLEMMY_MCP_PREWARM) is checked by the caller.
 */
export async function prewarmMcpServers(
  opts: { attempts?: number; gapMs?: number } = {},
): Promise<{ attempts: number; allConnected: boolean }> {
  const base = ensureAllExternalBaseShim() as { prewarm?: () => Promise<boolean> };
  if (typeof base.prewarm !== 'function') return { attempts: 0, allConnected: true };
  return prewarmWithRetry(() => base.prewarm!(), opts);
}

/**
 * Drop the cached shims. Closes the existing ones (best-effort) so
 * their underlying stdio MCP child processes get terminated. The next
 * call to `getOrCreateConfiguredMcpServers()` / `getOrCreateExternalMcpServers()`
 * builds a fresh shim that picks up the latest `mcp/servers.json`.
 *
 * Called from the dashboard's `/api/console/mcp-servers` POST/PATCH/
 * DELETE handlers — adding or toggling an MCP server takes effect on
 * the NEXT chat request, without a daemon restart.
 */
export async function invalidateConfiguredMcpServers(): Promise<void> {
  const targets = [
    cachedShim,
    cachedExternalShim,
  ].filter((s): s is MCPServer => s !== null);
  cachedShim = null;
  cachedExternalShim = null;
  cachedFailOpenExternalShim = null;
  cachedFailOpenKey = '';
  cachedScopedExternalShims = new Map();
  await Promise.all(
    targets.map((s) => (typeof s.close === 'function' ? s.close().catch(() => undefined) : undefined)),
  );
}

/**
 * Escape hatch — return the raw per-server list when the caller
 * really needs it (e.g. the dashboard `/api/console/mcp-servers`
 * route which lists configured servers regardless of namespacing).
 */
export function listRawMcpServers(): MCPServer[] {
  return buildRawMcpServers();
}
