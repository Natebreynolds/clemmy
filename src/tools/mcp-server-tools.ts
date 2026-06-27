/**
 * MCP server self-heal tools (gated). Lets the orchestrator BRAIN diagnose,
 * recover, create, and reconfigure external MCP servers at runtime — WITHOUT
 * ever writing a raw secret. Credentials stay human-only: these tools declare /
 * surface which env keys a server needs (by NAME); the human enters the actual
 * values in the dashboard (Settings → MCP Servers). Design owner: Nathan,
 * 2026-06-27 ("Clementine creates the MCP and then we manually write the
 * credentials in the dashboard").
 *
 * Gating (src/agents/tool-taxonomy.ts): mcp_reconnect = read (recovery, no
 * write, no secret) → no approval; mcp_add / mcp_configure = admin → ALWAYS ask
 * (confirm-first), even in YOLO. None of these accept or echo a secret VALUE.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { discoverMcpServers, loadUserMcpServers, saveUserMcpServers } from '../runtime/mcp-config.js';
import { invalidateConfiguredMcpServers } from '../runtime/mcp-servers.js';
import { listMcpServerHealth, slugifyServerName } from '../runtime/mcp-namespace-shim.js';
import { readBaseEnv, textResult } from './shared.js';
import type { ManagedMcpServer } from '../types.js';

/**
 * Which env keys a server DECLARES vs which are still UNSET (no value). Handles
 * both config shapes: an ARRAY of pass-through key names (value lives in the
 * daemon env), or an OBJECT key→value (value inline). A key is "unset" when it
 * has no inline value AND no value in the daemon env. NEVER returns values —
 * only names + a boolean. Exported so mcp_status reuses the exact same logic.
 */
export function serverEnvStatus(server: Pick<ManagedMcpServer, 'env'>): { declaredEnvKeys: string[]; unsetEnvKeys: string[] } {
  const raw = server.env as unknown;
  const baseEnv = readBaseEnv();
  const hasValue = (key: string, inline?: string): boolean => {
    if (typeof inline === 'string' && inline.trim()) return true;
    const v = baseEnv[key] ?? process.env[key] ?? '';
    return String(v).trim().length > 0;
  };
  let declared: string[] = [];
  const unset: string[] = [];
  if (Array.isArray(raw)) {
    declared = raw.filter((k): k is string => typeof k === 'string');
    for (const k of declared) if (!hasValue(k)) unset.push(k);
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, string>;
    declared = Object.keys(obj);
    for (const k of declared) if (!hasValue(k, obj[k])) unset.push(k);
  }
  return { declaredEnvKeys: declared, unsetEnvKeys: unset };
}

const NAME_RE = /^[a-zA-Z0-9_.-]{2,40}$/;

/** Validation mirrored from the dashboard POST/PATCH handlers
 *  (console-routes.ts) so a brain-created config can't be malformed. Returns an
 *  error string, or null when valid. */
export function validateMcpServerConfig(cfg: { name: string; type: string; command?: string; url?: string }): string | null {
  if (!NAME_RE.test(cfg.name)) return `Invalid name "${cfg.name}" — use 2-40 chars: letters, digits, _ . -`;
  if (cfg.type !== 'stdio' && cfg.type !== 'http' && cfg.type !== 'sse') return `Invalid type "${cfg.type}" — must be stdio | http | sse`;
  if (cfg.type === 'stdio' && !cfg.command?.trim()) return 'A stdio server requires a `command`.';
  if ((cfg.type === 'http' || cfg.type === 'sse') && !cfg.url?.trim()) return `A ${cfg.type} server requires a \`url\`.`;
  return null;
}

function healthFor(name: string): { state: string; failureCount?: number; lastError?: string } | null {
  const slug = slugifyServerName(name);
  const h = listMcpServerHealth().find((x) => x.slug === slug || x.name === name);
  return h ? { state: h.state, failureCount: h.failureCount, lastError: h.lastError } : null;
}

