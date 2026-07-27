import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { discoverMcpServers, mcpServerSourceLabel } from '../runtime/mcp-config.js';
import { listMcpServerHealth, parseNamespacedTool, slugifyServerName } from '../runtime/mcp-namespace-shim.js';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from '../runtime/harness/tool-output-format.js';
import { serverEnvStatus } from './mcp-server-tools.js';
import type { ManagedMcpServer } from '../types.js';
import { textResult } from './shared.js';

interface McpInventoryTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

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

/** Rank a single server's compact inventory without loading any schema into an
 * ordinary model turn. Exported so the observed "guess three MCP tool names"
 * regression stays pinned without launching a real child process in tests. */
export function rankMcpToolInventory(
  tools: McpInventoryTool[],
  query?: string | null,
  limit = 8,
): McpInventoryTool[] {
  const bounded = Math.max(1, Math.min(20, Math.floor(limit)));
  const phrase = (query ?? '').trim().toLowerCase();
  const terms = queryTerms(phrase);
  if (!phrase) return [...tools].sort((a, b) => a.name.localeCompare(b.name)).slice(0, bounded);

  return tools
    .map((tool, index) => {
      const parsed = parseNamespacedTool(tool.name);
      const name = (parsed?.toolName ?? tool.name).toLowerCase();
      const description = (tool.description ?? '').toLowerCase();
      const normalizedName = name.replace(/[^a-z0-9]+/g, ' ').trim();
      let score = normalizedName === phrase ? 1_000 : 0;
      if (normalizedName.includes(phrase)) score += 200;
      for (const term of terms) {
        if (name.includes(term)) score += 12;
        if (description.includes(term)) score += 3;
      }
      return { tool, index, score };
    })
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, bounded)
    .map((entry) => entry.tool);
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
      'NEVER pass the user\'s question (e.g. "top keywords for evergreen-law.example") as the query. That text will never match a server\'s haystack and you\'ll get a misleading "no matching server" result that makes you wrongly conclude the integration is unavailable.',
      'PREFER calling the relevant MCP tool directly over preflighting with mcp_status. mcp_status is only useful when you actually don\'t know whether a server is configured. Once you know a server exists (e.g. DataForSEO), do not re-check before every call — just call the tool.',
      'This checks MCP configuration, not Composio OAuth. They are separate tool sources.',
      'If an enabled server matches and auth env is present, its tools are callable. Use mcp_list_tools(server_name, query) to get their EXACT callable `<server>__<tool>` names and the best match\'s real input schema; never guess a vendor tool name.',
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

  server.tool(
    'mcp_list_tools',
    [
      'Search ONE configured external MCP server and return exact callable tool names plus concise descriptions.',
      'The closest match includes its REAL input schema so you can call it once without guessing names or arguments.',
      'Use this after mcp_status only when you do not already know the exact tool. Results are `<server>__<tool>` names suitable for call_tool.',
      'Read-only: this enumerates cached server metadata and never invokes a vendor operation.',
      '`mcp_tools` is accepted as a compatibility alias by call_tool.',
    ].join(' '),
    {
      server: z.string().min(1).max(80).nullish().describe('Exact configured MCP server name or slug, e.g. "dataforseo". `server_name` is also accepted.'),
      server_name: z.string().min(1).max(80).nullish().describe('Compatibility spelling for `server`. Omit when `server` is present.'),
      query: z.string().max(400).nullish().describe('What vendor operation you need, e.g. "Google keyword suggestions". Omit to list alphabetically.'),
      limit: z.number().int().min(1).max(20).nullish().describe('Maximum names to return (default 8).'),
    },
    async ({ server, server_name, query, limit }) => {
      const requested = server?.trim() || server_name?.trim() || '';
      if (!requested) {
        return textResult('Pass `server` (or `server_name`) with an exact configured MCP server name. Call mcp_status with no query to list them.');
      }
      const requestedSlug = slugifyServerName(requested);
      const configured = discoverMcpServers().find((candidate) =>
        candidate.name === requested || slugifyServerName(candidate.name) === requestedSlug);
      if (!configured) {
        return textResult(`No configured MCP server matches "${requested}". Call mcp_status with no query to list exact server names.`);
      }
      if (!configured.enabled) {
        return textResult(`MCP server "${configured.name}" is disabled. Enable it before loading or calling its tools.`);
      }

      try {
        // Dynamic import keeps the MCP process/runtime graph off ordinary turns.
        // Enumerate only the explicitly selected server; no unrelated MCP child
        // or schema is loaded.
        const { getOrCreateExternalMcpServers } = await import('../runtime/mcp-servers.js');
        const shim = getOrCreateExternalMcpServers({
          reason: `on-demand MCP inventory for ${configured.name}`,
          allowedServerSlugs: [requestedSlug],
          maxTools: 1_000,
        });
        const all = (await shim.listTools()) as McpInventoryTool[];
        const ranked = rankMcpToolInventory(all, query, limit ?? 8);
        const schemas: Record<string, unknown> = {};
        if (query?.trim() && ranked[0]?.inputSchema !== undefined) {
          schemas[ranked[0].name] = ranked[0].inputSchema;
        }
        const results = ranked.map((tool) => ({
          name: tool.name,
          description: (tool.description ?? '').slice(0, 500),
        }));
        const payload: {
          server: string;
          state: string;
          query: string | null;
          totalToolCount: number;
          results: typeof results;
          schemas: Record<string, unknown>;
          hint: string;
        } = {
          server: configured.name,
          state: healthStateFor(configured.name)?.state ?? (all.length > 0 ? 'connected' : 'connecting'),
          query: query?.trim() || null,
          totalToolCount: all.length,
          results,
          schemas,
          hint: 'Invoke the selected exact name with call_tool(name, args_json), using the schema above. Do not guess a neighboring vendor name.',
        };
        let rendered = JSON.stringify(payload);
        // Preserve the exact names even if a vendor ships an unusually large
        // schema. A schema-less result can be reacquired with a tighter query.
        if (rendered.length > DEFAULT_TOOL_RESULT_MAX_CHARS) {
          payload.schemas = {};
          payload.hint = 'The best schema exceeded the bounded result size. Search again with the exact returned tool name, or call it once and follow its validation response.';
          rendered = JSON.stringify(payload);
        }
        return textResult(rendered);
      } catch (error) {
        return textResult(`Could not list tools for MCP server "${configured.name}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
