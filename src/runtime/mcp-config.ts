import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_SERVERS_FILE } from '../config.js';
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
  exa: 'Neural web search',
  playwright: 'Browser testing and automation',
  browsermcp: 'Browser automation via MCP',
  context7: 'Documentation lookup',
  discord: 'Discord integration',
  figma: 'Figma design files',
};

let cachedServers: ManagedMcpServer[] | null = null;
let cacheExpiry = 0;

function invalidateCache(): void {
  cachedServers = null;
  cacheExpiry = 0;
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
    description: typeof config.description === 'string' ? config.description : KNOWN_DESCRIPTIONS[name] ?? `${name} MCP server`,
    enabled: config.enabled !== false,
    source,
  });
}

export function discoverMcpServers(): ManagedMcpServer[] {
  const now = Date.now();
  if (cachedServers && now < cacheExpiry) {
    return cachedServers;
  }

  const servers = new Map<string, ManagedMcpServer>();

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
      // Ignore malformed Claude Code config.
    }
  }

  if (existsSync(MCP_SERVERS_FILE)) {
    try {
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
    return JSON.parse(readFileSync(MCP_SERVERS_FILE, 'utf-8')) as Record<string, Partial<ManagedMcpServer>>;
  } catch {
    return {};
  }
}

export function saveUserMcpServers(servers: Record<string, Partial<ManagedMcpServer>>): void {
  mkdirSync(path.dirname(MCP_SERVERS_FILE), { recursive: true });
  writeFileSync(MCP_SERVERS_FILE, JSON.stringify(servers, null, 2));
  invalidateCache();
}
