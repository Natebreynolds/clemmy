/**
 * License keys — the opaque secret a customer pastes in once.
 *
 * Shape: `clem_live_<tenant>_<32 chars of Crockford base32>`
 *
 * The tenant slug rides in the plaintext so a forked product can route to its
 * own tenant without a database lookup, and `live`/`test` leaves room for a
 * sandbox later. The secret half is 160 bits of CSPRNG output.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Crockford base32 minus I, L, O, U — the characters people misread or that
// form unfortunate words. A key gets read aloud and retyped; that matters more
// here than squeezing out entropy per character.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_CHARS = 32;

export function generateLicenseKey({ tenantSlug, env = 'live' }) {
  // Rejection sampling keeps the distribution uniform; the modulo shortcut
  // would bias toward the front of the alphabet.
  let secret = '';
  while (secret.length < SECRET_CHARS) {
    for (const byte of randomBytes(SECRET_CHARS)) {
      if (byte >= 248) continue;
      secret += ALPHABET[byte % 32];
      if (secret.length === SECRET_CHARS) break;
    }
  }
  return `clem_${env}_${tenantSlug}_${secret}`;
}

/**
 * Plain SHA-256, deliberately not argon2/bcrypt. The key is 160 bits of
 * random — there is no dictionary to attack and no human-chosen password to
 * protect. A slow hash here would only make activation slow.
 */
export function hashLicenseKey(key) {
  return createHash('sha256').update(key, 'utf8').digest();
}

export function parseLicenseKey(key) {
  const match = /^clem_(live|test)_([a-z0-9-]{1,32})_([0-9A-HJKMNP-TV-Z]{32})$/.exec(String(key ?? '').trim());
  if (!match) return null;
  return { env: match[1], tenantSlug: match[2], secret: match[3] };
}

/** Shown in the admin so a key is recognizable without being usable. */
export function keyDisplay(key) {
  const parsed = parseLicenseKey(key);
  if (!parsed) return { prefix: '', last4: '' };
  return {
    prefix: `clem_${parsed.env}_${parsed.tenantSlug}`,
    last4: parsed.secret.slice(-4),
  };
}

/** Constant-time compare for admin tokens and other fixed-length secrets. */
export function safeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Peppered so a database leak is not a census of installs. */
export function hashMachineId(machineId, pepper) {
  return createHash('sha256').update(`${pepper}:${machineId}`, 'utf8').digest();
}

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest();
}
