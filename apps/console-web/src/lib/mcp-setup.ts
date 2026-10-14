import type { McpServerInput } from './connect';

export type McpSetupResult =
  | { ok: true; servers: McpServerInput[] }
  | { ok: false; error: string };

const SERVER_FIELDS = new Set(['name', 'type', 'description', 'enabled', 'command', 'args', 'url', 'env', 'headers']);
const NAME = /^[A-Za-z0-9_.-]{2,40}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'cmd', 'powershell', 'pwsh']);
const SHELL_ERROR = 'Shell syntax is not supported. Use the server executable directly, or paste MCP JSON with literal arguments and environment values.';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(error: string): McpSetupResult {
  return { ok: false, error };
}

function validName(name: string): boolean {
  return NAME.test(name) && !RESERVED_NAMES.has(name);
}

function shellExecutable(command: string): boolean {
  return SHELLS.has((command.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, ''));
}

/** JSON.parse accepts duplicate keys by discarding earlier values. After syntax
 * validation, inspect only object keys so no server or option is silently lost. */
function duplicateJsonKey(text: string): boolean {
  const stack: Array<{ object: boolean; key: boolean; seen: Set<string> }> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      const start = i;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.object && frame.key) {
        const key = JSON.parse(text.slice(start, i + 1)) as string;
        if (frame.seen.has(key)) return true;
        frame.seen.add(key);
        frame.key = false;
      }
    } else if (char === '{' || char === '[') {
      stack.push({ object: char === '{', key: char === '{', seen: new Set() });
    } else if (char === '}' || char === ']') {
      stack.pop();
    } else if (char === ',' && stack.at(-1)?.object) {
      stack.at(-1)!.key = true;
    }
  }
  return false;
}

/** A deliberately small argv parser, not a shell. Backslashes in Windows paths
 * stay literal; only a backslash immediately escaping whitespace or a quote is
 * interpreted. Expansion, operators and ambiguous quoting require JSON instead. */
function launchTokens(text: string): string[] | null {
  if (/[\r\n\u0000]/.test(text)) return null;
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else token += char;
      continue;
    }
    if (char === '`' || char === '$' || (char === '%' && /^%[A-Za-z_][A-Za-z0-9_]*%/.test(text.slice(i)))) return null;
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && text[i + 1] === '"') { token += '"'; i++; }
      else token += char;
      continue;
    }
    if (/[;&|<>()]/.test(char) || (char === '#' && !started)) return null;
    if (/\s/.test(char)) {
      if (started) { tokens.push(token); token = ''; started = false; }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && text[i + 1] !== undefined && /[\s'"]/.test(text[i + 1]!)) {
      token += text[++i]!;
      started = true;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) tokens.push(token);
  return tokens;
}

