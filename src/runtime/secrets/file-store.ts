import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import type { SecretBackend, SecretName } from './types.js';

/**
 * File backend — JSON file at ~/.clementine-next/state/secrets-vault.json
 * with 0600 permissions.
 *
 * This is the fallback when keychain isn't available (Linux without
 * a Secret Service, headless CI, dev daemon outside Electron). It's
 * less secure than Keychain — anyone with read access to the home
 * directory can read it — but it's better than .env because:
 *   1. We control the file format, can rotate it, can encrypt later.
 *   2. The Electron app's "Reset Credentials" can wipe ONLY this file
 *      without touching the user's .env (which may have unrelated
 *      project settings).
 *   3. The file lives under ~/.clementine-next and is naturally
 *      excluded from version control by sitting outside any repo.
 *
 * Future hardening: encrypt with a key derived from a user-supplied
 * passphrase or from the OS user, before writing. Not yet — landing
 * the abstraction first matters more than the storage primitive's
 * day-one strength.
 */

const VAULT_FILE = path.join(BASE_DIR, 'state', 'secrets-vault.json');

interface VaultShape {
  version: 'v1';
  entries: Record<string, string>;
}

function ensureStateDir(): void {
  const dir = path.dirname(VAULT_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on platforms that ignore mode */ }
}

function readVault(): VaultShape {
  if (!existsSync(VAULT_FILE)) return { version: 'v1', entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(VAULT_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.version === 'v1' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed as VaultShape;
    }
    return { version: 'v1', entries: {} };
  } catch {
    // Corrupt — refuse to silently overwrite. Caller's get() will
    // record this as `unreadable` and surface it in the health panel.
    throw new Error('secrets-vault.json is corrupt — use the Reset Credentials flow to recover');
  }
}

function writeVault(vault: VaultShape): void {
  ensureStateDir();
  const tmp = `${VAULT_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(vault, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, VAULT_FILE);
  try { chmodSync(VAULT_FILE, 0o600); } catch { /* best-effort on platforms that ignore mode */ }
}

export class FileSecretBackend implements SecretBackend {
  readonly name = 'file' as const;
  readonly isAvailable = true;

  async get(name: SecretName): Promise<string | undefined> {
    const vault = readVault();
    const value = vault.entries[name];
    return value && value.length > 0 ? value : undefined;
  }

  async set(name: SecretName, value: string): Promise<void> {
    const vault = readVault();
    vault.entries[name] = value;
    writeVault(vault);
  }

  async delete(name: SecretName): Promise<void> {
    if (!existsSync(VAULT_FILE)) return;
    let vault: VaultShape;
    try { vault = readVault(); }
    catch { return; }
    if (!(name in vault.entries)) return;
    delete vault.entries[name];
    if (Object.keys(vault.entries).length === 0) {
      // No entries left — remove the file entirely so "Reset Credentials"
      // leaves the user with a fully clean slate.
      try { unlinkSync(VAULT_FILE); } catch { /* ignore */ }
      return;
    }
    writeVault(vault);
  }

  /** Hard reset — drops the entire vault file. Used by the dashboard's
   *  "Reset Credentials" flow. NEVER touches .env or keychain. */
  static reset(): void {
    if (existsSync(VAULT_FILE)) {
      try { unlinkSync(VAULT_FILE); } catch { /* ignore */ }
    }
  }

  /** Test-helper: surface the vault path so tests can clean up. */
  static getVaultPath(): string {
    return VAULT_FILE;
  }
}
