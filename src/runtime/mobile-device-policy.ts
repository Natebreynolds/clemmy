/**
 * Kill switch for device-bound sessions.
 *
 * Separate tiny module so both the enforcement path (mobile-routes) and the
 * posture check (mobile-auth-posture) can read it without importing each other.
 *
 * This is an escape hatch, not a rollout flag: device binding is the DEFAULT and
 * validated behavior. It exists so a user whose browser cannot do WebCrypto or
 * IndexedDB — or who hits an unforeseen upgrade bug in the field — can get back
 * in without waiting for a release. Turning it off is a real downgrade, so the
 * posture check treats it as blocking and the QR gate refuses.
 */
export function deviceKeyRequired(): boolean {
  return (process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY ?? '').trim().toLowerCase() !== 'false';
}
