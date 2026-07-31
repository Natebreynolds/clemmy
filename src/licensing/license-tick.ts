/**
 * The periodic license conversation.
 *
 * Runs on a timer, never in the boot path — a slow license server must never
 * become a slow app launch. Every outcome is written to the lease store so the
 * console can tell the user the truth about when we last succeeded.
 */
import pino from 'pino';
import { readSecret } from '../runtime/secrets/index.js';
import { activateLicense, renewLease } from './license-client.js';
import { readLeaseRecord, updateLeaseRecord } from './lease-store.js';
import { effectiveNowMs, shouldRenew, verifyLease } from './lease.js';

const logger = pino({ name: 'clementine-next.licensing' });

export interface LicenseTickResult {
  ran: boolean;
  outcome?: 'ok' | 'rejected' | 'unreachable';
  reason?: string;
}

/**
 * One check. Idempotent and safe to call as often as you like — it only talks
 * to the network when there is no lease or the current one is into its final
 * third.
 */
export async function tickLicense(opts: { pairId?: string | null; force?: boolean } = {}): Promise<LicenseTickResult> {
  let licenseKey = '';
  try {
    licenseKey = (await readSecret('license_key')) ?? '';
  } catch {
    licenseKey = '';
  }
  if (!licenseKey) return { ran: false, reason: 'no_key' };

  const record = readLeaseRecord();
  const now = effectiveNowMs(Date.now(), record.serverTimeHighWater);

  // Still fresh enough? Then don't spend a request.
  if (!opts.force && record.leaseCompact) {
    const verdict = verifyLease(record.leaseCompact, now);
    if (verdict.ok && !shouldRenew(verdict.payload, now)) {
      return { ran: false, reason: 'lease_fresh' };
    }
  }

  const hasActivation = Boolean(record.activationId);
  const result = hasActivation
    ? await renewLease(licenseKey, { activationId: record.activationId, pairId: opts.pairId })
    : await activateLicense(licenseKey, { pairId: opts.pairId });

  const at = new Date().toISOString();

  if (result.outcome === 'unreachable') {
    // Deliberately does NOT touch the cached lease. This is the branch that
    // keeps a server outage from becoming a customer outage.
    updateLeaseRecord({
      lastCheckAt: at,
      lastCheckOutcome: 'unreachable',
      consecutiveFailures: (record.consecutiveFailures ?? 0) + 1,
    });
    logger.debug('licensing: license server unreachable; keeping cached lease');
    return { ran: true, outcome: 'unreachable' };
  }

  if (result.outcome === 'rejected') {
    // An explicit no. Drop the lease so the posture reflects reality
    // immediately rather than coasting on grace it no longer deserves.
    updateLeaseRecord({
      leaseCompact: undefined,
      payload: undefined,
      lastCheckAt: at,
      lastCheckOutcome: 'rejected',
      lastCheckMessage: result.message,
      consecutiveFailures: 0,
    });
    logger.warn({ code: result.code }, 'licensing: license rejected by server');
    return { ran: true, outcome: 'rejected', reason: result.code };
  }

  const verdict = verifyLease(result.lease!, Date.now());
  if (!verdict.ok) {
    // The server handed us something we can't verify — a signing-key mismatch
    // between server and client. Treat it as unreachable: it is our bug, and
    // the customer must not pay for it.
    logger.error({ reason: verdict.reason }, 'licensing: server returned an unverifiable lease');
    updateLeaseRecord({
      lastCheckAt: at,
      lastCheckOutcome: 'unreachable',
      consecutiveFailures: (record.consecutiveFailures ?? 0) + 1,
    });
    return { ran: true, outcome: 'unreachable', reason: verdict.reason };
  }

  updateLeaseRecord({
    leaseCompact: result.lease,
    payload: verdict.payload,
    activationId: result.activationId ?? record.activationId,
    serverTimeHighWater: verdict.payload.srv,
    lastKnownEnforce: Boolean(verdict.payload.enforce),
    lastCheckAt: at,
    lastCheckOutcome: 'ok',
    lastCheckMessage: undefined,
    consecutiveFailures: 0,
  });
  logger.info(
    { plan: verdict.payload.plan, enforcing: verdict.payload.enforce },
    'licensing: lease refreshed',
  );
  return { ran: true, outcome: 'ok' };
}

/**
 * Renewal interval with jitter, so a thousand installs don't all wake on the
 * same second and stampede the server.
 */
export function licenseTickIntervalMs(): number {
  const base = 6 * 60 * 60 * 1000;
  return Math.round(base * (0.9 + Math.random() * 0.2));
}
