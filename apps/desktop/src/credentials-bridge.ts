import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomFillSync } from 'node:crypto';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

/**
 * Credentials bridge — the Electron main process's direct path to the
 * SecretStore's storage primitives.
 *
 * In dev mode we could import the parent project's compiled
 * SecretStore directly. In packaged-Electron mode, the daemon's
 * compiled source may not be loadable as ESM from the Electron main
 * process (different module resolution rules, separate compiled
 * outputs). So this module re-implements just the bits the wizard
 * needs against the SAME file format the daemon's SecretStore uses:
 *
 *   ~/.clementine-next/state/secrets-vault.json
 *     { "version": "v1", "entries": { "<name>": "<value>", ... } }
 *
 *   ~/.clementine-next/state/secrets-meta.json
 *     { "version": "v1", "entries": { "<name>": SecretMetadata, ... } }
 *
 * The daemon's SecretStore is the canonical reader/writer at runtime;
 * the wizard writes through this module BEFORE the daemon boots so
 * the daemon picks up the values on its first read. Once the wizard
 * is done and the daemon is up, future credential edits flow through
 * the dashboard's /api/console/credentials/* routes (which call into
 * the daemon's SecretStore).
 *
 * Keychain integration: also lazily loads keytar with the same
 * service name (com.clemmy.desktop.v1) for reset/repair compatibility.
 * Default setup writes use the file vault to avoid repeated macOS
 * Keychain prompts after desktop app updates.
 */

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.clementine-next', 'state');
const VAULT_FILE = path.join(STATE_DIR, 'secrets-vault.json');
const META_FILE = path.join(STATE_DIR, 'secrets-meta.json');
const KEYCHAIN_MIGRATION_MARKER = path.join(STATE_DIR, 'keychain-migrated.json');

const KEYCHAIN_SERVICE = 'com.clemmy.desktop.v1';

export type CredentialStatus = 'connected' | 'missing' | 'env_only' | 'unreadable' | 'needs_repair';
export type CredentialSource = 'keychain' | 'file' | 'env' | 'missing';
export type CredentialName =
  | 'openai_api_key'
  | 'discord_bot_token'
  | 'composio_api_key'
  | 'recall_api_key'
  | 'codex_oauth_access_token'
  | 'codex_oauth_refresh_token'
  | 'webhook_secret';

export interface CredentialDescriptor {
  name: CredentialName;
  envVarName: string;
  description: string;
  setupHint?: string;
  required: boolean;
}

export const KNOWN_CREDENTIALS: readonly CredentialDescriptor[] = [
  { name: 'openai_api_key',  envVarName: 'OPENAI_API_KEY',  description: 'Optional OpenAI API key — enables embeddings, Realtime live voice, and direct OpenAI API features. Not required when the runtime uses Codex OAuth.', setupHint: 'Starts with sk- — get one at platform.openai.com/api-keys', required: false },
  { name: 'discord_bot_token', envVarName: 'DISCORD_BOT_TOKEN', description: 'Discord bot token — enables Clementine on Discord.', setupHint: 'Create at discord.com/developers/applications', required: false },
  { name: 'composio_api_key', envVarName: 'COMPOSIO_API_KEY', description: 'Composio API key — Gmail / Slack / Notion / GitHub / Linear / Drive / CRMs.', setupHint: 'Sign up at composio.dev', required: false },
  { name: 'recall_api_key', envVarName: 'RECALL_API_KEY', description: 'Recall.ai API key — optional desktop meeting capture and transcripts.', setupHint: 'Sign up at recall.ai and create an API key.', required: false },
  { name: 'codex_oauth_access_token', envVarName: '', description: 'Codex OAuth access token — primary runtime auth for ChatGPT/Codex subscribers.', required: false },
  { name: 'codex_oauth_refresh_token', envVarName: '', description: 'Codex OAuth refresh token — renews ChatGPT/Codex auth silently.', required: false },
  { name: 'webhook_secret', envVarName: 'WEBHOOK_SECRET', description: 'Dashboard auth secret (URL token).', setupHint: 'Auto-generated on first launch.', required: true },
];

interface VaultShape { version: 'v1'; entries: Record<string, string>; }
interface MetaShape  { version: 'v1'; entries: Record<string, CredentialMetadata>; }

export interface CredentialMetadata {
  name: CredentialName;
  source: CredentialSource;
  status: CredentialStatus;
  lastSetAt?: string;
  lastError?: string;
  version: 'v1';
}

// ─── Keychain (lazy keytar) ──────────────────────────────────────

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

let keytarPromise: Promise<KeytarLike | null> | null = null;

