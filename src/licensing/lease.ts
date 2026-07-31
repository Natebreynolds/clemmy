/**
 * Offline lease verification.
 *
 * Pure: no I/O, no clock of its own — `now` is always an argument, so every
 * time-dependent branch is directly testable. The signing half lives in
 * apps/license/lease.mjs and the two are pinned together by golden vectors in
 * lease.test.ts.
 *
 * Two rules that carry the whole security of the format:
 *
 *   1. The signature is verified over the EXACT received `header.payload`
 *      substring, never over a re-serialization of the parsed object. Parsing
 *      first and re-encoding is the classic JWT-family hole: JSON has many
 *      encodings of the same object, so an attacker can smuggle a difference
 *      past a signature that was checked against their re-encoding.
 *   2. `alg` must be the literal string 'Ed25519'. No algorithm agility, no
 *      'none', no downgrade.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { licensePublicKeys, type LicensePublicKey } from './license-keys.js';

export interface LeasePayload {
  v: number;
  jti: string;
  tenant: string;
  product: string;
  licenseId: string;
  activationId: string;
  mid: string;
  pair: string | null;
  plan: string;
  features: string[];
  seat: { used: number; limit: number };
  /** Server-controlled kill switch — see apps/license/lease.mjs. */
  enforce: boolean;
  iat: number;
  nbf: number;
  exp: number;
  /** Seconds past `exp` the client should keep working. */
  grace: number;
  /** Server time at issuance; the client keeps a monotonic high-water mark. */
  srv: number;
}

export type LeaseVerdict =
  | { ok: true; payload: LeasePayload; state: 'active' | 'stale' }
  | { ok: false; reason: 'malformed' | 'bad_alg' | 'unknown_kid' | 'bad_signature' | 'not_yet_valid' | 'expired' };

/** Laptop clocks drift; a dead CMOS battery is not piracy. */
const SKEW_SECONDS = 600;

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Verifies signature and time window.
 *
 * `state` distinguishes a lease that is current from one past `exp` but still
 * inside its grace window — both keep the product working, but the second
 * should be surfaced so the user knows a renewal has been failing.
 */
export function verifyLease(
  compact: string,
  nowMs: number,
  keys: LicensePublicKey[] = licensePublicKeys(),
): LeaseVerdict {
  const parts = String(compact ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: unknown; kid?: unknown };
  let payload: LeasePayload;
  try {
    header = decodeSegment(headerB64) as { alg?: unknown; kid?: unknown };
    payload = decodeSegment(payloadB64) as LeasePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'Ed25519') return { ok: false, reason: 'bad_alg' };

  const key = keys.find((k) => k.kid === header.kid);
  if (!key) return { ok: false, reason: 'unknown_kid' };

  // The exact bytes that were signed — reconstructed from the input, not from
  // the parsed objects. See rule 1 in the module header.
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
  let verified = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.spkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    verified = cryptoVerify(null, signingInput, publicKey, Buffer.from(signatureB64, 'base64url'));
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'bad_signature' };

  const nowSeconds = Math.floor(nowMs / 1000);
  if (typeof payload.nbf === 'number' && nowSeconds + SKEW_SECONDS < payload.nbf) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  const graceEnd = payload.exp + (payload.grace ?? 0);
  if (nowSeconds - SKEW_SECONDS > graceEnd) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    payload,
    state: nowSeconds - SKEW_SECONDS > payload.exp ? 'stale' : 'active',
  };
}

/** Renew once the lease is into its final third — well before it goes stale. */
export function shouldRenew(payload: LeasePayload, nowMs: number): boolean {
  const nowSeconds = Math.floor(nowMs / 1000);
  const lifetime = payload.exp - payload.iat;
  if (lifetime <= 0) return true;
  return nowSeconds >= payload.iat + Math.floor((lifetime * 2) / 3);
}

/**
 * The clock a licensing decision should use.
 *
 * Winding the local clock back must not extend a lease, so the effective time
 * never falls below the newest server timestamp we have already seen.
 */
export function effectiveNowMs(localNowMs: number, serverTimeHighWaterSeconds: number | undefined): number {
  if (!serverTimeHighWaterSeconds) return localNowMs;
  return Math.max(localNowMs, serverTimeHighWaterSeconds * 1000);
}
