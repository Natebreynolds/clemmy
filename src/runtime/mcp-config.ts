import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_SERVERS_FILE, getRuntimeEnv } from '../config.js';
import type { ManagedMcpServer } from '../types.js';

const CACHE_TTL_MS = 60_000;

const KNOWN_DESCRIPTIONS: Record<string, string> = {
  slack: 'Slack workspace messaging and channels',
  linear: 'Linear issue tracking and project management',
  notion: 'Notion workspace pages and databases',
  github: 'GitHub repositories, issues, and pull requests',
  gitlab: 'GitLab repository management',
  supabase: 'Supabase database and auth',
  firecrawl: 'Web crawling and scraping',
  apify: 'Apify actors for web automation, scraping, and data extraction',
  exa: 'Neural web search',
  playwright: 'Browser testing and automation',
  browsermcp: 'Browser automation via MCP',
  context7: 'Documentation lookup',
  discord: 'Discord integration',
  figma: 'Figma design files',
  dataforseo: 'DataForSEO SEO, SERP, keyword, backlink, domain, and on-page audit data',
  'dataforseo-mcp-server': 'DataForSEO SEO, SERP, keyword, backlink, domain, and on-page audit data',
  'bright-data': 'Bright Data web scraping, browser automation, and web data access',
  elevenlabs: 'ElevenLabs text-to-speech and voice generation',
  'hostinger-mcp': 'Hostinger account, hosting, domain, and website operations',
};

let cachedServers: ManagedMcpServer[] | null = null;
let cacheExpiry = 0;

export function invalidateMcpServerDiscoveryCache(): void {
  cachedServers = null;
  cacheExpiry = 0;
}

function hardenUserMcpConfigPermissions(): void {
  const dir = path.dirname(MCP_SERVERS_FILE);
  try {
    if (existsSync(dir)) chmodSync(dir, 0o700);
  } catch { /* best-effort */ }
  try {
    if (existsSync(MCP_SERVERS_FILE)) chmodSync(MCP_SERVERS_FILE, 0o600);
  } catch { /* best-effort */ }
}

function normalizeServerName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function knownDescriptionFor(name: string): string | undefined {
  return KNOWN_DESCRIPTIONS[name] ?? KNOWN_DESCRIPTIONS[normalizeServerName(name)];
}

function mcpAutoImportEnabled(): boolean {
  return getRuntimeEnv('MCP_AUTO_IMPORT_ENABLED', 'false').toLowerCase() === 'true';
}

function addServer(servers: Map<string, ManagedMcpServer>, name: string, config: Record<string, unknown>, source: ManagedMcpServer['source']): void {
  servers.set(name, {
    name,
    type: config.type === 'http' || config.type === 'sse' ? config.type : 'stdio',
    command: typeof config.command === 'string' ? config.command : undefined,
    args: Array.isArray(config.args) ? config.args.filter((item): item is string => typeof item === 'string') : undefined,
    url: typeof config.url === 'string' ? config.url : undefined,
    headers: typeof config.headers === 'object' && config.headers ? (config.headers as Record<string, string>) : undefined,
    env: typeof config.env === 'object' && config.env ? (config.env as Record<string, string>) : undefined,
    description: typeof config.description === 'string' ? config.description : knownDescriptionFor(name) ?? `${name} MCP server`,
    enabled: config.enabled !== false,
    source,
  });
}

export function mcpServerSourceLabel(server: Pick<ManagedMcpServer, 'source'>): string {
  return server.source === 'user'
    ? 'Clementine user config'
    : 'imported MCP config';
}

export function renderMcpServersForInstructions(): string {
  const servers = discoverMcpServers().filter((server) => server.enabled);
  if (servers.length === 0) {
    return 'No external MCP servers are configured.';
  }

  const visible = servers.slice(0, 12).map((server) => (
    `- ${server.name} (${server.type}, ${mcpServerSourceLabel(server)}): ${server.description}`
  ));
  const hidden = servers.length > visible.length ? `\n- ${servers.length - visible.length} more MCP server(s) configured.` : '';

  return [
    'External MCP servers are configured and attached to the OpenAI agent runtime.',
    'Important: "imported MCP config" means the server definition came from another local MCP client config. It is only a source label; Clementine still runs the server through the OpenAI Agents SDK.',
    ...visible,
    hidden,
  ].filter(Boolean).join('\n');
}

