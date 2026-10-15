/**
 * MCP server self-heal tools (gated). Lets the orchestrator BRAIN diagnose,
 * recover, create, and reconfigure external MCP servers at runtime — WITHOUT
 * ever writing a raw secret. Credentials stay human-only: these tools declare /
 * surface which env keys a server needs (by NAME); the human enters the actual
 * values in the dashboard (Connect → MCP servers). Clementine creates the MCP,
 * then the user enters credentials in the dashboard.
 *
 * Gating (src/agents/tool-taxonomy.ts): mcp_reconnect = read (recovery, no
 * write, no secret) → no approval; mcp_add / mcp_configure = admin → ALWAYS ask
 * (confirm-first), even in YOLO. None of these accept or echo a secret VALUE.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { discoverMcpServers, loadUserMcpServers, saveUserMcpServers } from '../runtime/mcp-config.js';
import { invalidateConfiguredMcpServers, reconnectConfiguredMcpServer, observeConfiguredMcpServerSetup } from '../runtime/mcp-servers.js';
import { listMcpServerHealth, slugifyServerName } from '../runtime/mcp-namespace-shim.js';
import { textResult } from './shared.js';
import type { ManagedMcpServer } from '../types.js';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { declareMcpServerEnvKeys, readMcpServerEnv, resolveMcpServerEnv, type McpServerEnvSources } from '../runtime/mcp-server-env.js';
import { prepareMcpServerCreateRequest, validateMcpWorkingDirectory } from '../runtime/mcp-server-request.js';
import { prepareAgentMcpHeaderTemplates } from '../runtime/mcp-server-setup.js';

/**
 * Which env keys a server DECLARES vs which are still UNSET (no value). Handles
 * both config shapes: an ARRAY of pass-through key names (value lives in the
 * daemon env), or an OBJECT key→value (value inline). A key is "unset" when it
 * has no inline value AND no value in the daemon env. NEVER returns values —
 * only names + a boolean. Exported so mcp_status reuses the exact same logic.
 */
export function serverEnvStatus(server: Pick<ManagedMcpServer, 'env'>,
  sources?: McpServerEnvSources): { declaredEnvKeys: string[]; unsetEnvKeys: string[] } {
  const { declaredEnvKeys, unsetEnvKeys } = sources ? resolveMcpServerEnv(server.env, sources)
    : readMcpServerEnv(server.env, path.join(BASE_DIR, '.env'));
  return { declaredEnvKeys, unsetEnvKeys };
}

const NAME_RE = /^[a-zA-Z0-9_.-]{2,40}$/;

/** Validation mirrored from the dashboard POST/PATCH handlers
 *  (console-routes.ts) so a brain-created config can't be malformed. Returns an
 *  error string, or null when valid. */
export function validateMcpServerConfig(cfg: { name: string; type: string; command?: string; url?: string; cwd?: string }): string | null {
  if (!NAME_RE.test(cfg.name)) return `Invalid name "${cfg.name}" — use 2-40 chars: letters, digits, _ . -`;
  if (cfg.type !== 'stdio' && cfg.type !== 'http' && cfg.type !== 'sse') return `Invalid type "${cfg.type}" — must be stdio | http | sse`;
  if (cfg.type === 'stdio' && !cfg.command?.trim()) return 'A stdio server requires a `command`.';
  if ((cfg.type === 'http' || cfg.type === 'sse') && !cfg.url?.trim()) return `A ${cfg.type} server requires a \`url\`.`;
  const cwdError = validateMcpWorkingDirectory(cfg.cwd, cfg.type);
  if (cwdError) return cwdError;
  return null;
}

function healthFor(name: string): { state: string; failureCount?: number; lastError?: string } | null {
  const slug = slugifyServerName(name);
  const h = listMcpServerHealth().find((x) => x.slug === slug || x.name === name);
  return h ? { state: h.state, failureCount: h.failureCount, lastError: h.lastError } : null;
}

