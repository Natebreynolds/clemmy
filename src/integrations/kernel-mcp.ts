/**
 * Kernel's own MCP server, registered when the owner connects Kernel as a
 * cloud browser provider. The first-party cloud browser tools stay the
 * browser of the chat window (they own the ledger, the live view and
 * control); Kernel's tools add what they do not do: computer actions,
 * Playwright, profiles, replays, files, curl through the browser, vaults.
 * The key lives in the server's declared environment like every MCP
 * credential the owner enters on the Connect screen, and reaches Kernel as
 * the Authorization header.
 */
import { loadUserMcpServers, saveUserMcpServers } from '../runtime/mcp-config.js';

export const KERNEL_MCP_SERVER_NAME = 'kernel';
export const KERNEL_MCP_URL = 'https://mcp.onkernel.com/mcp';
export const KERNEL_MCP_ENV_KEY = 'KERNEL_API_KEY';

export interface KernelMcpRegistration {
  registered: boolean;
  /** The server existed with the owner's own settings and was left alone. */
  keptExisting: boolean;
}

export function kernelMcpServerConfig(apiKey: string) {
  return {
    name: KERNEL_MCP_SERVER_NAME,
    type: 'http' as const,
    url: KERNEL_MCP_URL,
    headers: { Authorization: `Bearer \${${KERNEL_MCP_ENV_KEY}}` },
    env: { [KERNEL_MCP_ENV_KEY]: apiKey },
    enabled: true,
    source: 'user' as const,
    description: 'Kernel cloud browsers: sessions, computer actions, Playwright, profiles, replays, files and requests through the browser. '
      + 'The browser in the chat window is the first-party cloud browser (cloud_browser_* tools); use these for what it does not do.',
  };
}

/** Add or refresh the Kernel MCP server with the connected key. A server
 *  of that name the owner configured by hand (another URL) is left alone. */
export function registerKernelMcpServer(apiKey: string, dependencies: {
  load?: typeof loadUserMcpServers; save?: typeof saveUserMcpServers;
} = {}): KernelMcpRegistration {
  const load = dependencies.load ?? loadUserMcpServers;
  const save = dependencies.save ?? saveUserMcpServers;
  const servers = load();
  const existing = servers[KERNEL_MCP_SERVER_NAME];
  if (existing && existing.url && existing.url !== KERNEL_MCP_URL) return { registered: false, keptExisting: true };
  const next = kernelMcpServerConfig(apiKey);
  servers[KERNEL_MCP_SERVER_NAME] = { ...existing, ...next, enabled: existing?.enabled ?? true };
  save(servers);
  return { registered: true, keptExisting: false };
}
