import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../../config.js';
import { EnvSecretBackend } from './env-store.js';
import { FileSecretBackend } from './file-store.js';
import { KeychainSecretBackend, probeKeychain } from './keychain-store.js';
import { getSecretDescriptor, listSecretDescriptors } from './registry.js';
import type {
  SecretGetResult,
  SecretHealthRow,
  SecretMetadata,
  SecretName,
  SecretSetResult,
  SecretSource,
  SecretStatus,
} from './types.js';

const logger = pino({ name: 'clementine-next.secrets' });
const META_FILE = path.join(BASE_DIR, 'state', 'secrets-meta.json');

interface MetaShape {
  version: 'v1';
  entries: Record<string, SecretMetadata>;
}

function ensureStateDir(): void {
  const dir = path.dirname(META_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readMeta(): MetaShape {
  if (!existsSync(META_FILE)) return { version: 'v1', entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(META_FILE, 'utf-8'));
    if (parsed && parsed.version === 'v1' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed as MetaShape;
    }
    return { version: 'v1', entries: {} };
  } catch {
    return { version: 'v1', entries: {} };
  }
}

function writeMeta(meta: MetaShape): void {
  ensureStateDir();
  const tmp = `${META_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, META_FILE);
  try { chmodSync(META_FILE, 0o600); } catch { /* ignore */ }
}

function updateMeta(name: SecretName, patch: Partial<SecretMetadata>): SecretMetadata {
  const meta = readMeta();
  const existing = meta.entries[name];
  const baseSource: SecretSource = existing?.source ?? 'missing';
  const baseStatus: SecretStatus = existing?.status ?? 'missing';
  const updated: SecretMetadata = {
    ...(existing ?? {}),
    ...patch,
    name,
    source: patch.source ?? existing?.source ?? baseSource,
    status: patch.status ?? existing?.status ?? baseStatus,
    version: 'v1',
  };
  meta.entries[name] = updated;
  writeMeta(meta);
  return updated;
}

/**
 * Composite SecretStore — orchestrates the three backends.
 *
 * Read order (highest to lowest priority): keychain → file → env.
 *   - Keychain wins because it's the most secure / Electron-native.
 *   - File is the dev/CLI fallback with controlled perms.
 *   - Env is the transparent compatibility layer so existing .env
 *     setups keep working without forced migration.
 *
 * Write target:
 *   - Defaults to keychain when available.
 *   - Falls back to file when keychain is unavailable (CLI / daemon-
 *     only mode).
 *   - NEVER writes to env (would mean editing the user's .env file).
 *
 * Migration:
 *   - migrate(name, from, to) reads from the source backend, writes to
 *     the destination, READS BACK from the destination, and ONLY then
 *     deletes from the source. If readback fails, the source is left
 *     untouched and the metadata records a `needs_repair` status.
 *
 * Reset:
 *   - resetAll() wipes keychain entries (only ones under our service
 *     name) AND the file vault. Never touches .env.
 *
 * All state-changing operations write metadata; reads update lastReadAt
 * lazily without contention.
 */
export class CompositeSecretStore {
  private keychainBackend: KeychainSecretBackend | null = null;
  private fileBackend = new FileSecretBackend();
  private envBackend = new EnvSecretBackend();

  /** Initialize keychain (Electron only). Returns whether keychain is usable. */
  async init(): Promise<{ keychainAvailable: boolean }> {
    const ok = await probeKeychain();
    this.keychainBackend = ok ? new KeychainSecretBackend() : null;
    return { keychainAvailable: ok };
  }

  /** Force keychain on or off — primarily for tests. */
  setKeychainBackend(backend: KeychainSecretBackend | null): void {
    this.keychainBackend = backend;
  }

  async get(name: SecretName): Promise<SecretGetResult> {
    // Keychain first (when available).
    if (this.keychainBackend) {
      try {
        const value = await this.keychainBackend.get(name);
        if (value !== undefined) {
          const metadata = updateMeta(name, { source: 'keychain', status: 'connected', lastError: undefined });
          return { name, value, source: 'keychain', status: 'connected', metadata };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message, name }, 'keychain read failed');
        const metadata = updateMeta(name, { source: 'keychain', status: 'unreadable', lastError: message });
        // Don't fall through — the user needs to repair the keychain
        // entry, not silently get the same secret from a less-safe
        // source. The Repair flow handles this explicitly.
        return { name, source: 'keychain', status: 'unreadable', metadata };
      }
    }

    // File backend next.
    try {
      const value = await this.fileBackend.get(name);
      if (value !== undefined) {
        const metadata = updateMeta(name, { source: 'file', status: 'connected', lastError: undefined });
        return { name, value, source: 'file', status: 'connected', metadata };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const metadata = updateMeta(name, { source: 'file', status: 'unreadable', lastError: message });
      return { name, source: 'file', status: 'unreadable', metadata };
    }

    // Env backend last — transparent dev/CLI compatibility.
    const value = await this.envBackend.get(name);
    if (value !== undefined) {
      const metadata = updateMeta(name, { source: 'env', status: 'env_only', lastError: undefined });
      return { name, value, source: 'env', status: 'env_only', metadata };
    }

    const metadata = updateMeta(name, { source: 'missing', status: 'missing' });
    return { name, source: 'missing', status: 'missing', metadata };
  }

  async set(name: SecretName, value: string): Promise<SecretSetResult> {
    // Pick the highest-priority writable backend.
    const target: 'keychain' | 'file' = this.keychainBackend ? 'keychain' : 'file';
    const backend = target === 'keychain' ? this.keychainBackend! : this.fileBackend;
    await backend.set(name, value);

    // Confirm via readback. This is the safety net — if a future
    // keychain weirdness causes set to succeed but get to fail, we
    // catch it here and refuse to record success.
    let confirmed: string | undefined;
    try {
      confirmed = await backend.get(name);
    } catch {
      confirmed = undefined;
    }
    if (confirmed !== value) {
      const metadata = updateMeta(name, {
        source: target,
        status: 'needs_repair',
        lastError: 'set() succeeded but readback returned a different value',
      });
      return { name, source: target, status: 'needs_repair', metadata };
    }

    const metadata = updateMeta(name, {
      source: target,
      status: 'connected',
      lastSetAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      lastError: undefined,
    });
    return { name, source: target, status: 'connected', metadata };
  }

  /** Remove from ALL writable backends (keychain + file). Env is
   *  never touched — the user owns their .env. */
  async delete(name: SecretName): Promise<void> {
    if (this.keychainBackend) await this.keychainBackend.delete(name);
    await this.fileBackend.delete(name);
    const meta = readMeta();
    delete meta.entries[name];
    writeMeta(meta);
  }

  /**
   * Confirm-then-move. Reads `value` from `from`, writes to `to`, reads
   * back from `to` to verify, and only then deletes from `from`. If any
   * step fails, the source is left intact and the metadata records
   * `needs_repair` with the failure reason.
   */
  async migrate(name: SecretName, from: 'env' | 'file', to: 'keychain' | 'file'): Promise<SecretSetResult> {
    if (from === to) {
      const r = await this.get(name);
      return { name, source: r.source, status: r.status, metadata: r.metadata ?? updateMeta(name, {}) };
    }
    const source = from === 'env' ? this.envBackend : this.fileBackend;
    const value = await source.get(name);
    if (value === undefined) {
      const metadata = updateMeta(name, { source: 'missing', status: 'missing' });
      return { name, source: 'missing', status: 'missing', metadata };
    }
    const destination = to === 'keychain' ? this.keychainBackend : this.fileBackend;
    if (!destination) {
      const metadata = updateMeta(name, { status: 'needs_repair', lastError: `destination ${to} unavailable` });
      return { name, source: 'missing', status: 'needs_repair', metadata };
    }
    await destination.set(name, value);
    let confirmed: string | undefined;
    try { confirmed = await destination.get(name); } catch { confirmed = undefined; }
    if (confirmed !== value) {
      const metadata = updateMeta(name, { status: 'needs_repair', lastError: 'post-migrate readback mismatch' });
      return { name, source: to, status: 'needs_repair', metadata };
    }
    // Only NOW delete from source — and only when from is 'file'.
    // We never auto-edit the user's .env files.
    if (from === 'file') {
      await this.fileBackend.delete(name);
    }
    const metadata = updateMeta(name, {
      source: to,
      status: 'connected',
      lastSetAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      lastError: undefined,
    });
    return { name, source: to, status: 'connected', metadata };
  }

  /** Snapshot for the dashboard "Credentials" panel. */
  async health(): Promise<SecretHealthRow[]> {
    const rows: SecretHealthRow[] = [];
    for (const desc of listSecretDescriptors()) {
      const result = await this.get(desc.name);
      const envFallbackAvailable = Boolean(desc.envVarName && await this.envBackend.get(desc.name));
      rows.push({
        name: desc.name,
        description: desc.description,
        source: result.source,
        status: result.status,
        hasValue: Boolean(result.value),
        lastSetAt: result.metadata?.lastSetAt,
        lastValidatedAt: result.metadata?.lastValidatedAt,
        envFallbackAvailable,
        envVarName: desc.envVarName,
      });
    }
    return rows;
  }

  /**
   * Repair Keychain — re-probes keytar and clears stale "unreadable"
   * statuses by force-reading every known credential. Used by the
   * dashboard's "Repair Keychain" button when a user's keychain has
   * gotten into a confused state.
   */
  async repairKeychain(): Promise<{ probed: boolean; tested: number; recovered: SecretName[] }> {
    const probed = await probeKeychain();
    if (!probed) return { probed: false, tested: 0, recovered: [] };
    this.keychainBackend = new KeychainSecretBackend();
    const recovered: SecretName[] = [];
    let tested = 0;
    for (const desc of listSecretDescriptors()) {
      tested++;
      const result = await this.get(desc.name);
      if (result.status === 'connected' && result.source === 'keychain') {
        recovered.push(desc.name);
      }
    }
    return { probed: true, tested, recovered };
  }

  /**
   * Reset Credentials — wipes EVERY entry from EVERY writable backend
   * under our control (keychain entries with service com.clemmy.desktop.v1,
   * the file vault, the metadata file). Returns a report so the dashboard
   * can show exactly what was deleted.
   *
   * NEVER touches .env or any other user-owned config file.
   */
  async resetAll(): Promise<{
    keychainDeleted: string[];
    keychainFailed: string[];
    fileVaultDeleted: boolean;
    metaDeleted: boolean;
  }> {
    let keychainDeleted: string[] = [];
    let keychainFailed: string[] = [];
    if (this.keychainBackend) {
      const report = await KeychainSecretBackend.reset();
      keychainDeleted = report.deleted;
      keychainFailed = report.failed;
    }
    const vaultPath = FileSecretBackend.getVaultPath();
    const fileVaultDeleted = existsSync(vaultPath);
    FileSecretBackend.reset();
    let metaDeleted = false;
    if (existsSync(META_FILE)) {
      try { unlinkSync(META_FILE); metaDeleted = true; } catch { /* ignore */ }
    }
    return { keychainDeleted, keychainFailed, fileVaultDeleted, metaDeleted };
  }
}

let singleton: CompositeSecretStore | null = null;

/** Get the process-wide SecretStore singleton, initializing keychain
 *  probe lazily on first call. Safe to call from any module. */
export async function getSecretStore(): Promise<CompositeSecretStore> {
  if (!singleton) {
    singleton = new CompositeSecretStore();
    await singleton.init();
  }
  return singleton;
}

/** Synchronous variant for code paths that can't await (e.g., config
 *  loading at module init time). Returns the singleton without
 *  ensuring keychain has been probed — caller gets env/file fallback
 *  semantics, which is the right behavior outside Electron anyway. */
export function getSecretStoreSync(): CompositeSecretStore {
  if (!singleton) singleton = new CompositeSecretStore();
  return singleton;
}

/** Reset the singleton — test-only. */
export function __resetSecretStoreForTests(): void {
  singleton = null;
}
