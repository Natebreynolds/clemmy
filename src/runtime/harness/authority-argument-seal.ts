/**
 * Host-local seal for provider-argument bytes. The key is never derived
 * solely from the co-located machine-id. Isolated tests inject
 * CLEMMY_AUTHORITY_SEAL_KEY. Production uses the Clementine vault /
 * OS keychain via SecretStore.
 */
import { SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR, invalidateRuntimeConfigSnapshot } from '../../config.js';

const SEAL_VERSION = 2;
// The fifth door on the sealed-call argument path shares the one bound the
// compiler, executor and runner already apply (SEALED_CALL_CANONICAL_LIMITS);
// a 32 000-byte private cap here refused a 600 KB workspace dataset commit
// after every other door had admitted it (2026-09-02).
export const AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES = SEALED_CALL_CANONICAL_LIMITS.maxTotalBytes;
// Ciphertext is JSON-wrapped base64 of base64 (~1.8x the plaintext): derive
// the cap from the plaintext bound instead of keeping a second private number.
export const AUTHORITY_ARGUMENT_MAX_CIPHER_BYTES = Math.min(
  Math.ceil(AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES * 2) + 4_096,
  // The durable lease column's CHECK (eventlog schema v75) is the outer wall.
  16_777_216,
);
export const AUTHORITY_SEAL_KEY_ID_V2 = 'authority_seal_v2';
export const AUTHORITY_SEAL_KEY_ID_V1 = 'authority_seal_v1';
const VAULT_FILE = path.join(BASE_DIR, 'state', 'secrets-vault.json');

export class AuthoritySealKeyMissingError extends Error {
  readonly code = 'authority_seal_key_missing';
  constructor() {
    super('authority seal key is missing; reconnect the host vault before retrying this crossing');
    this.name = 'AuthoritySealKeyMissingError';
  }
}

function hexKey(raw: string | undefined): Buffer | null {
  if (!raw || !/^[a-f0-9]{64}$/i.test(raw.trim())) return null;
  return Buffer.from(raw.trim(), 'hex');
}

function readVaultEntry(name: string): string | undefined {
  if (!existsSync(VAULT_FILE)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(VAULT_FILE, 'utf8')) as {
      version?: string;
      entries?: Record<string, string>;
    };
    if (parsed.version !== 'v1' || !parsed.entries) return undefined;
    const value = parsed.entries[name];
    return value && value.length > 0 ? value : undefined;
  } catch {
    throw new AuthoritySealKeyMissingError();
  }
}

function writeVaultEntry(name: string, value: string): void {
  mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  let entries: Record<string, string> = {};
  if (existsSync(VAULT_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(VAULT_FILE, 'utf8')) as {
        version?: string;
        entries?: Record<string, string>;
      };
      if (parsed.version === 'v1' && parsed.entries) entries = { ...parsed.entries };
    } catch {
      throw new AuthoritySealKeyMissingError();
    }
  }
  entries[name] = value;
  writeFileSync(VAULT_FILE, `${JSON.stringify({ version: 'v1', entries }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  invalidateRuntimeConfigSnapshot('secret_vault');
}

function keyForId(id: string): Buffer | null {
  if (id === AUTHORITY_SEAL_KEY_ID_V2) {
    return hexKey(process.env.CLEMMY_AUTHORITY_SEAL_KEY) ?? hexKey(readVaultEntry(AUTHORITY_SEAL_KEY_ID_V2));
  }
  if (id === AUTHORITY_SEAL_KEY_ID_V1) {
    return hexKey(process.env.CLEMMY_AUTHORITY_SEAL_KEY_PREVIOUS) ?? hexKey(readVaultEntry(AUTHORITY_SEAL_KEY_ID_V1));
  }
  return null;
}

function currentKey(): { id: string; key: Buffer } {
  const current = keyForId(AUTHORITY_SEAL_KEY_ID_V2);
  if (current) return { id: AUTHORITY_SEAL_KEY_ID_V2, key: current };
  const isolatedVertical = process.env.CLEMENTINE_ISOLATED_VERTICAL === '1'
    && process.env.CLEMENTINE_HOME
    && path.resolve(process.env.CLEMENTINE_HOME).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`);
  if (process.env.CLEMMY_TEST_ISOLATED_HOME === '1' || isolatedVertical) {
    const generated = randomBytes(32).toString('hex');
    writeVaultEntry(AUTHORITY_SEAL_KEY_ID_V2, generated);
    return { id: AUTHORITY_SEAL_KEY_ID_V2, key: Buffer.from(generated, 'hex') };
  }
  throw new AuthoritySealKeyMissingError();
}

