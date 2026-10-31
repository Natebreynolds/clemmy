/**
 * A key the owner can type into Clem's question, never into the chat.
 *
 * When Clem asks a question in a request that worked with an MCP server still
 * missing a declared key, the host attaches that server and the missing key
 * names to her question. The owner's card shows a hidden field for each; the
 * value goes through the same credential route as Connect → MCP servers
 * (declared keys only, written to Clem's environment file, server
 * reconnected) and never into the transcript, the model or memory. Clem's
 * words stay her own: this is a host-observed dependency, like the Connect
 * button on a connection question, read from the request's own tool calls and
 * never from what she wrote.
 */
import { discoverMcpServers } from '../mcp-config.js';
import { serverEnvStatus } from '../../tools/mcp-server-tools.js';
import { listEvents } from './eventlog.js';
import type { McpKeyRequest } from './mcp-key-request-shape.js';

export type { McpKeyRequest };

/** Tools that name the server they configure in their arguments. */
const SERVER_ARGUMENT: Readonly<Record<string, string>> = {
  mcp_add: 'name',
  mcp_configure: 'name',
  mcp_reconnect: 'server_name',
};

function argumentsOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Server names, lower-cased, this request's own tool calls worked with, and
 *  whether it read every server's status (which names each missing key). */
export function mcpServersTouchedBySource(input: { sessionId: string; sourceUserSeq: number }): { touched: Set<string>; statusRead: boolean } {
  const touched = new Set<string>();
  let statusRead = false;
  for (const event of listEvents(input.sessionId, { types: ['tool_called'], sinceSeq: input.sourceUserSeq })) {
    if (event.data.sourceUserSeq !== input.sourceUserSeq) continue;
    for (const raw of [event.data.tool, event.data.innerTool]) {
      if (typeof raw !== 'string') continue;
      if (raw === 'mcp_status') statusRead = true;
      const separator = raw.indexOf('__');
      if (separator > 0) touched.add(raw.slice(0, separator).toLowerCase());
      const argument = SERVER_ARGUMENT[raw];
      const named = argument ? argumentsOf(event.data.args)[argument] : undefined;
      if (typeof named === 'string' && named.trim()) touched.add(named.trim().toLowerCase());
    }
  }
  return { touched, statusRead };
}

/** The one server this request worked with, or whose missing key its status
 *  read showed, that still needs keys the owner can enter; null when none
 *  does, or when several do (the question cannot say which). Live: Clem read
 *  the status, saw the missing key and asked the owner to paste it in chat. */
export function observedMcpKeyRequestForSource(input: { sessionId: string; sourceUserSeq: number }): McpKeyRequest | null {
  try {
    const { touched, statusRead } = mcpServersTouchedBySource(input);
    if (touched.size === 0 && !statusRead) return null;
    const needing = discoverMcpServers()
      .filter((server) => (statusRead || touched.has(server.name.toLowerCase())) && server.enabled !== false)
      .map((server) => {
        const status = serverEnvStatus(server);
        return { server: server.name, keys: status.unsetEnvKeys.filter((key) => status.editableEnvKeys.includes(key)) };
      })
      .filter((request) => request.keys.length > 0);
    return needing.length === 1 ? needing[0]! : null;
  } catch { return null; }
}
