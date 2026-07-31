/**
 * Lease signing — the ONLY place a lease is ever signed.
 *
 * A lease is a short-lived, Ed25519-signed statement that a given install is
 * licensed. The desktop app and the relay verify it OFFLINE with a public key,
 * which is what lets an install keep working for weeks when this server is
 * unreachable. That property is load-bearing: because the product is unusable
 * without a license, an outage here would otherwise lock out every paying
 * customer simultaneously.
 *
 * Format is JWT-shaped but hand-rolled — `b64url(header).b64url(payload).b64url(sig)` —
 * because Node signs Ed25519 natively and a JWT library would be a dependency
 * plus a menu of algorithms we do not want.
 *
 * Two rules the verifiers must follow, both easy to get wrong:
 *   1. Verify the exact received `header.payload` BYTES, never a
 *      re-serialization of the parsed object. Re-serializing lets an attacker
 *      smuggle differences past the signature.
 *   2. Reject any `alg` that is not the literal string 'Ed25519'. No agility,
 *      no 'none'.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign, randomUUID } from 'node:crypto';

export const LEASE_ALG = 'Ed25519';

export function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Signs a lease. `payload` is the claim set; the caller owns its contents so
 * that policy lives in the routes, not in the crypto.
 */
export function signLease(payload, { privateKeyPem, kid }) {
  const key = createPrivateKey(privateKeyPem);
  const header = { alg: LEASE_ALG, kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // Ed25519 takes a null digest — the algorithm hashes internally.
  const signature = cryptoSign(null, Buffer.from(signingInput, 'ascii'), key);
  return `${signingInput}.${b64url(signature)}`;
}

/** The public half, in the exact base64 form baked into clients. */
export function publicKeyBase64(privateKeyPem) {
  const pub = createPublicKey(createPrivateKey(privateKeyPem));
  return pub.export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * Builds the claim set. Kept separate from signing so tests can assert on the
 * shape without holding a key.
 *
 * `enforce` rides INSIDE the signed lease on purpose: it makes the kill switch
 * a server-controlled, unforgeable property. If enforcement misbehaves in the
 * field it can be turned off with one database update, and clients relax as
 * they renew — no client release, no app-store wait. An env var on the client
 * would have been both forgeable and un-flippable.
 */
export function buildLeasePayload({
  tenant,
  product,
  licenseId,
  activationId,
  machineIdHashHex,
  pairId,
  plan,
  features,
  seatUsed,
  seatLimit,
  enforce,
  leaseTtlSeconds,
  graceSeconds,
  now = Date.now(),
}) {
  const iat = Math.floor(now / 1000);
  return {
    v: 1,
    jti: randomUUID(),
    tenant,
    product,
    licenseId,
    activationId,
    // Peppered hash, never the raw machine id — a database leak must not be a
    // cross-linkable census of who runs what.
    mid: machineIdHashHex,
    pair: pairId ?? null,
    plan,
    features: features ?? [],
    seat: { used: seatUsed, limit: seatLimit },
    enforce: Boolean(enforce),
    iat,
    nbf: iat - 60,
    exp: iat + leaseTtlSeconds,
    // How long past exp the CLIENT should keep working. The relay ignores this
    // entirely and uses its own clock — grace is a kindness to users on
    // planes, not a hole in enforcement.
    grace: graceSeconds,
    // Server time at issuance. Clients keep this as a monotonic high-water
    // mark so winding the local clock back cannot extend a lease.
    srv: iat,
  };
}