// Load via createRequire instead of dynamic import(). ESM's CJS interop
// sometimes synthesizes only a partial named-export namespace from
// keytar's module.exports — packaged 0.2.3 hit a case where getPassword
// was present but setPassword was missing, so callers got past the
// truthy-check and then crashed on `keychain.setPassword is not a
// function`. createRequire gives us the real CommonJS module.exports.
async function loadKeytar(): Promise<KeytarLike | null> {
  if (keytarPromise) return keytarPromise;
  keytarPromise = (async () => {
    try {
      const candidate = requireFromHere('keytar') as Partial<KeytarLike> | { default?: Partial<KeytarLike> };
      const mod = (candidate as { default?: Partial<KeytarLike> }).default ?? (candidate as Partial<KeytarLike>);
      if (
        typeof mod.getPassword !== 'function' ||
        typeof mod.setPassword !== 'function' ||
        typeof mod.deletePassword !== 'function'
      ) {
        return null;
      }
      return mod as KeytarLike;
    } catch {
      return null;
    }
  })();
  return keytarPromise;
}

export async function isKeychainAvailable(): Promise<boolean> {
  return Boolean(await loadKeytar());
}

// ─── File vault primitives ───────────────────────────────────────

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function readVault(): VaultShape {
  if (!existsSync(VAULT_FILE)) return { version: 'v1', entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(VAULT_FILE, 'utf-8'));
    if (parsed && parsed.version === 'v1' && parsed.entries) return parsed as VaultShape;
  } catch { /* fall through */ }
  return { version: 'v1', entries: {} };
}

function writeVault(vault: VaultShape): void {
  ensureStateDir();
  const tmp = `${VAULT_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(vault, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, VAULT_FILE);
  try { chmodSync(VAULT_FILE, 0o600); } catch { /* ignore */ }
}

function readMeta(): MetaShape {
  if (!existsSync(META_FILE)) return { version: 'v1', entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(META_FILE, 'utf-8'));
    if (parsed && parsed.version === 'v1' && parsed.entries) return parsed as MetaShape;
  } catch { /* fall through */ }
  return { version: 'v1', entries: {} };
}

function writeMeta(meta: MetaShape): void {
  ensureStateDir();
  const tmp = `${META_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, META_FILE);
  try { chmodSync(META_FILE, 0o600); } catch { /* ignore */ }
}

function updateMeta(name: CredentialName, patch: Partial<CredentialMetadata>): CredentialMetadata {
  const meta = readMeta();
  const existing = meta.entries[name];
  const updated: CredentialMetadata = {
    ...(existing ?? {}),
    ...patch,
    name,
    source: patch.source ?? existing?.source ?? 'missing',
    status: patch.status ?? existing?.status ?? 'missing',
    version: 'v1',
  };
  meta.entries[name] = updated;
  writeMeta(meta);
  return updated;
}

// ─── Env reader (read-only fallback) ─────────────────────────────

function readEnvVar(name: string): string | undefined {
  if (process.env[name] && process.env[name]!.length > 0) return process.env[name];
  const candidates = [
    path.join(HOME, '.clementine-next', '.env'),
    path.join(HOME, 'clementine-next', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const k = trimmed.slice(0, eq);
        if (k !== name) continue;
        let v = trimmed.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (v.length > 0) return v;
      }
    } catch { /* keep looking */ }
  }
  return undefined;
}

// ─── Public API ──────────────────────────────────────────────────

export interface CredentialRow {
  name: CredentialName;
  source: CredentialSource;
  status: CredentialStatus;
  hasValue: boolean;
  lastSetAt?: string;
  envFallbackAvailable: boolean;
  envVarName: string;
  description: string;
  setupHint?: string;
}

export async function listCredentialRows(options: { includeKeychain?: boolean } = {}): Promise<CredentialRow[]> {
  const rows: CredentialRow[] = [];
  const keychain = options.includeKeychain ? await loadKeytar() : null;
  const vault = readVault();
  for (const d of KNOWN_CREDENTIALS) {
    let source: CredentialSource = 'missing';
    let status: CredentialStatus = 'missing';
    let hasValue = false;

    const fileValue = vault.entries[d.name];
    if (fileValue && fileValue.length > 0) {
      source = 'file'; status = 'connected'; hasValue = true;
    }

    if (!hasValue && d.envVarName) {
      const envValue = readEnvVar(d.envVarName);
      if (envValue) {
        source = 'env'; status = 'env_only'; hasValue = true;
      }
    }

    if (!hasValue && keychain) {
      try {
        const value = await keychain.getPassword(KEYCHAIN_SERVICE, d.name);
        if (value && value.length > 0) {
          source = 'keychain'; status = 'connected'; hasValue = true;
        }
      } catch {
        source = 'keychain'; status = 'unreadable';
      }
    }

    const meta = readMeta().entries[d.name];
    const envFallbackAvailable = Boolean(d.envVarName && readEnvVar(d.envVarName));

    rows.push({
      name: d.name,
      source,
      status,
      hasValue,
      lastSetAt: meta?.lastSetAt,
      envFallbackAvailable,
      envVarName: d.envVarName,
      description: d.description,
      setupHint: d.setupHint,
    });
  }
  return rows;
}

