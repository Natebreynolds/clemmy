import path from 'node:path';

/** Windows environment names are case-insensitive, including Path/ProgramFiles. */
export function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

export function isAbsoluteWindowsPath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/i.test(value) && !/[\r\n\0]/.test(value);
}

function roots(env: NodeJS.ProcessEnv): string[] {
  return [windowsEnvValue(env, 'ProgramW6432'), windowsEnvValue(env, 'ProgramFiles') ?? 'C:\\Program Files',
    windowsEnvValue(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)', windowsEnvValue(env, 'LOCALAPPDATA')]
    .filter((value): value is string => Boolean(value && isAbsoluteWindowsPath(value)));
}

function deduplicate(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => { const key = value.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

/** Known installed locations only: never select a PATH shim or launch via a shell. */
export function windowsChromeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return deduplicate(roots(env).map(root => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')));
}

/** Shared by local previews and document PDF rendering; Chrome setup stays Chrome-only. */
export function windowsChromiumCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return deduplicate([
    ...windowsChromeCandidates(env),
    ...roots(env).map(root => path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...roots(env).map(root => path.win32.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
  ]);
}