export function discoverMcpServers(): ManagedMcpServer[] {
  const now = Date.now();
  if (cachedServers && now < cacheExpiry) {
    return cachedServers;
  }

  const servers = new Map<string, ManagedMcpServer>();

  if (mcpAutoImportEnabled()) {
    const desktopConfig = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (existsSync(desktopConfig)) {
      try {
        const data = JSON.parse(readFileSync(desktopConfig, 'utf-8')) as { mcpServers?: Record<string, Record<string, unknown>> };
        for (const [name, config] of Object.entries(data.mcpServers ?? {})) {
          addServer(servers, name, config, 'auto-detected');
        }
      } catch {
        // Ignore malformed desktop config.
      }
    }

    const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json');
    if (existsSync(claudeSettings)) {
      try {
        const data = JSON.parse(readFileSync(claudeSettings, 'utf-8')) as { mcpServers?: Record<string, Record<string, unknown>> };
        for (const [name, config] of Object.entries(data.mcpServers ?? {})) {
          if (!servers.has(name)) {
            addServer(servers, name, config, 'auto-detected');
          }
        }
      } catch {
        // Ignore malformed compatible MCP client config.
      }
    }
  }

  if (existsSync(MCP_SERVERS_FILE)) {
    try {
      hardenUserMcpConfigPermissions();
      const data = JSON.parse(readFileSync(MCP_SERVERS_FILE, 'utf-8')) as Record<string, Record<string, unknown>>;
      for (const [name, config] of Object.entries(data)) {
        addServer(servers, name, config, 'user');
      }
    } catch {
      // Ignore malformed user config.
    }
  }

  cachedServers = [...servers.values()];
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedServers;
}

export function loadUserMcpServers(): Record<string, Partial<ManagedMcpServer>> {
  if (!existsSync(MCP_SERVERS_FILE)) return {};
  try {
    hardenUserMcpConfigPermissions();
    return JSON.parse(readFileSync(MCP_SERVERS_FILE, 'utf-8')) as Record<string, Partial<ManagedMcpServer>>;
  } catch {
    return {};
  }
}

export function saveUserMcpServers(servers: Record<string, Partial<ManagedMcpServer>>): void {
  const dir = path.dirname(MCP_SERVERS_FILE);
  mkdirSync(dir, { recursive: true });
  hardenUserMcpConfigPermissions();
  writeFileSync(MCP_SERVERS_FILE, JSON.stringify(servers, null, 2), { encoding: 'utf-8', mode: 0o600 });
  hardenUserMcpConfigPermissions();
  invalidateMcpServerDiscoveryCache();
  // CONNECT-TIME INDEXING. This is the single config-write funnel — console
  // routes, the agent's own mcp_add/mcp_configure, and plugin installs all pass
  // through here — so it is where a newly added server becomes indexable. The
  // listing itself is detached: adding a server must not block on starting it.
  scheduleUserMcpCapabilityIndex();
}

/**
 * Enumerate every enabled MCP server's tools into the capability index.
 * Detached and best-effort: a server that will not start simply stays
 * unindexed, and retrieval falls back to live discovery.
 */
export function scheduleUserMcpCapabilityIndex(): void {
  void (async () => {
    try {
      const [{ getOrCreateExternalMcpServers }, { slugifyServerName }, { indexMcpServerTools }] =
        await Promise.all([
          import('./mcp-servers.js'),
          import('./mcp-namespace-shim.js'),
          import('./local-capability-enumeration.js'),
        ]);
      // The exact provisioned set, named explicitly: a scope with no slugs is a
      // denial, not "everything", so enumeration must list what the user
      // actually enabled. Read from this module's own config — enabled state
      // lives here, so no import back through the server factory is needed.
      const allowedServerSlugs = Object.entries(loadUserMcpServers())
        .filter(([, server]) => server?.enabled !== false)
        .map(([name, server]) => slugifyServerName(server?.name ?? name))
        .filter(Boolean);
      if (allowedServerSlugs.length === 0) return;
      const shim = getOrCreateExternalMcpServers({
        reason: 'capability index: enumerate provisioned MCP servers',
        authority: 'catalog',
        allowedServerSlugs,
      }) as unknown as { listTools?: () => Promise<Array<{ name: string; description?: unknown }>> };
      if (typeof shim?.listTools !== 'function') return;
      const tools = await shim.listTools();
      // `inputSchema` is named here on purpose: the whole tool object is
      // bucketed, and the indexer deposits the schema the server already
      // published (CAT-7). A narrower type would erase the field from view and
      // invite a future tidy-up that silently reopens the discard.
      const byServer = new Map<string, Array<{
        name: string;
        description?: unknown;
        inputSchema?: unknown;
      }>>();
      for (const tool of tools ?? []) {
        const name = String(tool?.name ?? '').replace(/^mcp__/, '');
        const server = name.includes('__') ? name.split('__')[0] ?? '' : '';
        if (!server) continue;
        const bucket = byServer.get(server) ?? [];
        bucket.push(tool);
        byServer.set(server, bucket);
      }
      for (const [server, serverTools] of byServer) {
        indexMcpServerTools(server, serverTools);
      }
    } catch { /* connect-time indexing is best-effort by construction */ }
  })();
}