/** Write a credential to the file vault.
 *  Readback-verified — never records "connected" without confirming
 *  the value is fetchable from the destination. */
export async function setCredential(name: CredentialName, value: string): Promise<CredentialMetadata> {
  if (!value) throw new Error('empty value');
  const vault = readVault();
  vault.entries[name] = value;
  writeVault(vault);
  const confirmed = readVault().entries[name];
  if (confirmed === value) {
    return updateMeta(name, {
      source: 'file',
      status: 'connected',
      lastSetAt: new Date().toISOString(),
      lastError: undefined,
    });
  }
  return updateMeta(name, {
    source: 'file',
    status: 'needs_repair',
    lastError: 'set succeeded but file vault readback returned a different value',
  });
}

/** Delete from keychain + file vault. Never touches .env. */
export async function deleteCredential(name: CredentialName): Promise<void> {
  const keychain = await loadKeytar();
  if (keychain) {
    try { await keychain.deletePassword(KEYCHAIN_SERVICE, name); } catch { /* ignore */ }
  }
  if (existsSync(VAULT_FILE)) {
    const vault = readVault();
    if (name in vault.entries) {
      delete vault.entries[name];
      if (Object.keys(vault.entries).length === 0) {
        try { unlinkSync(VAULT_FILE); } catch { /* ignore */ }
      } else {
        writeVault(vault);
      }
    }
  }
  const meta = readMeta();
  delete meta.entries[name];
  writeMeta(meta);
}

/** Reset every Clementine-owned credential storage location. NEVER
 *  touches user .env files. Used by the dashboard's Reset flow and
 *  by the wizard's "start over" option. */
export async function resetAllCredentials(): Promise<{ keychainDeleted: string[]; fileVaultDeleted: boolean; metaDeleted: boolean }> {
  const keychainDeleted: string[] = [];
  const keychain = await loadKeytar();
  if (keychain) {
    try {
      const entries = await keychain.findCredentials(KEYCHAIN_SERVICE);
      for (const { account } of entries) {
        try { await keychain.deletePassword(KEYCHAIN_SERVICE, account); keychainDeleted.push(account); }
        catch { /* ignore individual failures */ }
      }
    } catch { /* whole listing failed */ }
  }
  let fileVaultDeleted = false;
  if (existsSync(VAULT_FILE)) {
    try { unlinkSync(VAULT_FILE); fileVaultDeleted = true; } catch { /* ignore */ }
  }
  let metaDeleted = false;
  if (existsSync(META_FILE)) {
    try { unlinkSync(META_FILE); metaDeleted = true; } catch { /* ignore */ }
  }
  return { keychainDeleted, fileVaultDeleted, metaDeleted };
}

export interface KeychainMigrationResult {
  ran: boolean;            // false when marker was already present
  skippedReason?: string;  // 'no_keytar' | 'already_migrated' | 'no_entries' | 'fresh_install'
  migrated: string[];      // accounts copied from keychain → file vault
  alreadyInVault: string[];// accounts present in keychain but file vault already had them
  errors: string[];
}

/**
 * One-time migration of any Keychain entries under `com.clemmy.desktop.v1`
 * into the file vault. Runs once per HOME (gated by the marker file at
 * STATE_DIR/keychain-migrated.json) and is safe to call on every boot —
 * the marker keeps it from re-prompting Keychain on subsequent launches.
 *
 * Why this exists: v0.4.16 → v0.4.29 wrote credentials into Keychain.
 * v0.4.30+ writes to the file vault. Users upgrading skip the wizard
 * (marker present) and would otherwise silently lose access to their
 * Keychain-stored credentials because the runtime defaults
 * `allowKeychain: false` everywhere. This bridges them.
 *
 * Behavior:
 *   - Uses `findCredentials(KEYCHAIN_SERVICE)` so the user sees at most
 *     one Keychain prompt (covers all entries), not one per credential.
 *   - **Fresh installs are skipped entirely.** If setup-complete.json
 *     doesn't exist, the user has never used Clementine on this HOME
 *     before — there's nothing to migrate, and we MUST NOT call
 *     findCredentials() because macOS pops a Keychain auth prompt the
 *     first time an app's signature touches the security framework,
 *     EVEN when zero entries match the service filter.
 *   - File vault wins on conflict — never overwrites an existing vault
 *     entry with a Keychain value.
 *   - Deletes the Keychain entry after a successful file-vault write
 *     so future launches stay quiet even if the marker is removed.
 *   - Marker is written unconditionally on the first successful run so
 *     we don't keep poking Keychain if there's nothing to migrate.
 */
