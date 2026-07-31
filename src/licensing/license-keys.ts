/**
 * The public keys a lease may be signed with.
 *
 * Baked into the build on purpose. The daemon must NEVER fetch a verification
 * key at runtime — a fetched key would turn a compromise of the license server
 * into a compromise of every client, which is precisely the property offline
 * verification exists to avoid.
 *
 * Two slots from day one so rotation is a config change rather than an
 * emergency release: publish `k2` in a client build, wait for adoption, flip
 * the server to sign with it, then retire `k1`.
 */

export interface LicensePublicKey {
  kid: string;
  /** base64 SPKI DER — what `node:crypto` createPublicKey wants. */
  spkiBase64: string;
}

const BAKED_KEYS: LicensePublicKey[] = [
  { kid: 'k1', spkiBase64: 'MCowBQYDK2VwAyEA2lYZnWeLrMNSrP5AwVAv5359pVCJu/nD2Y2NrvASZc8=' },
];

/**
 * Dev/self-host override, e.g. `k1:BASE64,k2:BASE64`. Deliberately additive to
 * nothing — when set it REPLACES the baked ring, so a test server cannot be
 * silently accepted alongside production.
 */
export function licensePublicKeys(env: NodeJS.ProcessEnv = process.env): LicensePublicKey[] {
  const override = env.CLEMENTINE_LICENSE_PUBKEYS?.trim();
  if (!override) return BAKED_KEYS;
  const parsed = override
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx <= 0) return null;
      return { kid: entry.slice(0, idx), spkiBase64: entry.slice(idx + 1) };
    })
    .filter((k): k is LicensePublicKey => k !== null);
  return parsed.length > 0 ? parsed : BAKED_KEYS;
}

/** Where the daemon talks to. Overridable so tests never hit production. */
export function licenseServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CLEMENTINE_LICENSE_URL?.trim() || 'https://license-production-f998.up.railway.app').replace(/\/+$/, '');
}
