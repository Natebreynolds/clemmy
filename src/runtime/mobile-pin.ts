/**
 * Mobile PWA PIN store.
 *
 * Persists a hashed PIN to `<stateDir>/mobile-pin.json`. The PIN is
 * the fallback auth factor for the mobile companion when QR pairing
 * isn't available; gated by Cloudflare Tunnel + per-IP rate-limit +
 * global daemon-wide attempt counter (see mobile-rate-limit.ts).
 *
 * **PIN policy (NEW PINs only):** 8-64 chars, mix of letters / digits /
 * symbols allowed. A 6-digit PIN behind a public hostname is too
 * weak — distributed brute-force against the per-IP limit can crack
 * 10^6 in ~2 days. The new floor + global limiter close that gap.
 *
 * Existing short-PIN records keep working through `verifyPin` so we
 * don't lock anyone out — but the next `setPin` call must meet the
 * new floor. `pinNeedsRotation()` flags weak existing PINs to the
 * dashboard so the user can be nudged to rotate.
 *
 * Layout:
 *   { version: 1, salt: <hex>, hash: <hex>, updatedAt: ISO, params: { N, r, p, keylen } }
 *
 * Each setPin() generates a fresh salt + N/r/p choice so rotating a
 * PIN doesn't reuse the previous derivation parameters. `verifyPin`
 * uses timingSafeEqual; mismatched lengths short-circuit but stay
 * constant-time within the same length class.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * OpenSSL caps scrypt memory at 32 MiB by default. Our N=2^15, r=8
 * lands ~at that cap and trips ERR_CRYPTO_INVALID_SCRYPT_PARAMS on
 * some Node builds. We pass an explicit 128 MiB ceiling so the derivation
 * has headroom without changing the security parameters.
 */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

export interface MobilePinRecord {
  version: 1;
  salt: string;
  hash: string;
  updatedAt: string;
  params: { N: number; r: number; p: number; keylen: number };
  /**
   * Plaintext PIN length captured at set time. Used by the dashboard
   * to flag weak PINs and nudge rotation. The value is metadata only —
   * the PIN itself is never persisted. Absent on records created
   * before this field was added (those are assumed weak by length
   * convention; pinNeedsRotation flags them).
   */
  length?: number;
}

/**
 * PIN policy enforced on `setPin`. 8 chars minimum, mix of letters /
 * digits / common symbols. 64 char ceiling avoids accidental
 * megabyte-PIN DoS at scrypt time. `verifyPin` is policy-free so old
 * 4-digit PINs still log in until they rotate.
 */
export const PIN_MIN_LENGTH = 8;
export const PIN_MAX_LENGTH = 64;
const PIN_ALLOWED_CHARS = /^[A-Za-z0-9 !@#$%^&*()_\-+={}[\]|\\:;"'<>,.?/~`]+$/;

export interface PinValidationError {
  code: 'TOO_SHORT' | 'TOO_LONG' | 'INVALID_CHARS' | 'EMPTY';
  message: string;
}

export function validatePinForSet(pin: string): PinValidationError | null {
  if (!pin) return { code: 'EMPTY', message: 'PIN is required.' };
  if (pin.length < PIN_MIN_LENGTH) {
    return { code: 'TOO_SHORT', message: `PIN must be at least ${PIN_MIN_LENGTH} characters.` };
  }
  if (pin.length > PIN_MAX_LENGTH) {
    return { code: 'TOO_LONG', message: `PIN must be at most ${PIN_MAX_LENGTH} characters.` };
  }
  if (!PIN_ALLOWED_CHARS.test(pin)) {
    return {
      code: 'INVALID_CHARS',
      message: 'PIN can only contain letters, digits, spaces, and common symbols.',
    };
  }
  return null;
}

/**
 * Defaults chosen for "interactive UX on a laptop, no GPU-grade
 * resistance needed". Verify takes ~50ms on a 2024 MacBook — fast
 * enough for a PIN tap, slow enough that the 5-attempts/15min limit
 * is the binding constraint, not CPU.
 */
const DEFAULT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 32 } as const;

function defaultPinFile(stateDir: string = path.join(BASE_DIR, 'state')): string {
  return path.join(stateDir, 'mobile-pin.json');
}

export interface MobilePinStoreOptions {
  stateDir?: string;
}

function pinFile(opts?: MobilePinStoreOptions): string {
  return opts?.stateDir ? path.join(opts.stateDir, 'mobile-pin.json') : defaultPinFile();
}

export function hasPin(opts?: MobilePinStoreOptions): boolean {
  const file = pinFile(opts);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<MobilePinRecord>;
    return typeof parsed?.hash === 'string' && parsed.hash.length > 0;
  } catch {
    return false;
  }
}

export async function setPin(pin: string, opts?: MobilePinStoreOptions): Promise<void> {
  const validation = validatePinForSet(pin);
  if (validation) {
    throw new Error(validation.message);
  }
  const salt = randomBytes(16);
  const derived = await scryptAsync(pin, salt, DEFAULT_PARAMS.keylen, {
    N: DEFAULT_PARAMS.N,
    r: DEFAULT_PARAMS.r,
    p: DEFAULT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
  const record: MobilePinRecord = {
    version: 1,
    salt: salt.toString('hex'),
    hash: derived.toString('hex'),
    updatedAt: new Date().toISOString(),
    params: { ...DEFAULT_PARAMS },
    length: pin.length,
  };
  const file = pinFile(opts);
  mkdirSync(path.dirname(file), { recursive: true });
  await atomicJsonMutate<MobilePinRecord | null>(file, () => record, null);
}

export async function verifyPin(pin: string, opts?: MobilePinStoreOptions): Promise<boolean> {
  const file = pinFile(opts);
  if (!existsSync(file)) return false;
  let record: MobilePinRecord;
  try {
    record = JSON.parse(readFileSync(file, 'utf-8')) as MobilePinRecord;
  } catch {
    return false;
  }
  if (record.version !== 1 || !record.salt || !record.hash) return false;
  const salt = Buffer.from(record.salt, 'hex');
  const stored = Buffer.from(record.hash, 'hex');
  const derived = await scryptAsync(pin, salt, record.params.keylen, {
    N: record.params.N,
    r: record.params.r,
    p: record.params.p,
    maxmem: SCRYPT_MAXMEM,
  });
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}

/** For ops/dashboards — never expose the hash itself. */
export function readPinMeta(opts?: MobilePinStoreOptions): {
  updatedAt: string;
  needsRotation: boolean;
  length?: number;
} | null {
  const file = pinFile(opts);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<MobilePinRecord>;
    if (typeof parsed?.updatedAt !== 'string') return null;
    return {
      updatedAt: parsed.updatedAt,
      length: typeof parsed.length === 'number' ? parsed.length : undefined,
      // Records without a length field were written under the old
      // 4-digit floor — flag them as weak by convention. New records
      // are flagged only if their captured length is below the floor
      // (shouldn't happen since setPin enforces the floor, but the
      // belt-and-braces check makes the contract explicit).
      needsRotation:
        typeof parsed.length !== 'number' || parsed.length < PIN_MIN_LENGTH,
    };
  } catch {
    return null;
  }
}

/**
 * True when an existing PIN was created before the modern floor (or
 * is otherwise too short) and should be rotated. Used by the
 * dashboard to surface a "Your PIN is weak — rotate it" banner.
 */
export function pinNeedsRotation(opts?: MobilePinStoreOptions): boolean {
  const meta = readPinMeta(opts);
  return Boolean(meta?.needsRotation);
}