export function registerMcpServerTools(server: McpServer): void {
  // ── mcp_reconnect (read-class: recover, no write, no secret) ───────────────
  server.tool(
    'mcp_reconnect',
    [
      'Recover an external MCP server that is degraded/unavailable (stuck in the connection backoff).',
      'Drops the cached MCP connections and closes the child processes, so every server reconnects fresh on the next use — clearing any backoff window.',
      'Use after mcp_status shows a server in state "degraded"/"unavailable", or right after the user enters missing credentials in the dashboard, so the new env is picked up.',
      'Does NOT change config or write secrets. Safe to call between turns.',
    ].join(' '),
    {
      server_name: z.string().optional().describe('The server to recover (for the message). Reconnect clears ALL MCP connections regardless; pass the name you care about.'),
    },
    async ({ server_name }) => {
      const before = server_name ? healthFor(server_name) : null;
      try {
        invalidateConfiguredMcpServers();
      } catch (err) {
        return textResult(`mcp_reconnect: failed to clear MCP connections — ${err instanceof Error ? err.message : String(err)}`);
      }
      return textResult([
        'MCP connections cleared — all servers will reconnect fresh on the next tool call (backoff windows reset).',
        server_name ? `Target "${server_name}" prior state: ${before?.state ?? 'unknown'}${before?.lastError ? ` (last error: ${before.lastError})` : ''}.` : '',
        'Call mcp_status next turn to confirm it reconnected.',
      ].filter(Boolean).join(' '));
    },
  );

  // ── mcp_add (admin: create a server config; NO secret values) ──────────────
  server.tool(
    'mcp_add',
    [
      'Create a NEW external MCP server configuration. APPROVAL-GATED (admin).',
      'Declares the server (name/type/command|url/args/description) and the NAMES of any env/credential keys it needs — but writes NO secret values.',
      'After it is created, the user enters the credential VALUES in the dashboard (Settings → MCP Servers); you cannot set secrets from here.',
      'Returns the missing credential key names + the dashboard next step. Use mcp_configure to edit an existing server.',
    ].join(' '),
    {
      name: z.string().describe('Server name (2-40 chars: letters, digits, _ . -). Must not already exist.'),
      type: z.enum(['stdio', 'http', 'sse']).describe('stdio (local command) | http | sse (remote URL).'),
      command: z.string().optional().describe('Required for stdio (e.g. "npx").'),
      args: z.array(z.string()).optional().describe('Args for a stdio command (e.g. ["-y","some-mcp-server"]).'),
      url: z.string().optional().describe('Required for http/sse.'),
      description: z.string().optional().describe('Short human description of what the server provides.'),
      required_env_keys: z.array(z.string()).optional().describe('NAMES of env/credential keys this server needs (e.g. ["DATAFORSEO_USERNAME","DATAFORSEO_PASSWORD"]). Values are entered by the user in the dashboard — never here.'),
    },
    async ({ name, type, command, args, url, description, required_env_keys }) => {
      const err = validateMcpServerConfig({ name, type, command, url });
      if (err) return textResult(`mcp_add refused: ${err}`);
      const existing = loadUserMcpServers();
      if (existing[name]) return textResult(`mcp_add refused: a server named "${name}" already exists. Use mcp_configure to edit it.`);
      const envKeys = (required_env_keys ?? []).filter((k) => typeof k === 'string' && k.trim());
      const env: Record<string, string> = {};
      for (const k of envKeys) env[k] = ''; // declare the key; value entered in the dashboard
      const next: Record<string, Partial<ManagedMcpServer>> = {
        ...existing,
        [name]: {
          name, type,
          ...(command ? { command } : {}),
          ...(args && args.length ? { args } : {}),
          ...(url ? { url } : {}),
          ...(envKeys.length ? { env } : {}),
          description: description?.trim() || `${name} MCP server`,
          enabled: true,
          source: 'user',
        },
      };
      saveUserMcpServers(next);
      try { invalidateConfiguredMcpServers(); } catch { /* reconnect happens on next use */ }
      return textResult([
        `Created MCP server "${name}" (${type}).`,
        envKeys.length
          ? `It needs credentials before it can connect: ${envKeys.join(', ')}. Ask the user to enter these in the dashboard (Settings → MCP Servers → ${name}), then call mcp_reconnect.`
          : 'No credentials declared. It should connect on the next tool call.',
      ].join(' '));
    },
  );

  // ── mcp_configure (admin: edit non-secret fields; env writes refused) ──────
  server.tool(
    'mcp_configure',
    [
      'Edit an EXISTING external MCP server\'s NON-SECRET fields (description/command/args/url/headers/type/enabled). APPROVAL-GATED (admin).',
      'Does NOT set credentials — env/secret values are entered by the user in the dashboard. Passing env here is refused.',
      'Use mcp_add to create a server, mcp_reconnect to recover one.',
    ].join(' '),
    {
      server_name: z.string().describe('Name of the existing server to edit.'),
      description: z.string().optional(),
      type: z.enum(['stdio', 'http', 'sse']).optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      enabled: z.boolean().optional().describe('Enable or disable the server.'),
    },
    async ({ server_name, description, type, command, args, url, enabled }) => {
      const existing = loadUserMcpServers();
      const current = existing[server_name];
      if (!current) return textResult(`mcp_configure refused: no server named "${server_name}". Use mcp_status to list servers, or mcp_add to create one.`);
      const merged: Partial<ManagedMcpServer> = {
        ...current,
        ...(description !== undefined ? { description } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      };
      const err = validateMcpServerConfig({ name: server_name, type: merged.type ?? 'stdio', command: merged.command, url: merged.url });
      if (err) return textResult(`mcp_configure refused: ${err}`);
      saveUserMcpServers({ ...existing, [server_name]: merged });
      try { invalidateConfiguredMcpServers(); } catch { /* reconnect on next use */ }
      const { unsetEnvKeys } = serverEnvStatus(merged);
      return textResult([
        `Updated MCP server "${server_name}".`,
        unsetEnvKeys.length ? `Still needs credentials (enter in the dashboard): ${unsetEnvKeys.join(', ')}.` : '',
        'Call mcp_reconnect to apply, then mcp_status to confirm.',
      ].filter(Boolean).join(' '));
    },
  );
}
