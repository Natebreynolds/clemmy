/**
 * Device-bound session proofs (DPoP-shaped).
 *
 * The gap this closes: a mobile session was a bearer cookie with a 30-day TTL
 * and no rotation. Anything that could read that cookie once — a stolen or
 * unlocked phone, a backup, a malicious extension, a copied cookie jar — held
 * full access for a month, and the daemon had no way to tell the thief from the
 * owner. That matters more here than in most apps, because a mobile session has
 * full capability parity with the desktop: it can drive the agent loop, which
 * can run shell commands.
 *
 * The fix is to stop treating possession of the cookie as sufficient. On first
 * pair the phone generates a P-256 keypair with `extractable: false` and keeps
 * it in IndexedDB. The private key cannot be read back out by ANY page script —
 * not by XSS, not by the app itself — only *used* to sign. Every authenticated
 * request carries a short signature over (method, path, timestamp, nonce,
 * session fingerprint). Stealing the cookie now gets you nothing without a key
 * you cannot copy.
 *
 * Deliberately not a JOSE dependency: Node's crypto does ES256 natively, and
 * the verification surface here is small enough that owning it outright is
 * safer than pulling in a general-purpose JWT library whose defaults (notably
 * algorithm agility) are exactly the footgun we want closed.
 */
import { createHash, createPublicKey, randomUUID, verify as cryptoVerify } from 'node:crypto';

export interface DeviceProofClaims {
  /** HTTP method the proof is bound to. */
  htm: string;
  /** Request path the proof is bound to. */
  htu: string;
  /** Issued-at, Unix seconds. */
  iat: number;
  /** Unique nonce, for replay detection. */
  jti: string;
  /** Session fingerprint — binds this proof to one session token. */
  sfp: string;
}

export type DeviceProofFailure =
  | 'MALFORMED'
  | 'BAD_ALG'
  | 'BAD_SIGNATURE'
  | 'METHOD_MISMATCH'
  | 'PATH_MISMATCH'
  | 'SESSION_MISMATCH'
  | 'STALE'
  | 'REPLAYED';

export type DeviceProofResult =
  | { ok: true; jti: string }
  | { ok: false; reason: DeviceProofFailure };

/** Accepted clock skew in either direction. */
export const PROOF_SKEW_MS = 120_000;

const REPLAY_TTL_MS = PROOF_SKEW_MS * 2;

/**
 * Seen-nonce cache.
 *
 * Memory-only on purpose. A restart reopens at most a PROOF_SKEW_MS window, and
 * even inside it a replayed proof is still bound to one method, one path, and
 * one session token — so the exposure is a repeat of a request the holder could
 * already make, not an escalation. Persisting this would add write amplification
 * on every authenticated request for almost no security gain.
 */
const seenNonces = new Map<string, number>();

function sweepNonces(now: number): void {
  if (seenNonces.size < 512) return;
  for (const [jti, expiry] of seenNonces) {
    if (expiry <= now) seenNonces.delete(jti);
  }
}

/** Binds a proof to one specific session token. */
export function sessionFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json) as unknown;
}

export interface VerifyDeviceProofInput {
  proof: string;
  publicKeyJwk: JsonWebKey;
  method: string;
  path: string;
  sessionFingerprint: string;
  now?: number;
}

/**
 * Verifies a device proof.
 *
 * Order matters: cheap structural and binding checks run before the signature
 * check so a flood of malformed proofs cannot force expensive EC verifies.
 */
export async function verifyDeviceProof(input: VerifyDeviceProofInput): Promise<DeviceProofResult> {
  const now = input.now ?? Date.now();
  const parts = (input.proof ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'MALFORMED' };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown };
  let claims: Partial<DeviceProofClaims>;
  try {
    header = decodeSegment(headerPart) as { alg?: unknown; typ?: unknown };
    claims = decodeSegment(payloadPart) as Partial<DeviceProofClaims>;
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') {
    return { ok: false, reason: 'MALFORMED' };
  }

  // Algorithm is pinned, and checked BEFORE the key is touched. This is the
  // classic JWT alg-confusion footgun: accepting 'none' skips verification
  // entirely, and accepting an HMAC alg would let a caller sign with the
  // PUBLIC key as the shared secret. Neither is reachable here.
  if (header.alg !== 'ES256') return { ok: false, reason: 'BAD_ALG' };

  if (typeof claims.jti !== 'string' || !claims.jti) return { ok: false, reason: 'MALFORMED' };
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (typeof claims.htm !== 'string' || typeof claims.htu !== 'string') {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (claims.htm.toUpperCase() !== input.method.toUpperCase()) {
    return { ok: false, reason: 'METHOD_MISMATCH' };
  }
  if (normalizePath(claims.htu) !== normalizePath(input.path)) {
    return { ok: false, reason: 'PATH_MISMATCH' };
  }
  // Without this a proof captured for session A could be replayed against a
  // different session belonging to the same key.
  if (claims.sfp !== input.sessionFingerprint) {
    return { ok: false, reason: 'SESSION_MISMATCH' };
  }

  const iatMs = claims.iat * 1000;
  if (Math.abs(now - iatMs) > PROOF_SKEW_MS) return { ok: false, reason: 'STALE' };

  sweepNonces(now);
  const seenExpiry = seenNonces.get(claims.jti);
  if (seenExpiry !== undefined && seenExpiry > now) return { ok: false, reason: 'REPLAYED' };

  let ok = false;
  try {
    const key = createPublicKey({ key: input.publicKeyJwk as never, format: 'jwk' });
    ok = cryptoVerify(
      'sha256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      // WebCrypto ECDSA emits raw r||s; Node defaults to DER, so this must be
      // stated explicitly or every browser-generated proof fails to verify.
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signaturePart, 'base64url'),
    );
  } catch {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
  if (!ok) return { ok: false, reason: 'BAD_SIGNATURE' };

  // Only record the nonce once the proof is fully valid — otherwise a caller
  // could burn a legitimate nonce by replaying it with a broken signature.
  seenNonces.set(claims.jti, now + REPLAY_TTL_MS);
  return { ok: true, jti: claims.jti };
}

function normalizePath(value: string): string {
  const withoutQuery = value.split('?')[0] ?? '';
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : '/';
}

/** Shape check for a stored public key, so junk never reaches createPublicKey. */
export function isSupportedDeviceKey(jwk: unknown): jwk is JsonWebKey {
  if (!jwk || typeof jwk !== 'object') return false;
  const candidate = jwk as JsonWebKey;
  return candidate.kty === 'EC'
    && candidate.crv === 'P-256'
    && typeof candidate.x === 'string'
    && typeof candidate.y === 'string'
    // A private component must never be sent to or stored by the server.
    && (candidate as { d?: unknown }).d === undefined;
}

/** Test seam. */
export function resetProofReplayCacheForTests(): void {
  seenNonces.clear();
}

/** Exposed for tests and for the client-side signer contract. */
export function buildProofNonce(): string {
  return randomUUID();
}
