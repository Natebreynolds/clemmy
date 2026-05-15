import pino from 'pino';
import type { SecretBackend, SecretName } from './types.js';
import { KEYCHAIN_SERVICE, keychainAccount } from './registry.js';

/**
 * Keychain backend — wraps `keytar` lazily.
 *
 * `keytar` is a NATIVE module (compiled C++ bindings to macOS Keychain
 * / Windows Credential Vault / Linux Secret Service). It's not in the
 * core daemon dependency set because:
 *   1. The current CLI/daemon path doesn't need it.
 *   2. Adding it to package.json would force native compilation on
 *      every `npm install`, even for users who never want Electron.
 *
 * Instead, this backend tries to dynamic-import `keytar` at
 * initialization. If the module isn't present (or fails to compile on
 * this platform), `isAvailable` stays false and the composite store
 * skips this backend cleanly. The Electron app bundles keytar as a
 * production dependency — only there will this backend activate.
 *
 * Service name is `com.clemmy.desktop.v1` (versioned) and the account
 * is the credential's stable name. The v1 suffix means a future v2
 * migration can keep the v1 entries readable for rollback.
 */

const logger = pino({ name: 'clementine-next.secrets.keychain' });

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

let keytarPromise: Promise<KeytarModule | null> | null = null;

async function loadKeytar(): Promise<KeytarModule | null> {
  if (keytarPromise) return keytarPromise;
  keytarPromise = (async () => {
    try {
      // Dynamic import via a runtime-computed specifier so TypeScript
      // doesn't try to type-resolve it. The Electron build adds keytar
      // as a real dependency; daemon-only / CLI builds resolve to null.
      const specifier = 'keytar';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import(/* @vite-ignore */ specifier as string)) as unknown as KeytarModule | { default: KeytarModule };
      return ('getPassword' in (mod as object))
        ? (mod as KeytarModule)
        : (mod as { default: KeytarModule }).default;
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : err }, 'keytar not available — keychain backend disabled');
      return null;
    }
  })();
  return keytarPromise;
}

/** Pre-init the keychain backend. Idempotent. Useful for the Electron
 *  main process to fail fast on first launch when keytar should be
 *  available but isn't. */
export async function probeKeychain(): Promise<boolean> {
  return Boolean(await loadKeytar());
}

/** Drop the cached promise so the next get/set re-resolves keytar.
 *  Used by tests, and by a future "Repair Keychain" admin action. */
export function resetKeychainProbe(): void {
  keytarPromise = null;
}

export class KeychainSecretBackend implements SecretBackend {
  readonly name = 'keychain' as const;
  /** Provisional. The composite store re-checks via probeKeychain()
   *  before delegating, so a misconfigured machine doesn't crash. */
  readonly isAvailable = true;

  async get(name: SecretName): Promise<string | undefined> {
    const keytar = await loadKeytar();
    if (!keytar) return undefined;
    try {
      const value = await keytar.getPassword(KEYCHAIN_SERVICE, keychainAccount(name));
      return value === null ? undefined : value;
    } catch (err) {
      // Throw — composite handles failure as `unreadable` status.
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    const keytar = await loadKeytar();
    if (!keytar) throw new Error('keychain unavailable — keytar module not installed');
    await keytar.setPassword(KEYCHAIN_SERVICE, keychainAccount(name), value);
  }

  async delete(name: SecretName): Promise<void> {
    const keytar = await loadKeytar();
    if (!keytar) return;
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, keychainAccount(name));
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, name }, 'keychain delete failed');
    }
  }

  /** List every entry under our stable service name. Used by the
   *  Reset Credentials flow so the dashboard can show exactly what
   *  it would delete before confirming with the user. */
  static async listEntries(): Promise<string[]> {
    const keytar = await loadKeytar();
    if (!keytar) return [];
    try {
      const creds = await keytar.findCredentials(KEYCHAIN_SERVICE);
      return creds.map((c) => c.account);
    } catch {
      return [];
    }
  }

  /** Hard reset — deletes EVERY entry under com.clemmy.desktop.v1.
   *  Other services (other apps, other product versions) are untouched
   *  because keychain operations are scoped by service name. */
  static async reset(): Promise<{ deleted: string[]; failed: string[] }> {
    const keytar = await loadKeytar();
    if (!keytar) return { deleted: [], failed: [] };
    const deleted: string[] = [];
    const failed: string[] = [];
    const entries = await KeychainSecretBackend.listEntries();
    for (const account of entries) {
      try {
        await keytar.deletePassword(KEYCHAIN_SERVICE, account);
        deleted.push(account);
      } catch {
        failed.push(account);
      }
    }
    return { deleted, failed };
  }
}
