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

export function findComposioCli(): string | null {
  const explicit = process.env.COMPOSIO_CLI_PATH?.trim();
  if (explicit && isExecutable(explicit)) return explicit;

  const home = os.homedir();
  const candidates = [
    path.join(home, '.composio', 'composio'),
    path.join(home, '.composio', 'bin', 'composio'),
    path.join(home, '.local', 'bin', 'composio'),
    '/opt/homebrew/bin/composio',
    '/usr/local/bin/composio',
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'composio');
    if (isExecutable(candidate)) return candidate;
  }

  return null;
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

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(binary, args, {
      env: cliEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
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

export async function getComposioCliStatus(options: ComposioCliEnvOptions = {}): Promise<ComposioCliStatus> {
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
