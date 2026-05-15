import path from 'node:path';
import { existsSync } from 'node:fs';
import { MCPServerSSE, MCPServerStdio, MCPServerStreamableHttp, type MCPServer } from '@openai/agents';
import { BASE_DIR, LOCAL_MCP_ENABLED, PKG_DIR } from '../config.js';
import { discoverMcpServers } from './mcp-config.js';
import { createMcpNamespaceShim } from './mcp-namespace-shim.js';
import type { ManagedMcpServer } from '../types.js';

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

function createLocalServer(): MCPServerStdio | null {
  if (!LOCAL_MCP_ENABLED) return null;

  const distEntry = path.join(PKG_DIR, 'dist', 'tools', 'mcp-server.js');
  const srcEntry = path.join(PKG_DIR, 'src', 'tools', 'mcp-server.ts');

  if (existsSync(distEntry)) {
    return new MCPServerStdio({
      name: 'clementine-local',
      command: 'node',
      args: [distEntry],
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
      env: mergedEnv(server.env),
      cwd: BASE_DIR,
    });
  }

  if (server.type === 'http' && server.url) {
    return new MCPServerStreamableHttp({
      name: server.name,
      url: server.url,
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
  }

  if (server.type === 'sse' && server.url) {
    return new MCPServerSSE({
      name: server.name,
      url: server.url,
      eventSourceInit: server.headers ? { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, headers: server.headers }) } : undefined,
    });
  }

  return null;
}

/**
 * Build the per-server list of MCPServer instances. Internal use only —
 * the Agent should be given the namespace-wrapped result of
 * `createConfiguredMcpServers()` so collisions are impossible.
 */
function buildRawMcpServers(): MCPServer[] {
  const servers: MCPServer[] = [];
  const local = createLocalServer();
  if (local) servers.push(local);

  for (const config of discoverMcpServers()) {
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

export function getOrCreateConfiguredMcpServers(): MCPServer {
  if (!cachedShim) {
    cachedShim = createConfiguredMcpServers();
  }
  return cachedShim;
}

/**
 * Drop the cached shim. Closes the existing one (best-effort) so its
 * underlying stdio MCP child processes get terminated. The next call
 * to `getOrCreateConfiguredMcpServers()` builds a fresh shim that
 * picks up the latest `mcp/servers.json`.
 *
 * Called from the dashboard's `/api/console/mcp-servers` POST/PATCH/
 * DELETE handlers — adding or toggling an MCP server takes effect on
 * the NEXT chat request, without a daemon restart.
 */
export async function invalidateConfiguredMcpServers(): Promise<void> {
  const previous = cachedShim;
  cachedShim = null;
  if (previous && typeof previous.close === 'function') {
    await previous.close().catch(() => undefined);
  }
}

/**
 * Escape hatch — return the raw per-server list when the caller
 * really needs it (e.g. the dashboard `/api/console/mcp-servers`
 * route which lists configured servers regardless of namespacing).
 */
export function listRawMcpServers(): MCPServer[] {
  return buildRawMcpServers();
}
