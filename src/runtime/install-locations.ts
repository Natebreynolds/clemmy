/**
 * Where an install may write on this machine, read before anything runs.
 *
 * On a managed computer the owner is often not an administrator: the
 * Applications folder, /usr/local/bin and sometimes the package manager's
 * own tree belong to someone else. An install that needs one of them fails
 * halfway with a vendor's error. This module reads the writable places
 * once, decides up front what an install needs, redirects it to the owner's
 * own folders when the tool allows that, and otherwise says in plain words
 * that an administrator has to run it once, with the exact command.
 */
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type InstallPlace = 'applications' | 'usr_local_bin' | 'npm_prefix' | 'homebrew';

export interface InstallPlaces {
  home: string;
  /** The system Applications folder is writable by this account. */
  applications: boolean;
  usrLocalBin: boolean;
  npmPrefix: { path: string; writable: boolean };
  homebrew: { path: string; writable: boolean } | null;
}

export function canWrite(dir: string): boolean {
  let probe = dir;
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  try { accessSync(probe, constants.W_OK); return true; } catch { return false; }
}

export function readInstallPlaces(input: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {}): InstallPlaces {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? os.homedir();
  const npmPrefix = env.npm_config_prefix
    || (env.NVM_BIN ? path.dirname(env.NVM_BIN) : null)
    || (existsSync('/opt/homebrew/bin/npm') ? '/opt/homebrew' : '/usr/local');
  const brewPrefix = platform === 'darwin'
    ? (existsSync('/opt/homebrew/bin/brew') ? '/opt/homebrew' : existsSync('/usr/local/bin/brew') ? '/usr/local' : null)
    : (existsSync('/home/linuxbrew/.linuxbrew/bin/brew') ? '/home/linuxbrew/.linuxbrew' : null);
  return {
    home,
    applications: platform === 'darwin' ? canWrite('/Applications') : true,
    usrLocalBin: platform === 'win32' ? true : canWrite('/usr/local/bin'),
    npmPrefix: { path: npmPrefix, writable: canWrite(path.join(npmPrefix, 'lib', 'node_modules')) },
    homebrew: brewPrefix ? { path: brewPrefix, writable: canWrite(path.join(brewPrefix, 'Cellar')) } : null,
  };
}

export type InstallPreflight =
  | { ok: true; env: Record<string, string>; note: string | null }
  | { ok: false; place: InstallPlace; reason: string; adminCommand: string };

const PLACE_WORDS: Record<InstallPlace, string> = {
  applications: 'the Applications folder',
  usr_local_bin: '/usr/local/bin',
  npm_prefix: "npm's global folder",
  homebrew: "Homebrew's folder",
};

/** What a command form needs beyond the owner's home, from the form itself. */
export function installNeedsFor(command: string): InstallPlace[] {
  const lower = command.toLowerCase();
  const needs: InstallPlace[] = [];
  if (/^brew install --cask\b/.test(lower)) needs.push('applications', 'homebrew');
  else if (/^brew\b/.test(lower)) needs.push('homebrew');
  if (/^npm (install|i) (-g|--global)\b/.test(lower)) needs.push('npm_prefix');
  return needs;
}

/**
 * Decide before running. A need the account cannot meet is redirected into
 * the owner's own folders when the tool supports that (Homebrew casks into
 * ~/Applications, npm globals into ~/.local); otherwise the install is
 * blocked with the words and the command an administrator needs.
 */
export function installPreflight(input: {
  command: string;
  needs?: InstallPlace[];
  places?: InstallPlaces;
  platform?: NodeJS.Platform;
}): InstallPreflight {
  const platform = input.platform ?? process.platform;
  if (platform === 'win32') return { ok: true, env: {}, note: null };
  const places = input.places ?? readInstallPlaces({ platform });
  const needs = [...new Set([...(input.needs ?? []), ...installNeedsFor(input.command)])];
  const env: Record<string, string> = {};
  const notes: string[] = [];
  for (const place of needs) {
    if (place === 'applications' && !places.applications) {
      if (/^brew install --cask\b/i.test(input.command)) {
        const appdir = path.join(places.home, 'Applications');
        try { mkdirSync(appdir, { recursive: true }); } catch { /* the install reports it */ }
        env.HOMEBREW_CASK_OPTS = `--appdir=${appdir}`;
        notes.push('This account cannot write to the Applications folder, so the app goes into your own Applications folder.');
        continue;
      }
      return blocked(place, input.command);
    }
    if (place === 'npm_prefix' && !places.npmPrefix.writable) {
      env.npm_config_prefix = path.join(places.home, '.local');
      notes.push("This account cannot write to npm's global folder, so the tool goes into ~/.local/bin.");
      continue;
    }
    if (place === 'homebrew' && (!places.homebrew || !places.homebrew.writable)) {
      if (!places.homebrew) return { ok: false, place, reason: 'Homebrew is not installed on this computer, and installing it needs an administrator.', adminCommand: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' };
      return blocked(place, input.command);
    }
    if (place === 'usr_local_bin' && !places.usrLocalBin) return blocked(place, input.command);
  }
  return { ok: true, env, note: notes.length ? notes.join(' ') : null };
}

function blocked(place: InstallPlace, command: string): InstallPreflight {
  return {
    ok: false,
    place,
    reason: `This install needs to write to ${PLACE_WORDS[place]}, and this account cannot (this computer looks managed). An administrator needs to run it once in Terminal; after that, come back here and the rest finishes on its own.`,
    adminCommand: command,
  };
}

/** The words a blocked install job shows. */
export function blockedInstallText(verdict: Extract<InstallPreflight, { ok: false }>): string {
  return `${verdict.reason}\n\nCommand for the administrator:\n${verdict.adminCommand}\n`;
}
