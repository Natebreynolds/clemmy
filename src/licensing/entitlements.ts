/**
 * What this install is entitled to.
 *
 * Everything else in the daemon should ask these questions rather than reading
 * the lease directly, so the licensing core stays a leaf that no feature
 * depends on structurally.
 */
import { licenseLocksFeatures, licensePosture, type LicensePosture } from './license-status.js';

export function currentPosture(): LicensePosture {
  return licensePosture();
}

export function currentPlan(): string | null {
  return licensePosture().plan;
}

/** Feature flags carried in the signed lease — future paid tiers hang here. */
export function hasFeature(name: string): boolean {
  const posture = licensePosture();
  if (licenseLocksFeatures(posture)) return false;
  return posture.features.includes(name);
}

/**
 * The gate. True when the product should refuse to do work.
 *
 * Callers must still allow: the console shell, the activation screen, and any
 * path that lets a user get their own data out. Locking someone out of their
 * own notes turns an annoyed customer into a motivated attacker, and it is not
 * something a license is for.
 */
export function isLocked(): boolean {
  return licenseLocksFeatures(licensePosture());
}

/** One sentence for the user, or null when nothing is wrong. */
export function lockMessage(): string | null {
  const posture = licensePosture();
  if (!licenseLocksFeatures(posture)) return null;
  const blocking = posture.gaps.find((gap) => gap.blocking);
  return blocking?.message ?? 'This copy of Clementine needs an active license.';
}
