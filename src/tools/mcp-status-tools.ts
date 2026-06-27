import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { discoverMcpServers, mcpServerSourceLabel } from '../runtime/mcp-config.js';
import { listMcpServerHealth, slugifyServerName } from '../runtime/mcp-namespace-shim.js';
import { serverEnvStatus } from './mcp-server-tools.js';
import type { ManagedMcpServer } from '../types.js';
import { textResult } from './shared.js';

function healthStateFor(name: string): { state: string; failureCount: number; lastError?: string } | null {
  const slug = slugifyServerName(name);
  const h = listMcpServerHealth().find((x) => x.slug === slug || x.name === name);
  return h ? { state: h.state, failureCount: h.failureCount, lastError: h.lastError } : null;
}

function queryTerms(query?: string): string[] {
  return (query ?? '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter(Boolean);
}

export function mcpServerMatchesQuery(server: ManagedMcpServer, query?: string): boolean {
  if (!query?.trim()) return true;
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const haystack = [
    server.name,
    server.type,
    server.description,
    server.source,
    server.command,
    server.url,
    ...Object.keys(server.env ?? {}),
  ].filter(Boolean).join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function renderServerLine(server: ManagedMcpServer): string {
  const status = server.enabled ? 'enabled' : 'disabled';
  const source = mcpServerSourceLabel(server);
  const health = healthStateFor(server.name);
  const { unsetEnvKeys } = serverEnvStatus(server);
  const state = health ? `, ${health.state}${health.failureCount ? ` (${health.failureCount} fails)` : ''}` : '';
  const creds = unsetEnvKeys.length > 0 ? `, NEEDS CREDENTIALS: ${unsetEnvKeys.join(', ')}` : '';
  return `- ${server.name} [${status}] (${server.type}, ${source}${state}${creds}): ${server.description}`;
}

export function registerMcpStatusTools(server: McpServer): void {
  server.tool(
    'mcp_status',
    [
      'Inspect configured external MCP servers available to Clementine.',
      'IMPORTANT: the `query` filter matches against server name / description / env keys — NOT the user\'s natural-language question. Pass a SHORT CATEGORY like "seo", "dataforseo", "browser", "supabase", "email", "web", "hosting" — OR pass no query at all to list every server.',
      'NEVER pass the user\'s question (e.g. "top keywords for revilllaw.com") as the query. That text will never match a server\'s haystack and you\'ll get a misleading "no matching server" result that makes you wrongly conclude the integration is unavailable.',
      'PREFER calling the relevant MCP tool directly over preflighting with mcp_status. mcp_status is only useful when you actually don\'t know whether a server is configured. Once you know a server exists (e.g. DataForSEO), do not re-check before every call — just call the tool.',
      'This checks MCP configuration, not Composio OAuth. They are separate tool sources.',
      'If an enabled server matches and auth env is present, the MCP tools are callable. The actual tool names appear under their bare names (e.g. DataForSEO exposes `serp_organic_live_advanced`, `dataforseo_labs_google_ranked_keywords` — NOT prefixed with the server name).',
      'The source "imported MCP config" means the server definition came from another local MCP client config, but Clementine still runs these through the OpenAI Agents SDK.',
      'Secrets are never returned; only env variable names are shown.',
      'Each server reports a connection `state` (connected/connecting/degraded/unavailable) and `unsetEnvKeys` (declared credential names with NO value yet). To self-heal: if a server is degraded/unavailable, call mcp_reconnect; if it is missing config, call mcp_add; to edit a server, call mcp_configure. If unsetEnvKeys is non-empty, the USER must enter those credential values in the dashboard (Settings → MCP Servers) — you cannot set secrets.',
    ].join(' '),
    {
      query: z.string().optional().describe('Short CATEGORY filter ("seo", "dataforseo", "browser", "supabase", "email", "web", "hosting") — NOT the user\'s question text. Omit to list all configured servers.'),
      include_disabled: z.boolean().optional().describe('Include disabled MCP servers. Default false.'),
    },
    async ({ query, include_disabled }) => {
      const allServers = discoverMcpServers();
      const servers = allServers
        .filter((item) => include_disabled || item.enabled)
        .filter((item) => mcpServerMatchesQuery(item, query));

      const lines = servers.map(renderServerLine);
      const payload = {
        query: query || null,
        configuredCount: allServers.length,
        matchedCount: servers.length,
        servers: servers.map((item) => {
          const health = healthStateFor(item.name);
          const { declaredEnvKeys, unsetEnvKeys } = serverEnvStatus(item);
          return {
            name: item.name,
            type: item.type,
            enabled: item.enabled,
            source: mcpServerSourceLabel(item),
            description: item.description,
            command: item.command,
            argCount: item.args?.length ?? 0,
            urlConfigured: Boolean(item.url),
            // Connection health (from the namespace shim) — lets the brain decide
            // whether to mcp_reconnect a degraded/unavailable server.
            state: health?.state ?? 'unknown',
            failureCount: health?.failureCount ?? 0,
            lastError: health?.lastError,
            // Credential status — KEY NAMES ONLY, never values. unsetEnvKeys =
            // declared but no value (in config or daemon env) → user must enter
            // them in the dashboard.
            declaredEnvKeys,
            unsetEnvKeys,
          };
        }),
      };

      return textResult([
        `MCP server matches (${servers.length}/${allServers.length}):`,
        lines.length > 0 ? lines.join('\n') : 'No matching MCP servers found.',
        '',
        'RAW:',
        JSON.stringify(payload, null, 2),
      ].join('\n'));
    },
  );
}