function parseServer(raw: unknown, named?: string): McpServerInput | string {
  if (!record(raw)) return 'Each server must be a JSON object.';
  if (Object.keys(raw).some((key) => !SERVER_FIELDS.has(key))) {
    return 'This setup includes unsupported settings. Use only name, type, command, args, env, url, headers, description and enabled; working-directory and authentication options need a supported setup first.';
  }
  if ('name' in raw && typeof raw.name !== 'string') return 'The server name must be text.';
  const supplied = typeof raw.name === 'string' ? raw.name.trim() : undefined;
  const name = named?.trim() ?? supplied;
  if (!name || !validName(name)) return 'Give each server a name using 2–40 letters, numbers, dots, underscores or hyphens.';
  if (supplied !== undefined && supplied !== name) return 'The server has conflicting names. Keep one name for this setup.';
  if ('description' in raw && typeof raw.description !== 'string') return 'The description must be text.';
  if ('enabled' in raw && typeof raw.enabled !== 'boolean') return 'Enabled must be true or false.';
  if ('type' in raw && raw.type !== 'stdio' && raw.type !== 'http' && raw.type !== 'sse') {
    return 'Choose a supported server type: stdio, http or sse.';
  }
  if ('command' in raw && (typeof raw.command !== 'string' || !raw.command.trim() || /[\u0000-\u001f\u007f]/.test(raw.command))) {
    return 'The local executable must be nonempty text without control characters.';
  }
  if ('args' in raw && (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== 'string' || arg.includes('\u0000')))) {
    return 'Arguments must be a JSON array of strings without NUL characters.';
  }
  if ('env' in raw && (!record(raw.env) || Object.entries(raw.env).some(([key, value]) => !ENV_KEY.test(key) || typeof value !== 'string' || value.includes('\u0000')))) {
    return 'Environment variables must be an object with valid variable names and string values.';
  }
  if ('headers' in raw) {
    if (!record(raw.headers)) return 'Headers must be an object with string values.';
    const lowerNames = new Set<string>();
    for (const [key, value] of Object.entries(raw.headers)) {
      const lower = key.toLowerCase();
      if (!HEADER_NAME.test(key) || typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || lowerNames.has(lower)) {
        return 'Headers need unique valid names and text values without control characters.';
      }
      lowerNames.add(lower);
    }
  }

  const type = raw.type ?? ('url' in raw ? 'http' : 'stdio');
  const result: McpServerInput = { name, type: type as McpServerInput['type'] };
  if ('description' in raw) result.description = raw.description as string;
  if ('enabled' in raw) result.enabled = raw.enabled as boolean;
  if ('env' in raw) result.env = { ...raw.env as Record<string, string> };
  if (type === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) return 'A local server needs its executable in command.';
    if ('url' in raw || 'headers' in raw) return 'A local server uses command, args and env. Remote URL and headers cannot be mixed into it.';
    const command = raw.command.trim();
    if (shellExecutable(command)) return SHELL_ERROR;
    result.command = command;
    if ('args' in raw) result.args = [...raw.args as string[]];
  } else {
    if ('command' in raw || 'args' in raw) return 'A remote server uses a URL. Remove local command and arguments.';
    if (typeof raw.url !== 'string' || !/^https?:\/\//i.test(raw.url) || /[\\\s\u0000-\u001f\u007f]/.test(raw.url)) {
      return 'A remote server needs a valid http:// or https:// URL without spaces or control characters.';
    }
    try {
      const url = new URL(raw.url);
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) {
        return 'Use an http:// or https:// URL. Put credentials in supported headers instead of the URL.';
      }
    } catch { return 'A remote server needs a valid http:// or https:// URL.'; }
    result.url = raw.url;
    if ('headers' in raw) result.headers = { ...raw.headers as Record<string, string> };
  }
  return result;
}

/** Parse only. This never executes a command, expands variables, contacts a
 * server, reads a file or saves credentials. Error text never echoes input. */
export function parseMcpSetup(text: string, optionalName?: string): McpSetupResult {
  const input = text.trim();
  if (!input) return invalid('Paste an MCP JSON setup or a local server launch command.');
  if (input.length > 100_000) return invalid('This setup is too large. Paste a smaller server configuration.');
  if (!input.startsWith('{') && !input.startsWith('[')) {
    if (!optionalName?.trim() || !validName(optionalName.trim())) return invalid('Give the local server a name using 2–40 letters, numbers, dots, underscores or hyphens.');
    const tokens = launchTokens(input);
    if (!tokens || !tokens[0] || tokens[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || shellExecutable(tokens[0])) return invalid(SHELL_ERROR);
    return { ok: true, servers: [{ name: optionalName.trim(), type: 'stdio', command: tokens[0], args: tokens.slice(1) }] };
  }

  let parsed: unknown;
  try { parsed = JSON.parse(input); }
  catch { return invalid('This is not valid JSON. Check quotes, commas and brackets, then try again.'); }
  if (duplicateJsonKey(input)) return invalid('The JSON repeats a server name or setting. Keep one value for each name before adding it.');
  if (!record(parsed)) return invalid('Paste an MCP server object or an object containing mcpServers.');
  let entries: Array<[string | undefined, unknown]>;
  if ('mcpServers' in parsed) {
    if (Object.keys(parsed).length !== 1 || !record(parsed.mcpServers)) return invalid('The JSON wrapper must contain only an mcpServers object.');
    entries = Object.entries(parsed.mcpServers);
  } else if (Object.values(parsed).length > 0 && Object.values(parsed).every(record)) {
    entries = Object.entries(parsed);
  } else {
    entries = [[optionalName, parsed]];
  }
  if (entries.length === 0 || entries.length > 32) return invalid('Paste between 1 and 32 server setups at a time.');
  const servers: McpServerInput[] = [];
  const names = new Set<string>();
  for (const [name, raw] of entries) {
    const next = parseServer(raw, name);
    if (typeof next === 'string') return invalid(next);
    if (names.has(next.name)) return invalid('The setup repeats a server name. Give each server a different name.');
    names.add(next.name);
    servers.push(next);
  }
  return { ok: true, servers };
}
