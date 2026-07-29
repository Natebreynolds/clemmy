import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 6_000;

export interface ComposioCliEnvOptions {
  apiKey?: string;
  userId?: string;
}

export interface ComposioCliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  authenticated: boolean;
  authStatus: 'ok' | 'missing' | 'error' | 'unknown';
  authMessage: string | null;
}

export interface ComposioCliRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export class ComposioCliError extends Error {
  constructor(
    message: string,
    readonly result: ComposioCliRunResult,
  ) {
    super(message);
    this.name = 'ComposioCliError';
  }
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ComposioCliDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Test seam for probing candidate paths without changing the host platform. */
  isExecutable?: (filePath: string) => boolean;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? env[match] : undefined;
}

const WINDOWS_SPAWN_SUPPORTED_EXTENSIONS =
  new Set(['.COM', '.EXE', '.CMD', '.BAT', '.JS', '.CJS', '.MJS']);

function safeWindowsExecutableExtensions(raw: string | undefined): string[] {
  const fallback = ['.COM', '.EXE', '.CMD', '.BAT'];
  const parsed = (raw ?? fallback.join(';'))
    .split(';')
    .map((entry) => entry.trim())
    // PATHEXT is metadata, never a path: reject separators, traversal, globs,
    // and shell syntax before turning any entry into a filesystem probe. Also
    // admit only formats composioCliSpawnSpec can launch without guessing an
    // interpreter from the host's file association.
    .filter((entry) =>
      /^\.[A-Za-z0-9]{1,10}$/.test(entry)
      && WINDOWS_SPAWN_SUPPORTED_EXTENSIONS.has(entry.toUpperCase()));
  const source = parsed.length > 0 ? parsed : fallback;
  const seen = new Set<string>();
  return source.filter((entry) => {
    const key = entry.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function findComposioCli(options: ComposioCliDiscoveryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? os.homedir();
  const check = options.isExecutable ?? isExecutable;
  const pathFlavor = platform === 'win32' ? path.win32 : path;
  const pathDelimiter = platform === 'win32' ? ';' : path.delimiter;
  const executableExtensions = platform === 'win32'
    ? safeWindowsExecutableExtensions(envValue(env, 'PATHEXT'))
    : [];
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (basePath: string): void => {
    const base = stripMatchingQuotes(basePath);
    if (!base) return;
    const extension = pathFlavor.extname(base);
    // COMPOSIO_CLI_PATH is user-controlled and bypasses PATHEXT expansion.
    // Refuse Windows script/file types the spawn adapter cannot launch
    // deterministically instead of delegating to mutable file associations.
    if (
      platform === 'win32'
      && extension
      && !WINDOWS_SPAWN_SUPPORTED_EXTENSIONS.has(extension.toUpperCase())
    ) return;
    const variants =
      platform === 'win32' && !extension
        ? [base, ...executableExtensions.map((extension) => `${base}${extension}`)]
        : [base];
    for (const candidate of variants) {
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  };

  const explicit = envValue(env, 'COMPOSIO_CLI_PATH');
  if (explicit?.trim()) addCandidate(explicit);

  addCandidate(pathFlavor.join(home, '.composio', 'composio'));
  addCandidate(pathFlavor.join(home, '.composio', 'bin', 'composio'));
  addCandidate(pathFlavor.join(home, '.local', 'bin', 'composio'));
  if (platform !== 'win32') {
    addCandidate('/opt/homebrew/bin/composio');
    addCandidate('/usr/local/bin/composio');
  }

  const pathDirs = (envValue(env, 'PATH') ?? '')
    .split(pathDelimiter)
    .map(stripMatchingQuotes)
    .filter(Boolean);
  for (const dir of pathDirs) addCandidate(pathFlavor.join(dir, 'composio'));

  return candidates.find((candidate) => check(candidate)) ?? null;
}

export interface ComposioCliSpawnOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface ComposioCliSpawnSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const WINDOWS_CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

function assertWindowsCmdToken(value: string): void {
  if (/[\0\r\n]/.test(value)) {
    throw new Error('Windows cmd/bat arguments cannot contain NUL bytes or line breaks.');
  }
}

function escapeWindowsCmdCommand(value: string): string {
  assertWindowsCmdToken(value);
  return value.replace(WINDOWS_CMD_META_RE, '^$1');
}

function escapeWindowsCmdArgument(value: string, doubleEscapeMetaChars: boolean): string {
  assertWindowsCmdToken(value);

  // Quote using the Windows C-runtime rules first: backslashes before a quote
  // are doubled and the quote is escaped; trailing backslashes are doubled so
  // they cannot consume the closing quote.
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    quoted += `${'\\'.repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  quoted += `${'\\'.repeat(backslashes * 2)}"`;

  // Then neutralize cmd.exe metacharacters. A node_modules/.bin cmd-shim
  // performs a second parse while forwarding %*, so those shims need the same
  // escaping twice. This is the same boundary used by mature Windows spawn
  // adapters, but kept local so Composio does not rely on a transitive package.
  let escaped = quoted.replace(WINDOWS_CMD_META_RE, '^$1');
  if (doubleEscapeMetaChars) escaped = escaped.replace(WINDOWS_CMD_META_RE, '^$1');
  return escaped;
}

export function composioCliSpawnSpec(
  binary: string,
  args: readonly string[],
  options: ComposioCliSpawnOptions = {},
): ComposioCliSpawnSpec {
  // Node adapters are a byte-preserving cross-platform CLI boundary. Windows
  // batch files require shell parsing, which can reinterpret JSON payload
  // characters; an explicit JS adapter runs through this exact Node binary.
  if (/\.(?:cjs|mjs|js)$/i.test(binary)) {
    return { command: process.execPath, args: [binary, ...args] };
  }
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary)) {
    const env = options.env ?? process.env;
    const command = path.win32.normalize(binary);
    const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.(?:cmd|bat)$/i.test(command);
    const shellCommand = [
      escapeWindowsCmdCommand(command),
      ...args.map((arg) => escapeWindowsCmdArgument(String(arg), doubleEscape)),
    ].join(' ');
    const comspec = stripMatchingQuotes(envValue(env, 'ComSpec') ?? 'cmd.exe');
    return {
      command: comspec || 'cmd.exe',
      args: ['/d', '/s', '/v:off', '/c', `"${shellCommand}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: binary, args: [...args] };
}

function cliEnv(options: ComposioCliEnvOptions = {}): NodeJS.ProcessEnv {
  const homeComposio = path.join(os.homedir(), '.composio');
  const existingPath = process.env.PATH ?? '';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [homeComposio, path.join(homeComposio, 'bin'), existingPath].filter(Boolean).join(path.delimiter),
    COMPOSIO_DISABLE_TELEMETRY: process.env.COMPOSIO_DISABLE_TELEMETRY ?? 'true',
  };
  if (options.apiKey) env.COMPOSIO_API_KEY = options.apiKey;
  if (options.userId) env.COMPOSIO_USER_ID = options.userId;
  return env;
}

function cleanComposioCliOutput(text: string): string {
  return text
    .split(/\r?\n/g)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed &&
        !trimmed.startsWith('Update available:') &&
        trimmed !== 'Run composio upgrade to update';
    })
    .join('\n')
    .trim();
}

function compactOutput(stdout: string, stderr: string): string {
  const text = cleanComposioCliOutput([stdout, stderr].filter(Boolean).join('\n'));
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

export function runComposioCli(
  args: string[],
  options: ComposioCliEnvOptions & { timeoutMs?: number } = {},
): Promise<ComposioCliRunResult> {
  const binary = findComposioCli();
  if (!binary) {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: 'Composio CLI is not installed.',
      exitCode: null,
      timedOut: false,
    });
  }

  let spec: ComposioCliSpawnSpec;
  try {
    spec = composioCliSpawnSpec(binary, args);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
      timedOut: false,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(spec.command, spec.args, {
      env: cliEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve({
        ok: false,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8') || `Composio CLI timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
        exitCode: null,
        timedOut: true,
      });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: error.message,
        exitCode: null,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        exitCode: code,
        timedOut: false,
      });
    });
  });
}

