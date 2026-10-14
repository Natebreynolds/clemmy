export interface McpSetupTool { name: string; description?: unknown; inputSchema?: unknown }
export interface McpSetupInventory { tools: McpSetupTool[]; connectionVerified: boolean }
export interface McpSetupReadiness {
  state: 'disabled' | 'needs_credentials' | 'connecting' | 'connected' | 'unavailable';
  unsetEnvKeys: string[];
  toolCount?: number;
  tools?: string[];
  reason?: 'configuration_changed' | 'connection_failed' | 'turn_scope';
}

/** Metadata-only setup observation. A saved definition is not a connection,
 * and an obsolete/partial listing is never a usable tool inventory. */
export async function observeMcpServerSetup(input: {
  enabled: boolean; unsetEnvKeys: string[]; allowed: boolean; serverSlug: string;
  listTools: () => Promise<McpSetupInventory>;
  isCurrent: () => boolean;
  indexTools: (tools: McpSetupTool[]) => void;
  timeoutMs?: number;
}): Promise<McpSetupReadiness> {
  if (!input.enabled) return { state: 'disabled', unsetEnvKeys: input.unsetEnvKeys };
  if (input.unsetEnvKeys.length) return { state: 'needs_credentials', unsetEnvKeys: input.unsetEnvKeys };
  if (!input.allowed) return { state: 'unavailable', unsetEnvKeys: [], reason: 'turn_scope' };
  const pending = Promise.resolve().then(input.listTools).then(({ tools, connectionVerified }) => {
    if (!input.isCurrent()) return { state: 'unavailable' as const, unsetEnvKeys: [], reason: 'configuration_changed' as const };
    if (!connectionVerified) return { state: 'connecting' as const, unsetEnvKeys: [] };
    if (tools.some(tool => tool.name.endsWith('__unavailable') || !tool.name.startsWith(`${input.serverSlug}__`))) {
      return { state: 'unavailable' as const, unsetEnvKeys: [], reason: 'connection_failed' as const };
    }
    try { input.indexTools(tools); } catch { /* Index availability does not falsify the observed connection. */ }
    return { state: 'connected' as const, unsetEnvKeys: [], toolCount: tools.length, tools: tools.slice(0, 8).map(tool => tool.name) };
  }).catch(() => ({ state: 'unavailable' as const, unsetEnvKeys: [], reason: 'connection_failed' as const }));
  // The transport can finish warming after the reply's bounded wait. Its
  // source-stable result is still drained/indexed, never presented as ready early.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<McpSetupReadiness>(resolve => {
      timer = setTimeout(() => resolve({ state: 'connecting', unsetEnvKeys: [] }), Math.max(1, Math.min(input.timeoutMs ?? 10_000, 30_000)));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Agent configuration may name human-entered secrets, never copy their
 * values into headers. Static protocol metadata is separate from auth. */
export function prepareAgentMcpHeaderTemplates(headers: Record<string, string> | undefined, requiredKeys: string[] = []):
  { ok: true; headers?: Record<string, string>; requiredEnvKeys: string[] } | { ok: false; error: string } {
  const keys = new Set(requiredKeys);
  if ([...keys].some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return { ok: false, error: 'Credential declarations must be environment key names only.' };
  for (const [name, value] of Object.entries(headers ?? {})) {
    const reference = /^(?:(?:Bearer|Basic|Token) )?\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (reference) { keys.add(reference[1]!); continue; }
    if (/^(?:accept|content-type|mcp-protocol-version)$/i.test(name) && !value.includes('${')) continue;
    return { ok: false, error: 'Use an environment reference such as ${API_KEY} or Bearer ${API_KEY} for header values. The user enters credential values in Connect → MCP servers.' };
  }
  return { ok: true, ...(headers ? { headers: { ...headers } } : {}), requiredEnvKeys: [...keys] };
}
