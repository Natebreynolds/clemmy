import path from 'node:path';
import { existsSync } from 'node:fs';
import { MCPServerSSE, MCPServerStdio, MCPServerStreamableHttp, type MCPServer } from '@openai/agents';
import { BASE_DIR, LOCAL_MCP_ENABLED, PKG_DIR } from '../config.js';
import { discoverMcpServers } from './mcp-config.js';
import { createMcpNamespaceShim } from './mcp-namespace-shim.js';
import { filterMcpToolsForScope } from './mcp-tool-filter.js';
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

function mergedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  env.PATH = augmentPathForMcpSpawn(env.PATH);
  return { ...env, ...extra };
}

/**
 * macOS Electron apps launched from /Applications inherit a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — none of the dirs where Homebrew or
 * nvm install `npx`/`uvx`/`node` are on it. The result: every stdio MCP
 * server fails with `spawn npx ENOENT` on first call, so DataForSEO,
 * Bright Data, Apify, ElevenLabs, the local clementine MCP, etc. are
 * silently unusable when launched from the .app bundle.
 *
 * Prepend (a) the directory of the node binary that's running us, plus
 * (b) the well-known Homebrew + system tool dirs. Idempotent — duplicate
 * entries already on PATH are skipped.
 */
function augmentPathForMcpSpawn(existing: string | undefined): string {
  const sep = ':';
  const candidates: string[] = [];
  try {
    const dir = pathDirname(process.execPath);
    if (dir) candidates.push(dir);
  } catch { /* execPath unset is fine */ }
  candidates.push(
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  );
  const existingParts = (existing ?? '').split(sep).filter(Boolean);
  const seen = new Set(existingParts);
  const prepend: string[] = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    prepend.push(dir);
  }
  return [...prepend, ...existingParts].join(sep);
}

function pathDirname(filePath: string): string {
  // Local import alias to avoid shadowing the `path` module name in this
  // small helper while keeping the public surface tidy.
  return path.dirname(filePath);
}

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
let cachedScopedExternalBaseShims: Map<string, MCPServer> = new Map();
let cachedScopedExternalShims: Map<string, MCPServer> = new Map();

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

function createScopedExternalShim(base: MCPServer, scope: McpToolScope): MCPServer {
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
      return filterMcpToolsForScope(tools, scope);
    },
    async callTool(toolName, args) {
      return base.callTool(toolName, args);
    },
    async invalidateToolsCache() {
      await base.invalidateToolsCache?.();
    },
  };
}

export function getOrCreateExternalMcpServers(scope?: McpToolScope): MCPServer {
  if (!scope || scope.allowAll) {
    if (!cachedExternalShim) {
      cachedExternalShim = createMcpNamespaceShim({
        servers: buildRawMcpServers({ excludeLocal: true }),
      });
    }
    return cachedExternalShim;
  }

  if ((scope.maxTools ?? 0) === 0 || (scope.allowedServerSlugs ?? []).length === 0) {
    return emptyExternalShim;
  }

  const key = scopeCacheKey(scope);
  const cached = cachedScopedExternalShims.get(key);
  if (cached) return cached;

  const base = createMcpNamespaceShim({
    servers: buildRawMcpServers({
      excludeLocal: true,
      allowedServerSlugs: scope.allowedServerSlugs,
    }),
  });
  const scoped = createScopedExternalShim(base, scope);
  cachedScopedExternalBaseShims.set(key, base);
  cachedScopedExternalShims.set(key, scoped);
  return scoped;
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
    ...cachedScopedExternalBaseShims.values(),
  ].filter((s): s is MCPServer => s !== null);
  cachedShim = null;
  cachedExternalShim = null;
  cachedScopedExternalBaseShims = new Map();
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