export function parseComposioCliJson(text: string): unknown {
  const trimmed = cleanComposioCliOutput(text);
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = Math.min(
      ...[trimmed.indexOf('{'), trimmed.indexOf('[')].filter((index) => index >= 0),
    );
    if (!Number.isFinite(start)) return trimmed;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return trimmed;
    }
  }
}

// E3: status probing spawns two subprocesses (--version + whoami). On the 'auto'
// backend that happens per execute for a CLI-installed-but-unauthenticated user,
// so memoize briefly. TTL is short enough that a fresh `composio login` is picked
// up within a minute; busted explicitly on backend save / client reset.
const CLI_STATUS_TTL_MS = 45_000;
let cliStatusCache: { key: string; at: number; value: Promise<ComposioCliStatus> } | null = null;

export function invalidateComposioCliStatusCache(): void {
  cliStatusCache = null;
}

/** Auth-dead bench (2026-07-24): once a live probe PROVES the CLI session is
 *  rejecting calls at auth, AUTO stops routing through it entirely — the SDK
 *  (where the user's connections actually live) becomes the lane until the
 *  bench expires or a real re-login is detected. Prevents every subsequent
 *  mutation from re-failing into the dead lane first. */
let cliAuthBenchedUntil = 0;
const CLI_AUTH_BENCH_MS = 15 * 60_000;
export function benchComposioCliAuth(): void {
  cliAuthBenchedUntil = Date.now() + CLI_AUTH_BENCH_MS;
  cliStatusCache = null; // the cached "authenticated" claim is proven false
}
export function _resetComposioCliBenchForTests(): void { cliAuthBenchedUntil = 0; }

