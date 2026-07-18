/**
 * Is this daemon's own auth strong enough to face the public internet?
 *
 * Historically the pairing QR was gated on a Cloudflare Access acknowledgement:
 * two booleans the user set by ticking "I've enabled it". Nothing ever checked
 * whether Access was actually enforcing, so a user who ticked the box without
 * doing the work got a publicly-reachable /m/ surface defended by a PIN alone —
 * and a mobile session can drive the agent loop, which can run shell commands.
 *
 * Gating on someone's self-report is not a security control. So the gate now
 * asks a question we can actually answer: is OUR OWN posture sound? Cloudflare
 * Access becomes optional defense-in-depth rather than a required setup step,
 * which is also what collapses setup from "own a domain and configure a
 * Cloudflare app" to "install cloudflared, scan a QR".
 *
 * This must stay honest. Every check below inspects real runtime state; none of
 * them return a constant. If this file ever degrades into `{ ok: true }`, the
 * QR gate becomes meaningless and the surface is exposed by default.
 */
import { hasPin, pinNeedsRotation } from './mobile-pin.js';
import { ingressSplitEnabled } from './mobile-ingress.js';
import { deviceKeyRequired } from './mobile-device-policy.js';

export interface MobileAuthPostureGap {
  code:
    | 'DEVICE_BINDING_DISABLED'
    | 'INGRESS_SPLIT_DISABLED'
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

  // With a shared listener, a local caller can present the tunnel hostname and
  // be classified as tunnel-borne, which makes CF-Connecting-IP — and therefore
  // every per-IP rate limit — spoofable again.
  if (!ingressSplitEnabled()) {
    gaps.push({
      code: 'INGRESS_SPLIT_DISABLED',
      message:
        'The private tunnel ingress is disabled (CLEMENTINE_MOBILE_INGRESS=shared), so '
        + 'sign-in rate limits can be bypassed by spoofing a client IP.',
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
