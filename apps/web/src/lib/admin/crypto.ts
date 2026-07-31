/**
 * Admin auth primitives — password hashing and TOTP, both on node:crypto only.
 *
 * No bcrypt/otplib/speakeasy: this panel issues license keys, so its dependency
 * surface is deliberately zero. Everything here is standard-library and small
 * enough to audit in one sitting.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * scrypt cost. N=16384/r=8/p=1 needs 128*N*r = 16 MiB, which fits Node's
 * default 32 MiB maxmem and costs ~100 ms — slow enough to make offline
 * cracking expensive, fast enough that a login feels instant.
 */
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p },
      (err, key) => (err ? reject(err) : resolve(key as Buffer)),
    );
  });
}

/** Returns `salt:hash`, both hex — the format stored in ADMIN_PASSWORD_HASH. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = String(stored ?? "").split(":");
  if (!saltHex || !hashHex) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;

  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}

/** Length-safe constant-time string compare. */
export function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  // timingSafeEqual throws on length mismatch, and the throw itself leaks
  // length. Hash both sides first so the compare is always over 32 bytes.
  const ah = createHmac("sha256", "cmp").update(ab).digest();
  const bh = createHmac("sha256", "cmp").update(bb).digest();
  return timingSafeEqual(ah, bh);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — HMAC-SHA1, 30-second step, 6 digits.
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out; // unpadded: what authenticator apps expect in otpauth:// URLs
}

export function base32Decode(input: string): Buffer {
  // Authenticator secrets get copied around with spaces and padding; strip
  // anything that is not an alphabet character rather than rejecting.
  const clean = String(input ?? "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(bytes = 20): string {
  // 20 bytes = 160 bits, the RFC 4226 recommended HMAC-SHA1 key size.
  return base32Encode(randomBytes(bytes));
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(counterBuf).digest();

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);

  return String(binary % 1_000_000).padStart(6, "0");
}

export const TOTP_STEP_SECONDS = 30;

/**
 * Accepts the current step plus `window` steps either side, so a phone whose
 * clock drifts by up to 30s still works. Every candidate is evaluated (no early
 * return) so verification time does not depend on which step matched.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  { window = 1, now = Date.now() }: { window?: number; now?: number } = {},
): boolean {
  const digits = String(code ?? "").replace(/\D/g, "");
  if (digits.length !== 6) return false;

  const secret = base32Decode(secretBase32);
  if (secret.length === 0) return false;

  const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  let matched = false;
  for (let offset = -window; offset <= window; offset += 1) {
    if (safeEqualString(hotp(secret, counter + offset), digits)) matched = true;
  }
  return matched;
}

export function otpauthUrl({
  secret,
  account,
  issuer,
}: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
