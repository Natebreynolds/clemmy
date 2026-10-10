import { execFile } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The first-run wizard's view of the operating system's own file gates, read
 * in the app itself because the daemon is not running yet. Mirrors
 * src/runtime/computer-access.ts: it reports and opens the system page that
 * grants access; it never changes a system setting itself.
 */

export interface SetupAccessStatus {
  platform: 'mac' | 'windows' | 'other';
  fullDiskAccess?: 'granted' | 'not_granted' | 'unknown';
  controlledFolderAccess?: 'off' | 'on' | 'audit' | 'unknown';
  appAllowed?: boolean | null;
}

export interface SetupFolderResult {
  label: string;
  state: 'allowed' | 'denied' | 'missing' | 'unknown';
}

const SYSTEM_PAGES = {
  full_disk_access: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  controlled_folders: 'windowsdefender://ransomwareprotection',
} as const;
export type SetupAccessPage = keyof typeof SYSTEM_PAGES;

function code(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : '';
}

function run(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout));
    });
  });
}

/** Full Disk Access, read without any prompt: the system privacy database
 *  opens only for an app that holds it. */
export function macFullDiskAccess(home: string = os.homedir(), open: (file: string) => void = (file) => closeSync(openSync(file, 'r'))): 'granted' | 'not_granted' | 'unknown' {
  try {
    open(path.join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'));
    return 'granted';
  } catch (error) {
    const found = code(error);
    return found === 'EPERM' || found === 'EACCES' ? 'not_granted' : 'unknown';
  }
}

export function parseControlledFolderReport(stdout: string, appExecutable: string): Pick<SetupAccessStatus, 'controlledFolderAccess' | 'appAllowed'> {
  try {
    const parsed = JSON.parse(stdout.trim()) as { mode?: unknown; allowed?: unknown };
    const mode = typeof parsed.mode === 'number' ? parsed.mode : Number.NaN;
    const allowed = Array.isArray(parsed.allowed) ? parsed.allowed.filter((entry): entry is string => typeof entry === 'string') : null;
    return {
      controlledFolderAccess: mode === 0 ? 'off' : mode === 1 || mode === 3 ? 'on' : mode === 2 || mode === 4 ? 'audit' : 'unknown',
      appAllowed: allowed === null ? null : allowed.some((entry) => entry.toLowerCase() === appExecutable.toLowerCase()),
    };
  } catch {
    return { controlledFolderAccess: 'unknown', appAllowed: null };
  }
}

export async function setupAccessStatus(platform: NodeJS.Platform = process.platform): Promise<SetupAccessStatus> {
  if (platform === 'darwin') return { platform: 'mac', fullDiskAccess: macFullDiskAccess() };
  if (platform === 'win32') {
    try {
      const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$p = Get-MpPreference; [pscustomobject]@{ mode = [int]$p.EnableControlledFolderAccess; allowed = @($p.ControlledFolderAccessAllowedApplications) } | ConvertTo-Json -Compress'], 10_000);
      return { platform: 'windows', ...parseControlledFolderReport(stdout, process.execPath) };
    } catch {
      return { platform: 'windows', controlledFolderAccess: 'unknown', appAllowed: null };
    }
  }
  return { platform: 'other' };
}

/** Ask macOS for Desktop, Documents and Downloads now, while the owner is
 *  looking: an undecided folder shows the system prompt for this app. */
export async function requestSetupFolders(home: string = os.homedir(), list: (folder: string) => Promise<unknown> = (folder) => readdir(folder)): Promise<SetupFolderResult[]> {
  const out: SetupFolderResult[] = [];
  for (const label of ['Desktop', 'Documents', 'Downloads']) {
    try {
      await list(path.join(home, label));
      out.push({ label, state: 'allowed' });
    } catch (error) {
      const found = code(error);
      out.push({ label, state: found === 'ENOENT' ? 'missing' : found === 'EPERM' || found === 'EACCES' ? 'denied' : 'unknown' });
    }
  }
  return out;
}

export function setupAccessPageUrl(page: SetupAccessPage): string {
  return SYSTEM_PAGES[page];
}
