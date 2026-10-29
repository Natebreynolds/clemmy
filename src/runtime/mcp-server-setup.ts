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

const credentialArgument = /(?:--?(?:api[-_]?key|access[-_]?token|token|password|secret|authorization|header)(?:=|$)|\bBearer\s+|\b(?:sk|ghp|xoxb|xoxp)-[A-Za-z0-9])/i;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The privacy policy shared by project setup and cartridge sharing. It reads
 * only the supplied definition, never a credential source or live connection.
 * References remain references; an endpoint or argument is never rewritten. */
export function prepareMcpLaunchPrivacy(input: {
  command?: unknown; args?: unknown; url?: unknown; headers?: unknown; env?: unknown;
  /** Project placeholders are expanded only for judging the argument; the
   * caller still owns its separate path resolution and launch preparation. */
  expandArgument?: (argument: string) => string;
}): { ok: true; headers?: Record<string, string>; requiredEnvKeys: string[] }
  | { ok: false; code: string; error: string } {
  const keys = new Set<string>();
  const privateValues: string[] = [];
  if (input.env !== undefined) {
    if (!isRecord(input.env) || Object.entries(input.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string')) {
      return { ok: false, code: 'unsupported_environment', error: 'Use named environment keys for this server. Enter private values in Connect.' };
    }
    for (const [key, value] of Object.entries(input.env)) {
      keys.add(key);
      if (typeof value === 'string' && value && !/\$\{/.test(value)) privateValues.push(value);
    }
  }
  const launchTexts = [input.command, input.url, ...(Array.isArray(input.args) ? input.args : []), ...Object.values(isRecord(input.headers) ? input.headers : {})];
  if (privateValues.some(value => launchTexts.some(text => typeof text === 'string'
    && (text.includes(value) || text.includes(encodeURIComponent(value)))))) {
    return { ok: false, code: 'private_launch_value', error: 'A launch setting repeats a private environment value. Use a named environment reference and enter its value in Connect.' };
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 128 || input.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || /[\u0000-\u001f\u007f]/.test(arg)))) {
    return { ok: false, code: 'invalid_arguments', error: 'This server has invalid launch arguments. Review its setup.' };
  }
  const args = (input.args as string[] | undefined) ?? [];
  let previousCredentialFlag = false;
  for (const [index, arg] of args.entries()) {
    const expanded = input.expandArgument?.(arg) ?? arg;
    const reference = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(expanded);
    const flagWithReferencedValue = /^--?[A-Za-z_-]+$/.test(expanded)
      && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(args[index + 1] ?? '');
    const privateTemplate = /^(?:--?[A-Za-z_-]+=)?(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(expanded);
    if ((credentialArgument.test(expanded) || previousCredentialFlag) && (!reference || !privateTemplate) && !flagWithReferencedValue) {
      return { ok: false, code: 'private_argument', error: 'A tool argument may contain a private value. Use a named environment reference and enter its value in Connect.' };
    }
    previousCredentialFlag = credentialArgument.test(expanded) && !expanded.includes('=');
    for (const match of expanded.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) keys.add(match[1]!);
    const equal = expanded.indexOf('=');
    const value = equal > 0 && expanded.startsWith('-') ? expanded.slice(equal + 1) : expanded;
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.username || url.password || url.search || url.hash) throw new Error();
      } catch { return { ok: false, code: 'private_argument', error: 'Use a public endpoint without embedded credentials in tool arguments.' }; }
    }
  }
  if (input.headers !== undefined && (!isRecord(input.headers) || Object.values(input.headers).some(value => typeof value !== 'string'))) {
    return { ok: false, code: 'invalid_headers', error: 'Use named environment references for server credentials.' };
  }
  for (const [name, value] of Object.entries(input.headers as Record<string, string> | undefined ?? {})) {
    if (/\$\{/.test(value)) continue;
    const protocol = name.toLowerCase();
    const publicMetadata = protocol === 'accept' ? value.split(',').every(part => ['application/json', 'text/event-stream'].includes(part.trim().toLowerCase()))
      : protocol === 'content-type' ? value.trim().toLowerCase() === 'application/json'
        : protocol === 'mcp-protocol-version' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (!publicMetadata) return { ok: false, code: 'private_header', error: 'A server header needs a named environment reference. Enter its private value in Connect.' };
  }
  const templates = prepareAgentMcpHeaderTemplates(input.headers as Record<string, string> | undefined, [...keys]);
  if (!templates.ok) return { ok: false, code: 'private_header', error: 'A server header needs a named environment reference. Enter its private value in Connect.' };
  if (typeof input.url === 'string') {
    try { const url = new URL(input.url); if (url.username || url.password || url.search || url.hash) throw new Error(); }
    catch { return { ok: false, code: 'private_endpoint', error: 'Use a valid server endpoint without embedded credentials or query values.' }; }
  }
  return templates;
}
