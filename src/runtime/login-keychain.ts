/**
 * Whether the owner's macOS login keychain can be read right now.
 *
 * Command-line tools that keep their logins in the keychain stop working the
 * moment it is locked, and they say so in their own words ("no authorization
 * information found", "org not found"), which reads like a broken
 * integration. Live 10-02: a scheduled report failed three mornings in a week
 * this way while nothing about it had changed; the keychain had been locked
 * by something on the machine overnight.
 *
 * The probe asks the system the same read-only question `security
 * show-keychain-info` asks and reads only its exit status, which is the low
 * byte of the system's own result code: authorization failed and interaction
 * not allowed mean locked; no such keychain means there is nothing to say.
 * It never unlocks anything and never shows a prompt.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export type LoginKeychainState = 'unlocked' | 'locked' | 'unknown';

export interface LoginKeychainProbe {
  state: LoginKeychainState;
  checkedAt: string;
  /** The keychain the answer is about, when there is one. */
  keychainPath: string | null;
}

/** errSecAuthFailed (-25293) and errSecInteractionNotAllowed (-25308), as the
 *  low byte the `security` tool exits with. */
const LOCKED_EXIT_CODES = new Set([51, 36]);
const PROBE_TIMEOUT_MS = 3_000;
const CACHE_MS = 60_000;

/** The one sentence the owner needs, wherever a locked keychain is reported. */
export const LOGIN_KEYCHAIN_LOCKED_GUIDANCE = 'Your Mac\'s login keychain is locked, so command-line tools that keep their sign-ins there cannot use them. '
  + 'Unlock it in Terminal with: security unlock-keychain ~/Library/Keychains/login.keychain-db';

type Runner = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null }>;

const defaultRunner: Runner = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, [...args], { timeout: timeoutMs, windowsHide: true }, (error) => {
    if (!error) { resolve({ code: 0 }); return; }
    const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
    resolve({ code: typeof code === 'number' ? code : null });
  });
});

let runner: Runner = defaultRunner;
let platform: () => NodeJS.Platform = () => process.platform;
let cached: LoginKeychainProbe | null = null;
let cachedAtMs = 0;

function loginKeychainPath(): string {
  return path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

/** Ask once a minute at most; a cached answer is returned in between. */
export async function probeLoginKeychain(options: { fresh?: boolean } = {}): Promise<LoginKeychainProbe> {
  if (!options.fresh && cached && Date.now() - cachedAtMs < CACHE_MS) return cached;
  const checkedAt = new Date().toISOString();
  if (platform() !== 'darwin') {
    cached = { state: 'unknown', checkedAt, keychainPath: null };
    cachedAtMs = Date.now();
    return cached;
  }
  const keychainPath = loginKeychainPath();
  let state: LoginKeychainState = 'unknown';
  try {
    const { code } = await runner('/usr/bin/security', ['show-keychain-info', keychainPath], PROBE_TIMEOUT_MS);
    state = code === 0 ? 'unlocked' : code !== null && LOCKED_EXIT_CODES.has(code) ? 'locked' : 'unknown';
  } catch {
    state = 'unknown';
  }
  cached = { state, checkedAt, keychainPath };
  cachedAtMs = Date.now();
  return cached;
}

export const __loginKeychainTest__ = {
  setRunner(next: Runner | null): void { runner = next ?? defaultRunner; cached = null; cachedAtMs = 0; },
  setPlatform(next: (() => NodeJS.Platform) | null): void { platform = next ?? (() => process.platform); cached = null; cachedAtMs = 0; },
  reset(): void { cached = null; cachedAtMs = 0; },
};
