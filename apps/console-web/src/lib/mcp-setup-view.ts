import type { McpServer } from './connect';

/** Connection state is observed separately from whether a server is enabled. */
export function mcpConnectionPresentation(server: Pick<McpServer, 'enabled' | 'state' | 'unsetEnvKeys'>) {
  if (server.enabled === false) return { label: 'Off', tone: 'neutral' as const };
  if (server.unsetEnvKeys?.length) return { label: 'Needs setup', tone: 'warning' as const };
  if (server.state === 'connected') return { label: 'Connected', tone: 'success' as const };
  if (server.state === 'connecting') return { label: 'Connecting', tone: 'warning' as const };
  if (server.state === 'degraded' || server.state === 'unavailable') return { label: 'Connection failed', tone: 'danger' as const };
  return { label: 'Not checked', tone: 'neutral' as const };
}

/** MCP stderr and HTTP errors can contain credentials. Describe recovery without
 * rendering arbitrary server output, URLs, arguments or header values. */
export function mcpConnectionHelp(error?: string): string {
  if (/ENOENT|command not found|executable.*not found|no such file/i.test(error ?? '')) {
    return 'The start command was not found. Install its runtime, or use the full path to the executable in the setup.';
  }
  if (/401|403|unauthori[sz]ed|forbidden|authentication|invalid.*(?:key|token)/i.test(error ?? '')) {
    return 'The server did not accept the connection. Check its credentials and account access, then retry.';
  }
  if (/timeout|timed out|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(error ?? '')) {
    return 'The server did not respond. Check that its command or web address is available, then retry.';
  }
  return 'Clem could not discover this server’s tools. Check the setup and required credentials, then retry.';
}

export function mcpServerNameConflict(name: string, existing: readonly McpServer[]): boolean {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').replace(/_{2,}/g, '_');
  return existing.some((server) => [server.name, server.slug].some((value) => value && slug(value) === slug(name)));
}
