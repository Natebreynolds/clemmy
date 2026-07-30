/**
 * Is this daemon's own auth strong enough to expose the mobile door?
 *
 * The gate asks a question we can actually answer from real runtime state: is
 * OUR OWN posture sound? A mobile session can drive the agent loop, which can
 * run shell commands, so the pairing QR is blocked while any blocking gap is
 * open.
 *
 * This must stay honest. Every check below inspects real runtime state; none of
 * them return a constant. If this file ever degrades into `{ ok: true }`, the
 * QR gate becomes meaningless and the surface is exposed by default.
 */
import { hasPin, pinNeedsRotation } from './mobile-pin.js';
import { deviceKeyRequired } from './mobile-device-policy.js';

export interface MobileAuthPostureGap {
  code:
    | 'DEVICE_BINDING_DISABLED'
    | 'WEAK_PIN_ONLY';
  /** Shown to the user, so it must say what to do, not just what is wrong. */
  message: string;
  /** false = advisory; true = blocks the QR. */
  blocking: boolean;
}

export interface MobileAuthPosture {
  ok: boolean;
  gaps: MobileAuthPostureGap[];
}

/**
 * Evaluates the daemon's own defenses.
 *
 * Note what is NOT checked: the presence of a PIN. Pairing via QR is always
 * available and is the stronger credential (single-use, 256-bit, and it
 * establishes a device key), so requiring a PIN would add a setup step without
 * adding security. A PIN is a recovery factor, not a prerequisite.
 */
export function mobileAuthPosture(opts?: { stateDir?: string }): MobileAuthPosture {
  const gaps: MobileAuthPostureGap[] = [];

  // Without device binding a session is a pure bearer cookie again, which is
  // precisely the exposure that made a public surface unsafe.
  if (!deviceKeyRequired()) {
    gaps.push({
      code: 'DEVICE_BINDING_DISABLED',
      message:
        'Device binding is turned off (CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY=false), so a '
        + 'copied session cookie would be enough to sign in. Re-enable it before exposing '
        + 'this Mac to the internet.',
      blocking: true,
    });
  }

  // Advisory: a weak PIN can still sign in, but only into the rotation sandbox,
  // so it is not an exposure — just something worth clearing up.
  if (hasPin(opts) && pinNeedsRotation(opts)) {
    gaps.push({
      code: 'WEAK_PIN_ONLY',
      message:
        'Your PIN predates the 8-character minimum. It still works, but only to set a '
        + 'new one until you rotate it.',
      blocking: false,
    });
  }

  return { ok: gaps.every((gap) => !gap.blocking), gaps };
}
