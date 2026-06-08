import { getRuntimeEnv } from '../config.js';
import { updateEnvKey } from '../tools/shared.js';

/**
 * User-declared CLI registry. The PATH auto-scan can't see everything —
 * Node-embedding CLIs like `sf` EPERM under the daemon (macOS TCC) and never
 * pass the isLikelyCli probe, and tools installed to non-standard dirs aren't
 * on the daemon's PATH at all. So the user can explicitly SAVE the CLIs they
 * use; those are surfaced to the agent (local_cli_list) as user-confirmed so
 * Clementine reaches for them directly instead of rediscovering.
 *
 * Persisted as a comma-separated env key (BASE_DIR/.env) — same mechanism as
 * the other operator settings; applies live (process.env) + across restarts.
 */
const KEY = 'CLEMMY_SAVED_CLIS';
const VALID = /^[A-Za-z0-9._+-]{1,60}$/;

export function getSavedClis(): string[] {
  const raw = getRuntimeEnv(KEY, '') ?? '';
  return Array.from(new Set(raw.split(',').map((s) => s.trim()).filter((s) => VALID.test(s)))).sort((a, b) => a.localeCompare(b));
}

function persist(list: string[]): string[] {
  const value = list.join(',');
  updateEnvKey(KEY, value);
  process.env[KEY] = value;
  return list;
}

export function addSavedCli(command: string): string[] {
  const c = (command ?? '').trim();
  if (!VALID.test(c)) throw new Error('Enter a bare CLI name (letters, numbers, . _ + -), e.g. "sf" or "gh".');
  const list = getSavedClis();
  if (!list.includes(c)) list.push(c);
  return persist(list.sort((a, b) => a.localeCompare(b)));
}

export function removeSavedCli(command: string): string[] {
  const c = (command ?? '').trim();
  return persist(getSavedClis().filter((x) => x !== c));
}
