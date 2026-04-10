import path from 'node:path';
import { existsSync } from 'node:fs';
import { MCPServerSSE, MCPServerStdio, MCPServerStreamableHttp, type MCPServer } from '@openai/agents';
import { BASE_DIR, LOCAL_MCP_ENABLED, PKG_DIR } from '../config.js';
import { discoverMcpServers } from './mcp-config.js';
import type { ManagedMcpServer } from '../types.js';

function createLocalServer(): MCPServerStdio | null {
  if (!LOCAL_MCP_ENABLED) return null;

  const distEntry = path.join(PKG_DIR, 'dist', 'tools', 'mcp-server.js');
  const srcEntry = path.join(PKG_DIR, 'src', 'tools', 'mcp-server.ts');

  if (existsSync(distEntry)) {
    return new MCPServerStdio({
      name: 'clementine-local',
      command: 'node',
      args: [distEntry],
      env: {
        CLEMENTINE_HOME: BASE_DIR,
      },
      cwd: BASE_DIR,
    });
  }

  return new MCPServerStdio({
    name: 'clementine-local',
    command: 'npx',
    args: ['tsx', srcEntry],
    env: {
      CLEMENTINE_HOME: BASE_DIR,
    },
    cwd: PKG_DIR,
  });
}

function createExternalServer(server: ManagedMcpServer): MCPServer | null {
  if (!server.enabled) return null;

  if (server.type === 'stdio' && server.command) {
    return new MCPServerStdio({
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
      cwd: BASE_DIR,
    });
  }

  if (server.type === 'http' && server.url) {
    return new MCPServerStreamableHttp({
      name: server.name,
      url: server.url,
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
  }

  if (server.type === 'sse' && server.url) {
    return new MCPServerSSE({
      name: server.name,
      url: server.url,
      eventSourceInit: server.headers ? { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, headers: server.headers }) } : undefined,
    });
  }

  return null;
}

export function createConfiguredMcpServers(): MCPServer[] {
  const servers: MCPServer[] = [];
  const local = createLocalServer();
  if (local) servers.push(local);

  for (const config of discoverMcpServers()) {
    const server = createExternalServer(config);
    if (server) servers.push(server);
  }

  return servers;
}