async function finishApprovedSetup(name: string, verb: 'Created' | 'Updated') {
  try {
    await invalidateConfiguredMcpServers();
    const readiness = await observeConfiguredMcpServerSetup(name);
    const next = readiness.state === 'needs_credentials'
      ? 'The user enters these values in Connect → MCP servers. Never request credential values in chat.'
      : readiness.state === 'connecting' ? 'The handshake is still running; this is saved configuration, not verified readiness yet.'
        : readiness.state === 'connected' ? 'The server handshake and tool inventory were verified. Normal tool discovery, scope and effect approvals still apply.'
          : readiness.state === 'disabled' ? 'The server is saved and disabled.'
            : readiness.reason === 'turn_scope' ? 'The server is saved, but this turn does not authorize its full connection inventory. Verify it through a normally authorized discovery or Connect → MCP servers.'
              : 'The configuration is saved, but its connection was not verified. Check its executable, working directory or endpoint in Connect → MCP servers before reconnecting.';
    return textResult(`${verb} MCP server "${name}". ${JSON.stringify({ server: name, ...readiness })}\n${next}`);
  } catch {
    return textResult(`${verb} MCP server "${name}". Its configuration is saved, but connection readiness could not be verified. No vendor operation was run.`);
  }
}

export function registerMcpServerTools(server: McpServer): void {
  // ── mcp_reconnect (read-class: recover, no write, no secret) ───────────────
  server.tool(
    'mcp_reconnect',
    [
      'Recover an external MCP server that is degraded/unavailable (stuck in the connection backoff).',
      'With server_name: drops that one server\'s connection (closing its child process) and starts it again, clearing its backoff window; other servers keep their live connections.',
      'Without server_name: drops every MCP connection, so all servers reconnect fresh on the next use.',
      'Use after mcp_status shows a server in state "degraded"/"unavailable", or right after the user enters missing credentials in the dashboard, so the new env is picked up.',
      'A server shown as "connecting" is not broken: search for its tools with tool_search, which waits for the handshake.',
      'Does NOT change config or write secrets. Safe to call between turns.',
    ].join(' '),
    {
      server_name: z.string().optional().describe('The server to reconnect (its name from mcp_status). Omit to clear every MCP connection.'),
    },
    async ({ server_name }) => {
      const before = server_name ? healthFor(server_name) : null;
      let done: 'reconnected' | 'cleared_all';
      try {
        if (server_name) {
          done = await reconnectConfiguredMcpServer(server_name);
        } else {
          await invalidateConfiguredMcpServers();
          done = 'cleared_all';
        }
      } catch (err) {
        return textResult(`mcp_reconnect: failed to reconnect — ${err instanceof Error ? err.message : String(err)}`);
      }
      return textResult([
        done === 'reconnected'
          ? `Reconnecting "${server_name}" now (prior state: ${before?.state ?? 'unknown'}${before?.lastError ? `; last error: ${before.lastError}` : ''}); other servers were left connected.`
          : 'MCP connections cleared — all servers will reconnect fresh on the next tool call (backoff windows reset).',
        done === 'cleared_all' && server_name ? `Target "${server_name}" prior state: ${before?.state ?? 'unknown'}${before?.lastError ? ` (last error: ${before.lastError})` : ''}.` : '',
        'tool_search waits for the handshake, so search for the tools you need next; mcp_status shows the new state.',
      ].filter(Boolean).join(' '));
    },
  );

  // ── mcp_add (admin: create a server config; NO secret values) ──────────────
  server.tool(
    'mcp_add',
    [
      'Create a NEW external MCP server configuration. APPROVAL-GATED (admin).',
      'Declares the server (name/type/command|url/args/description) and the NAMES of any env/credential keys it needs — but writes NO secret values.',
      'Only the USER enters credential VALUES in Connect → MCP servers. Header auth uses environment references, never literal secret values.',
      'After saving, verifies only this server’s handshake and tool inventory when credentials are present; otherwise returns exact missing key names and the human next step. No vendor operation is executed. Use mcp_configure to edit an existing server.',
    ].join(' '),
    {
      name: z.string().describe('Server name (2-40 chars: letters, digits, _ . -). Must not already exist.'),
      type: z.enum(['stdio', 'http', 'sse']).describe('stdio (local command) | http | sse (remote URL).'),
      command: z.string().optional().describe('Required for stdio (e.g. "npx").'),
      args: z.array(z.string()).optional().describe('Args for a stdio command (e.g. ["-y","some-mcp-server"]).'),
      cwd: z.string().optional().describe('Absolute existing local working directory for a stdio server. Use the authorized project folder; never a shell command or a relative path.'),
      url: z.string().optional().describe('Required for http/sse.'),
      description: z.string().optional().describe('Short human description of what the server provides.'),
      headers: z.record(z.string(), z.string()).optional().describe('Non-secret HTTP header templates, e.g. {"Authorization":"Bearer ${API_KEY}"}. Referenced keys are declared for human entry. Never put a secret value here.'),
      required_env_keys: z.array(z.string()).optional().describe('NAMES of env/credential keys this server needs (e.g. ["DATAFORSEO_USERNAME","DATAFORSEO_PASSWORD"]). Values are entered by the user in the dashboard — never here.'),
    },
    async ({ name, type, command, args, cwd, url, description, headers, required_env_keys }) => {
      const templates = prepareAgentMcpHeaderTemplates(headers, required_env_keys);
      if (!templates.ok) return textResult(`mcp_add refused: ${templates.error}`);
      const existing = loadUserMcpServers();
      const prepared = prepareMcpServerCreateRequest({ name, type, command, args, cwd, url, description,
        headers: templates.headers, env: Object.fromEntries(templates.requiredEnvKeys.map(key => [key, ''])), enabled: true },
      { existingNames: [...Object.keys(existing), ...discoverMcpServers().map(server => server.name)], slugifyName: slugifyServerName });
      if (!prepared.ok) return textResult(`mcp_add refused: ${prepared.error}`);
      const next: Record<string, Partial<ManagedMcpServer>> = {
        ...existing,
        [prepared.server.name]: { ...prepared.server, description: description?.trim() || `${prepared.server.name} MCP server`, source: 'user' },
      };
      saveUserMcpServers(next, { deferIndex: true });
      return finishApprovedSetup(prepared.server.name, 'Created');
    },
  );

  // ── mcp_configure (admin: edit non-secret fields; env writes refused) ──────
  server.tool(
    'mcp_configure',
    [
      'Edit an EXISTING external MCP server\'s NON-SECRET fields (description/command/args/cwd/url/headers/type/enabled). APPROVAL-GATED (admin).',
      'Does NOT set credentials — env/secret values are entered by the user in the dashboard. Passing env here is refused.',
      'Use mcp_add to create a server, mcp_reconnect to recover one.',
    ].join(' '),
    {
      server_name: z.string().describe('Name of the existing server to edit.'),
      description: z.string().optional(),
      type: z.enum(['stdio', 'http', 'sse']).optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      cwd: z.string().nullable().optional().describe('Absolute local working directory for a stdio server. Omit to retain it; null clears the saved directory and restores the default.'),
      url: z.string().optional(),
      enabled: z.boolean().optional().describe('Enable or disable the server.'),
      headers: z.record(z.string(), z.string()).optional().describe('Non-secret HTTP header templates, e.g. {"Authorization":"Bearer ${API_KEY}"}; never literal secrets.'),
      required_env_keys: z.array(z.string()).optional().describe('Additional credential key NAMES to declare for human entry. Never credential values.'),
    },
    async ({ server_name, description, type, command, args, cwd, url, enabled, headers, required_env_keys }) => {
      const existing = loadUserMcpServers();
      const current = existing[server_name];
      if (!current) return textResult(`mcp_configure refused: no server named "${server_name}". Use mcp_status to list servers, or mcp_add to create one.`);
      const templates = prepareAgentMcpHeaderTemplates(headers, required_env_keys);
      if (!templates.ok) return textResult(`mcp_configure refused: ${templates.error}`);
      const merged: Partial<ManagedMcpServer> = {
        ...current,
        ...(description !== undefined ? { description } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(typeof cwd === 'string' ? { cwd } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(templates.headers !== undefined ? { headers: templates.headers } : {}),
        env: declareMcpServerEnvKeys(current.env, templates.requiredEnvKeys),
      };
      if (cwd === null) delete merged.cwd;
      const prepared = prepareMcpServerCreateRequest({ ...merged, name: server_name }, { existingNames: [], slugifyName: slugifyServerName });
      if (!prepared.ok) return textResult(`mcp_configure refused: ${prepared.error}`);
      saveUserMcpServers({ ...existing, [server_name]: { ...merged, ...prepared.server } }, { deferIndex: true });
      return finishApprovedSetup(server_name, 'Updated');
    },
  );
}
