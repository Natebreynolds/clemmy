import { validateHeaderName, validateHeaderValue } from 'node:http';
import path from 'node:path';
import type { ManagedMcpServer } from '../types.js';

export type McpServerCreateConfig = Pick<ManagedMcpServer,
  'name' | 'type' | 'enabled' | 'command' | 'args' | 'cwd' | 'url' | 'headers' | 'env'>
  & { description?: string };

export type McpServerCreatePreparation =
  | { ok: true; server: McpServerCreateConfig }
  | { ok: false; status: 400 | 409; code: 'invalid_mcp_server' | 'mcp_server_exists'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/** Configuration syntax only. Directory availability is checked at connection
 * time, on the machine that will actually start the server. Windows paths must
 * include a drive or UNC share: `\\folder` and `C:folder` depend on ambient state. */
export function validateMcpWorkingDirectory(cwd: unknown, type: string,
  platform: NodeJS.Platform = process.platform): string | null {
  if (cwd === undefined) return null;
  if (type !== 'stdio') return 'A working directory is supported only for a local stdio server.';
  if (typeof cwd !== 'string' || !cwd.trim() || /[\u0000-\u001f\u007f]/.test(cwd)) {
    return 'Use a nonempty absolute local working directory without control characters.';
  }
  const absolute = platform === 'win32'
    ? !/^[\\/]{2}[?.][\\/]/.test(cwd) && path.win32.isAbsolute(cwd) && (/^[A-Za-z]:[\\/]/.test(cwd)
      || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(cwd))
    : path.posix.isAbsolute(cwd);
  return absolute ? null : 'Use an absolute working directory for this computer. Project-relative paths must be resolved before setup.';
}

/** Prepare a new definition without changing configuration or starting a server.
 * Credential policy stays with the caller: human input may include values;
 * model-facing tools must separately enforce their reference-only policy. */
export function prepareMcpServerCreateRequest(
  body: unknown,
  options: { existingNames: Iterable<string>; slugifyName: (name: string) => string },
): McpServerCreatePreparation {
  const invalid = (error: string): McpServerCreatePreparation => (
    { ok: false, status: 400, code: 'invalid_mcp_server', error }
  );
  if (!isRecord(body)) return invalid('Send one MCP server configuration as a JSON object.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(name)) {
    return invalid('Use a server name with 2–40 letters, numbers, underscores, dots, or hyphens.');
  }
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    return invalid('This server name is reserved. Choose a different name.');
  }
  const slug = options.slugifyName(name);
  if (slug === 'clementine-local' || [...options.existingNames].some((existing) =>
    existing === name || options.slugifyName(existing) === slug)) {
    return {
      ok: false, status: 409, code: 'mcp_server_exists',
      error: 'A server with this name already exists. Edit the existing server or choose a different name.',
    };
  }
  if (body.type !== undefined && body.type !== 'stdio' && body.type !== 'http' && body.type !== 'sse') {
    return invalid('Choose a supported transport: stdio, http, or sse.');
  }
  const type = body.type ?? 'stdio';
  const cwdError = validateMcpWorkingDirectory(body.cwd, type);
  if (cwdError) return invalid(cwdError);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return invalid('Enabled must be true or false.');
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return invalid('Description must be text.');
  }
  if (body.command !== undefined && (typeof body.command !== 'string' || body.command.includes('\0'))) {
    return invalid('Command must be text without null characters.');
  }
  if (type === 'stdio' && (typeof body.command !== 'string' || !body.command.trim())) {
    return invalid('A stdio server needs an executable command. Put its arguments in the arguments list.');
  }
  if (body.args !== undefined && (!Array.isArray(body.args)
    || !body.args.every((entry) => typeof entry === 'string' && !entry.includes('\0')))) {
    return invalid('Arguments must be a JSON array of strings without null characters.');
  }
  if (body.env !== undefined && (!stringMap(body.env)
    || Object.entries(body.env).some(([key, value]) => !key || /[=\0]/.test(key) || value.includes('\0')))) {
    return invalid('Environment variables must be a JSON object of string values with valid variable names.');
  }
  if (body.headers !== undefined) {
    if (!stringMap(body.headers)) return invalid('Headers must be a JSON object of string values.');
    try {
      for (const [key, value] of Object.entries(body.headers)) {
        validateHeaderName(key);
        validateHeaderValue(key, value);
      }
    } catch {
      return invalid('Headers must use valid HTTP header names and values.');
    }
  }
  if (body.url !== undefined && typeof body.url !== 'string') return invalid('URL must be text.');
  if (type === 'http' || type === 'sse') {
    if (typeof body.url !== 'string') return invalid('An HTTP or SSE server needs an absolute http:// or https:// URL.');
    try {
      const parsed = new URL(body.url);
      if (!/^https?:\/\//i.test(body.url) || !parsed.hostname || !['http:', 'https:'].includes(parsed.protocol)) {
        return invalid('Use an absolute http:// or https:// server URL.');
      }
    } catch {
      return invalid('Use an absolute http:// or https:// server URL.');
    }
  }

  return {
    ok: true,
    server: {
      name,
      type,
      enabled: body.enabled !== false,
      ...(body.description !== undefined ? { description: body.description as string } : {}),
      ...(body.command !== undefined ? { command: body.command as string } : {}),
      ...(body.args !== undefined ? { args: [...body.args as string[]] } : {}),
      ...(body.cwd !== undefined ? { cwd: body.cwd as string } : {}),
      ...(body.url !== undefined ? { url: body.url as string } : {}),
      ...(body.headers !== undefined ? { headers: { ...body.headers as Record<string, string> } } : {}),
      ...(body.env !== undefined ? { env: { ...body.env as Record<string, string> } } : {}),
    },
  };
}

/** Only non-connection metadata is returned; URLs and launch arguments can hold secrets too. */
export function mcpServerCreateSummary(server: McpServerCreateConfig): Pick<McpServerCreateConfig, 'name' | 'type' | 'enabled' | 'description'> {
  return {
    name: server.name,
    type: server.type,
    enabled: server.enabled,
    ...(server.description !== undefined ? { description: server.description } : {}),
  };
}
