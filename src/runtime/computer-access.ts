import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

/** The owner's choice. 'full': Clem may open any of the owner's files,
 *  including looking at images anywhere in their folders, and setup asked the
 *  OS for the matching access up front. 'standard': images are viewed from
 *  chat attachments only. Credentials, Clem's own stores and off-machine sends
 *  keep their own rules under either. */
export type ComputerAccess = 'full' | 'standard';

/**
 * What Clem can reach on this computer, settled once by the owner instead of
 * mid-task. Clem's own rules come from the owner's choice (Settings, first
 * run). The operating system has its own gates, which no setting here can
 * open: macOS asks per protected folder (Desktop, Documents, Downloads) the
 * first time the app touches one, unless the app holds Full Disk Access, and
 * Windows Controlled Folder Access can silently block writes into protected
 * folders. This module reports those gates and opens the system page that
 * grants them; it never changes a system setting itself.
 */

export type OsGrant = 'granted' | 'not_granted' | 'unknown';
export type FolderGrant = 'allowed' | 'denied' | 'missing' | 'unknown';
export type ControlledFolderMode = 'off' | 'on' | 'audit' | 'unknown';

export interface ComputerAccessStatus {
  choice: ComputerAccess;
  /** False until the owner has chosen (first run or Settings). */
  chosen: boolean;
  platform: 'mac' | 'windows' | 'other';
  mac?: {
    /** Full Disk Access for the app: every protected folder opens without a prompt. */
    fullDiskAccess: OsGrant;
  };
  windows?: {
    /** Defender's Controlled Folder Access: when on, untrusted apps cannot write into protected folders. */
    controlledFolderAccess: ControlledFolderMode;
    /** Whether this app is on its allowed list; null when the list cannot be read. */
    appAllowed: boolean | null;
  };
}

export interface FolderAccessResult {
  label: string;
  folder: string;
  state: FolderGrant;
}

export interface ComputerAccessProbes {
  platform: NodeJS.Platform;
  homedir: string;
  /** Opens a file for reading and closes it; throws the OS error on refusal. */
  openForRead(file: string): void;
  listFolder(folder: string): Promise<unknown>;
  run(command: string, args: readonly string[], timeoutMs: number): Promise<string>;
  /** The executable the OS attributes this app's file access to. */
  appExecutable: string;
}

function runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout));
    });
  });
}

export function systemComputerAccessProbes(): ComputerAccessProbes {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    openForRead: (file) => { closeSync(openSync(file, 'r')); },
    listFolder: (folder) => readdir(folder),
    run: runCommand,
    appExecutable: process.execPath,
  };
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
}

/** Full Disk Access, read without triggering any prompt: the system privacy
 *  database opens only for an app that holds it. */
export function macFullDiskAccess(probes: ComputerAccessProbes): OsGrant {
  const database = path.join(probes.homedir, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
  try {
    probes.openForRead(database);
    return 'granted';
  } catch (error) {
    const code = errorCode(error);
    return code === 'EPERM' || code === 'EACCES' ? 'not_granted' : 'unknown';
  }
}

const CONTROLLED_FOLDER_SCRIPT = [
  '$p = Get-MpPreference',
  '[pscustomobject]@{ mode = [int]$p.EnableControlledFolderAccess; allowed = @($p.ControlledFolderAccessAllowedApplications) } | ConvertTo-Json -Compress',
].join('; ');

/** Read Defender's Controlled Folder Access state from its own report. */
export function parseControlledFolderReport(stdout: string, appExecutable: string): NonNullable<ComputerAccessStatus['windows']> {
  try {
    const parsed = JSON.parse(stdout.trim()) as { mode?: unknown; allowed?: unknown };
    const mode = typeof parsed.mode === 'number' ? parsed.mode : Number.NaN;
    // 0 off; 1 block; 3 block disk modification only; 2 and 4 audit only.
    const controlledFolderAccess: ControlledFolderMode = mode === 0 ? 'off'
      : mode === 1 || mode === 3 ? 'on'
        : mode === 2 || mode === 4 ? 'audit'
          : 'unknown';
    const allowed = Array.isArray(parsed.allowed)
      ? parsed.allowed.filter((entry): entry is string => typeof entry === 'string')
      : null;
    const app = appExecutable.toLowerCase();
    return {
      controlledFolderAccess,
      appAllowed: allowed === null ? null : allowed.some((entry) => entry.toLowerCase() === app),
    };
  } catch {
    return { controlledFolderAccess: 'unknown', appAllowed: null };
  }
}

export async function computerAccessStatus(
  probes: ComputerAccessProbes = systemComputerAccessProbes(),
  stored: { choice: ComputerAccess; chosen: boolean } = storedComputerAccess(),
): Promise<ComputerAccessStatus> {
  const { choice, chosen } = stored;
  if (probes.platform === 'darwin') {
    return { choice, chosen, platform: 'mac', mac: { fullDiskAccess: macFullDiskAccess(probes) } };
  }
  if (probes.platform === 'win32') {
    let windows: NonNullable<ComputerAccessStatus['windows']> = { controlledFolderAccess: 'unknown', appAllowed: null };
    try {
      const stdout = await probes.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CONTROLLED_FOLDER_SCRIPT], 10_000);
      windows = parseControlledFolderReport(stdout, probes.appExecutable);
    } catch { /* Defender absent or its report unreadable: unknown */ }
    return { choice, chosen, platform: 'windows', windows };
  }
  return { choice, chosen, platform: 'other' };
}