export async function getComposioCliStatus(options: ComposioCliEnvOptions = {}): Promise<ComposioCliStatus> {
  if (Date.now() < cliAuthBenchedUntil) {
    return {
      installed: true,
      authenticated: false,
      authStatus: 'error',
      authMessage: 'Composio CLI session was proven auth-dead by a live probe — using the SDK backend until it recovers (run composio login to restore the CLI lane).',
    } as ComposioCliStatus;
  }
  const key = JSON.stringify([options.apiKey ?? '', options.userId ?? '']);
  const now = Date.now();
  if (cliStatusCache && cliStatusCache.key === key && now - cliStatusCache.at <= CLI_STATUS_TTL_MS) {
    return cliStatusCache.value;
  }
  const value = fetchComposioCliStatus(options);
  cliStatusCache = { key, at: now, value };
  try {
    return await value;
  } catch (err) {
    // Never cache a rejection.
    if (cliStatusCache?.value === value) cliStatusCache = null;
    throw err;
  }
}

async function fetchComposioCliStatus(options: ComposioCliEnvOptions = {}): Promise<ComposioCliStatus> {
  const binary = findComposioCli();
  if (!binary) {
    return {
      installed: false,
      path: null,
      version: null,
      authenticated: false,
      authStatus: 'missing',
      authMessage: 'Install with: curl -fsSL https://composio.dev/install | bash',
    };
  }

  const versionResult = await runComposioCli(['--version'], { ...options, timeoutMs: STATUS_TIMEOUT_MS });
  const whoami = await runComposioCli(['whoami'], { ...options, timeoutMs: STATUS_TIMEOUT_MS });
  const authText = compactOutput(whoami.stdout, whoami.stderr);
  const authenticated = whoami.ok && Boolean(authText);
  return {
    installed: true,
    path: binary,
    version: compactOutput(versionResult.stdout, versionResult.stderr) || null,
    authenticated,
    authStatus: authenticated ? 'ok' : (whoami.ok ? 'unknown' : 'error'),
    authMessage: authenticated ? authText : authText || 'Run composio login to enable CLI execution, or keep AUTO/SDK fallback.',
  };
}

/** LIVE CLI auth-death probe (2026-07-24 Slack-send 401 incident): a CLI
 * mutation failed 401-shaped in AUTO, but auth text alone must never prove
 * no-dispatch (it leaks into post-dispatch errors). This probe makes it
 * STRUCTURAL: run an independent, harmless READ through the same CLI session
 * — if that read ALSO fails 401/unauthorized, the CLI lane's auth is dead,
 * meaning the original request was rejected at authentication and nothing
 * dispatched. Cheap, bounded, and only invoked on a 401-shaped failure. */
export async function composioCliAuthDead(options: ComposioCliEnvOptions = {}): Promise<boolean> {
  try {
    const result = await runComposioCli(
      ['execute', 'COMPOSIO_LIST_TOOLKITS', '-d', '{}'],
      { ...options, timeoutMs: STATUS_TIMEOUT_MS },
    );
    if (result.ok) return false;
    return /\b401\b|unauthorized/i.test(compactOutput(result.stdout, result.stderr));
  } catch (err) {
    return /\b401\b|unauthorized/i.test(String(err));
  }
}

export async function executeComposioCliTool(
  toolSlug: string,
  args: Record<string, unknown>,
  options: ComposioCliEnvOptions = {},
): Promise<unknown> {
  const result = await runComposioCli(
    ['execute', toolSlug, '-d', JSON.stringify(args)],
    { ...options, timeoutMs: DEFAULT_TIMEOUT_MS },
  );
  if (!result.ok) {
    throw new ComposioCliError(
      `Composio CLI execute failed for ${toolSlug}: ${compactOutput(result.stdout, result.stderr)}`,
      result,
    );
  }
  const output = cleanComposioCliOutput([result.stdout, result.stderr].filter(Boolean).join('\n'));
  if (!output) {
    throw new ComposioCliError(
      `Composio CLI execute produced no output for ${toolSlug}; run composio login or use the SDK backend.`,
      result,
    );
  }
  return parseComposioCliJson(output);
}

export async function searchComposioCliTools(
  query: string,
  options: ComposioCliEnvOptions & { toolkitSlug?: string; limit?: number } = {},
): Promise<unknown> {
  const args = ['search', query];
  if (options.toolkitSlug) args.push('--toolkits', options.toolkitSlug);
  if (options.limit) args.push('--limit', String(options.limit));
  const result = await runComposioCli(args, { ...options, timeoutMs: 30_000 });
  if (!result.ok) {
    throw new ComposioCliError(
      `Composio CLI search failed: ${compactOutput(result.stdout, result.stderr)}`,
      result,
    );
  }
  const output = cleanComposioCliOutput([result.stdout, result.stderr].filter(Boolean).join('\n'));
  if (!output) {
    throw new ComposioCliError(
      'Composio CLI search produced no output; run composio login or use the SDK backend.',
      result,
    );
  }
  return parseComposioCliJson(output);
}