/**
 * First-run provisioning of the host-local seal key.
 *
 * The key has no meaning outside this install, so there is nothing to fetch and
 * nothing a user can supply — but it must exist BEFORE the first typed
 * crossing, and until now only the test runner ever created one, so typed
 * execution could not work out of the box on any install. Minting it lazily at
 * use time would be worse: a vault that lost its key would silently mint a
 * replacement and orphan every authority already sealed under the old one.
 * Provisioning at boot keeps "absent at rest" a reportable state rather than a
 * self-healing one.
 *
 * Returns true when a key was created. An existing key — vault or env — is
 * never replaced; rotation is `rotateAuthoritySealKey`, which retains v1.
 */
export function provisionAuthoritySealKey(): boolean {
  if (keyForId(AUTHORITY_SEAL_KEY_ID_V2)) return false;
  writeVaultEntry(AUTHORITY_SEAL_KEY_ID_V2, randomBytes(32).toString('hex'));
  return true;
}

export function rotateAuthoritySealKey(nextHex: string): void {
  const next = hexKey(nextHex);
  if (!next) throw new Error('authority seal key must be 32 bytes of hex');
  const previous = keyForId(AUTHORITY_SEAL_KEY_ID_V2);
  if (previous) writeVaultEntry(AUTHORITY_SEAL_KEY_ID_V1, previous.toString('hex'));
  writeVaultEntry(AUTHORITY_SEAL_KEY_ID_V2, nextHex.trim());
}

export function sealCanonicalArguments(args: Record<string, unknown>): string {
  const plain = Buffer.from(JSON.stringify(args), 'utf8');
  if (plain.byteLength > AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES) {
    throw new Error('canonical arguments exceed the sealed plaintext limit');
  }
  const { id, key } = currentKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.from(JSON.stringify({
    v: SEAL_VERSION,
    kid: id,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: encrypted.toString('base64'),
  }), 'utf8').toString('base64');
  if (Buffer.byteLength(packed, 'utf8') > AUTHORITY_ARGUMENT_MAX_CIPHER_BYTES) {
    throw new Error('canonical arguments exceed the sealed ciphertext limit');
  }
  return packed;
}

export function openCanonicalArguments(cipherText: string): Record<string, unknown> | null {
  try {
    if (Buffer.byteLength(cipherText, 'utf8') > AUTHORITY_ARGUMENT_MAX_CIPHER_BYTES) return null;
    const parsed = JSON.parse(Buffer.from(cipherText, 'base64').toString('utf8')) as {
      v?: number;
      kid?: string;
      iv?: string;
      tag?: string;
      ct?: string;
    };
    if ((parsed.v !== 1 && parsed.v !== SEAL_VERSION) || !parsed.iv || !parsed.tag || !parsed.ct) return null;
    const candidates = parsed.kid
      ? [parsed.kid, AUTHORITY_SEAL_KEY_ID_V2, AUTHORITY_SEAL_KEY_ID_V1]
      : [AUTHORITY_SEAL_KEY_ID_V2, AUTHORITY_SEAL_KEY_ID_V1];
    let lastMissing = false;
    for (const id of candidates) {
      const key = keyForId(id);
      if (!key) {
        lastMissing = true;
        continue;
      }
      lastMissing = false;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(parsed.ct, 'base64')),
          decipher.final(),
        ]);
        if (plain.byteLength > AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES) return null;
        const args = JSON.parse(plain.toString('utf8')) as unknown;
        if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
        return args as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    if (lastMissing && !keyForId(AUTHORITY_SEAL_KEY_ID_V2)) throw new AuthoritySealKeyMissingError();
    return null;
  } catch (error) {
    if (error instanceof AuthoritySealKeyMissingError) throw error;
    return null;
  }
}