/**
 * Ask macOS for the protected folders now, while the owner is looking, so a
 * task never stops on the system's prompt later. Each folder is listed once;
 * an undecided folder shows the system prompt for this app. With Full Disk
 * Access every folder is simply allowed.
 */
export async function requestMacFolderAccess(
  probes: ComputerAccessProbes = systemComputerAccessProbes(),
): Promise<FolderAccessResult[]> {
  if (probes.platform !== 'darwin') return [];
  const folders: Array<[string, string]> = [['Desktop', 'Desktop'], ['Documents', 'Documents'], ['Downloads', 'Downloads']];
  const results: FolderAccessResult[] = [];
  for (const [label, name] of folders) {
    const folder = path.join(probes.homedir, name);
    try {
      await probes.listFolder(folder);
      results.push({ label, folder, state: 'allowed' });
    } catch (error) {
      const code = errorCode(error);
      results.push({
        label,
        folder,
        state: code === 'ENOENT' ? 'missing' : code === 'EPERM' || code === 'EACCES' ? 'denied' : 'unknown',
      });
    }
  }
  return results;
}

/** The system page that grants what Clem cannot grant itself. */
export const SYSTEM_ACCESS_PAGES = {
  full_disk_access: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  controlled_folders: 'windowsdefender://ransomwareprotection',
} as const;
export type SystemAccessPage = keyof typeof SYSTEM_ACCESS_PAGES;

export async function openSystemAccessPage(
  page: SystemAccessPage,
  probes: ComputerAccessProbes = systemComputerAccessProbes(),
): Promise<boolean> {
  const url = SYSTEM_ACCESS_PAGES[page];
  try {
    if (page === 'full_disk_access' && probes.platform === 'darwin') {
      await probes.run('open', [url], 10_000);
      return true;
    }
    if (page === 'controlled_folders' && probes.platform === 'win32') {
      await probes.run('cmd.exe', ['/c', 'start', '', url], 10_000);
      return true;
    }
  } catch { /* the page could not be opened; the caller says where it is */ }
  return false;
}

/** Its own small file, so "not chosen yet" is simply its absence and the
 *  first-run wizard can write it before the daemon exists. */
export function computerAccessFile(): string {
  return path.join(BASE_DIR, 'state', 'computer-access.json');
}

export function storedComputerAccess(): { choice: ComputerAccess; chosen: boolean } {
  try {
    const file = computerAccessFile();
    if (!existsSync(file)) return { choice: 'standard', chosen: false };
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { choice?: unknown };
    return parsed.choice === 'full' || parsed.choice === 'standard'
      ? { choice: parsed.choice, chosen: true }
      : { choice: 'standard', chosen: false };
  } catch {
    return { choice: 'standard', chosen: false };
  }
}

export function setComputerAccessChoice(choice: ComputerAccess): ComputerAccess {
  const next: ComputerAccess = choice === 'full' ? 'full' : 'standard';
  const file = computerAccessFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ choice: next, chosenAt: new Date().toISOString() }, null, 2), 'utf-8');
  renameSync(tmp, file);
  return next;
}

export function computerAccessChoice(): ComputerAccess {
  return storedComputerAccess().choice;
}