export async function migrateKeychainToFileVault(): Promise<KeychainMigrationResult> {
  if (existsSync(KEYCHAIN_MIGRATION_MARKER)) {
    return { ran: false, skippedReason: 'already_migrated', migrated: [], alreadyInVault: [], errors: [] };
  }

  // Fresh-install fast path. A user that has never completed setup on
  // this HOME literally cannot have v0.4.16 → v0.4.29 Keychain entries
  // here. Calling findCredentials() would gratuitously trigger the
  // macOS Keychain access dialog. Write the marker and move on.
  const setupCompleteMarker = path.join(STATE_DIR, 'setup-complete.json');
  if (!existsSync(setupCompleteMarker)) {
    writeMigrationMarker({ result: 'fresh_install' });
    return { ran: false, skippedReason: 'fresh_install', migrated: [], alreadyInVault: [], errors: [] };
  }

  const keychain = await loadKeytar();
  if (!keychain) {
    // No keytar — likely a non-Electron context or stripped build. Mark
    // done so we don't keep re-attempting.
    writeMigrationMarker({ result: 'no_keytar' });
    return { ran: false, skippedReason: 'no_keytar', migrated: [], alreadyInVault: [], errors: [] };
  }

  const migrated: string[] = [];
  const alreadyInVault: string[] = [];
  const errors: string[] = [];

  let entries: Array<{ account: string; password: string }> = [];
  try {
    entries = await keychain.findCredentials(KEYCHAIN_SERVICE);
  } catch (err) {
    errors.push(`findCredentials failed: ${err instanceof Error ? err.message : String(err)}`);
    writeMigrationMarker({ result: 'find_failed', errors });
    return { ran: true, migrated, alreadyInVault, errors };
  }

  if (entries.length === 0) {
    writeMigrationMarker({ result: 'no_entries' });
    return { ran: true, skippedReason: 'no_entries', migrated, alreadyInVault, errors };
  }

  const vault = readVault();
  let dirty = false;
  for (const { account, password } of entries) {
    if (!password || password.length === 0) continue;
    if (vault.entries[account] && vault.entries[account].length > 0) {
      alreadyInVault.push(account);
      continue;
    }
    vault.entries[account] = password;
    migrated.push(account);
    dirty = true;
  }

  if (dirty) {
    writeVault(vault);
  }

  // Delete migrated accounts from Keychain only AFTER the file vault
  // write succeeded. If delete fails (rare; ACL issues), the worst
  // case is a redundant copy in Keychain — the file copy wins on
  // subsequent reads because the runtime defaults allowKeychain=false.
  for (const account of migrated) {
    try {
      await keychain.deletePassword(KEYCHAIN_SERVICE, account);
    } catch (err) {
      errors.push(`delete ${account}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Update credentials-meta so the dashboard shows source=file.
    const knownName = KNOWN_CREDENTIALS.find((d) => d.name === account)?.name;
    if (knownName) {
      updateMeta(knownName, {
        source: 'file',
        status: 'connected',
        lastSetAt: new Date().toISOString(),
        lastError: undefined,
      });
    }
  }

  writeMigrationMarker({ result: 'completed', migrated, alreadyInVault, errors });
  return { ran: true, migrated, alreadyInVault, errors };
}

function writeMigrationMarker(payload: Record<string, unknown>): void {
  try {
    ensureStateDir();
    const tmp = `${KEYCHAIN_MIGRATION_MARKER}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, KEYCHAIN_MIGRATION_MARKER);
    try { chmodSync(KEYCHAIN_MIGRATION_MARKER, 0o600); } catch { /* best-effort */ }
  } catch {
    // Marker write must never block boot. If we can't write it, we'll
    // re-attempt migration next launch — annoying but not fatal.
  }
}

/**
 * Ensure a webhook secret exists. The dashboard requires one to render
 * any URL. If neither env nor file vault has one, generate a fresh
 * value and store it so the rest of boot can use it.
 */
export async function ensureWebhookSecret(): Promise<string> {
  // Already in env? Use that.
  const fromEnv = readEnvVar('WEBHOOK_SECRET');
  if (fromEnv) return fromEnv;

  // Already in vault? Use that.
  const vault = readVault();
  if (vault.entries.webhook_secret) return vault.entries.webhook_secret;

  // Generate one.
  const generated = randomToken(24);
  await setCredential('webhook_secret', generated);
  return generated;
}

function randomToken(len: number): string {
  const bytes = Buffer.alloc(len);
  randomFillSync(bytes);
  return bytes.toString('hex').slice(0, len);
}
