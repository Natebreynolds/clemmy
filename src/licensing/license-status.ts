/**
 * What state is this install's license in, and what should that change?
 *
 * Shape deliberately mirrors src/runtime/mobile-auth-posture.ts — `{ok, gaps}`
 * with a `blocking` flag per gap — because the console already knows how to
 * render that and because the same honesty rule applies: every branch here
 * reads real state, and none of them return a constant.
 *
 * The five states exist to keep two very different situations apart:
 *
 *   unlicensed  never had a key. A brand-new install. NOT a lapsed customer.
 *   active      verified and current.
 *   stale       past expiry, inside grace. Still works. The server has been
 *               unreachable, which is our problem, not the user's.
 *   expired     grace exhausted.
 *   revoked     the server explicitly said no. Skips grace — which is safe
 *               precisely because it required a successful conversation.
 *
 * Conflating `unlicensed` with `expired` is how a licensing rollout locks out
 * everyone who simply never received a key, so they are separate by
 * construction and only the last two ever gate anything.
 */
import { effectiveNowMs, verifyLease, type LeasePayload } from './lease.js';
import { readLeaseRecord, type LeaseRecord } from './lease-store.js';

export type LicenseState = 'unlicensed' | 'active' | 'stale' | 'expired' | 'revoked';

export interface LicenseGap {
  code: 'NO_KEY' | 'LEASE_STALE' | 'LEASE_EXPIRED' | 'LICENSE_REVOKED' | 'CLOCK_UNTRUSTED';
  /** Written for the person reading it, not for a log. */
  message: string;
  /** true = this is why features are locked. */
  blocking: boolean;
}

export interface LicensePosture {
  state: LicenseState;
  /** True when nothing should be gated. */
  ok: boolean;
  /**
   * Whether the SERVER has asked us to enforce. Rides inside the signed lease,
   * so it cannot be forged and can be flipped without a client release.
   */
  enforcing: boolean;
  plan: string | null;
  features: string[];
  seat: { used: number; limit: number } | null;
  expiresAt: string | null;
  lastCheckAt: string | null;
  lastCheckOutcome: string | null;
  gaps: LicenseGap[];
}

export function licensePosture(opts?: { stateDir?: string; hasKey?: boolean; now?: number }): LicensePosture {
  const record: LeaseRecord = readLeaseRecord(opts?.stateDir);
  const localNow = opts?.now ?? Date.now();
  const now = effectiveNowMs(localNow, record.serverTimeHighWater);
  const gaps: LicenseGap[] = [];

  // A clock behind the newest server time we've seen is worth surfacing but
  // never worth punishing — dead CMOS batteries are more common than piracy.
  const clockUntrusted = Boolean(record.serverTimeHighWater)
    && localNow < (record.serverTimeHighWater! * 1000) - 600_000;
  if (clockUntrusted) {
    gaps.push({
      code: 'CLOCK_UNTRUSTED',
      message: "This Mac's clock is behind — licensing uses the last known good time.",
      blocking: false,
    });
  }

  const base = {
    plan: null as string | null,
    features: [] as string[],
    seat: null as { used: number; limit: number } | null,
    expiresAt: null as string | null,
    lastCheckAt: record.lastCheckAt ?? null,
    lastCheckOutcome: record.lastCheckOutcome ?? null,
  };

  // Explicit rejection wins over anything cached.
  if (record.lastCheckOutcome === 'rejected') {
    return {
      ...base,
      state: 'revoked',
      ok: false,
      enforcing: true,
      gaps: [...gaps, {
        code: 'LICENSE_REVOKED',
        message: record.lastCheckMessage || 'This license is no longer active.',
        blocking: true,
      }],
    };
  }

  if (!record.leaseCompact) {
    const hasKey = opts?.hasKey ?? false;
    return {
      ...base,
      state: 'unlicensed',
      // A key that hasn't activated yet is not a failure — the tick will get
      // to it. Only a truly keyless install is flagged.
      ok: hasKey,
      enforcing: false,
      gaps: hasKey ? gaps : [...gaps, {
        code: 'NO_KEY',
        message: 'Enter your Clementine license key to activate this Mac.',
        blocking: true,
      }],
    };
  }

  const verdict = verifyLease(record.leaseCompact, now);
  if (!verdict.ok) {
    // A lease that fails verification is treated as expired rather than as
    // tampering: the benign causes (rotated key, truly out of grace) vastly
    // outnumber the malicious one, and the malicious one gains nothing here
    // because the relay checks independently.
    return {
      ...base,
      state: 'expired',
      ok: false,
      enforcing: true,
      gaps: [...gaps, {
        code: 'LEASE_EXPIRED',
        message: "Couldn't confirm your license for over two weeks. Reconnect to the internet to refresh it.",
        blocking: true,
      }],
    };
  }

  const payload: LeasePayload = verdict.payload;
  const detail = {
    plan: payload.plan,
    features: payload.features ?? [],
    seat: payload.seat ?? null,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    lastCheckAt: record.lastCheckAt ?? null,
    lastCheckOutcome: record.lastCheckOutcome ?? null,
  };

  if (verdict.state === 'stale') {
    return {
      ...detail,
      state: 'stale',
      ok: true, // still fully usable — this is the whole point of grace
      enforcing: Boolean(payload.enforce),
      gaps: [...gaps, {
        code: 'LEASE_STALE',
        message: "Couldn't reach the license server recently. Everything keeps working — we'll retry.",
        blocking: false,
      }],
    };
  }

  return {
    ...detail,
    state: 'active',
    ok: true,
    enforcing: Boolean(payload.enforce),
    gaps,
  };
}

/**
 * The one question the rest of the daemon asks.
 *
 * Locked only when the server is enforcing AND the license is genuinely dead.
 * Note what is NOT here: `unlicensed` and `stale` never lock, so a fresh
 * install and a laptop on a plane both keep working.
 */
export function licenseLocksFeatures(posture: LicensePosture): boolean {
  if (!posture.enforcing) return false;
  return posture.state === 'expired' || posture.state === 'revoked';
}
