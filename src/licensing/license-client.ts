/**
 * Talking to the license server.
 *
 * The single most important thing in this file is the classification: only an
 * explicit rejection (401/403/402) may ever mean "not licensed". A timeout, a
 * 500, a captive portal, a DNS failure, a laptop lid closing mid-request —
 * every one of those means "keep the cached lease and try later". Getting this
 * backwards would turn a blip in one service into a global outage for people
 * who have paid.
 *
 * Transport shape follows the house style in src/runtime/secrets/registry.ts
 * (`probeBearer`): AbortController timeout, small surface, no dependency.
 */
import os from 'node:os';
import { getMachineId } from '../runtime/machine-id.js';
import { licenseServerUrl } from './license-keys.js';

export type LicenseCallOutcome = 'ok' | 'rejected' | 'unreachable';

export interface LicenseCallResult {
  outcome: LicenseCallOutcome;
  /** Present on ok. */
  lease?: string;
  activationId?: string;
  plan?: string;
  seat?: { used: number; limit: number };
  /** Present on rejected — the server's own words, shown to the user. */
  message?: string;
  code?: string;
}

const TIMEOUT_MS = 8000;

function installFacts(appVersion?: string): Record<string, unknown> {
  return {
    machineId: getMachineId(),
    appVersion: appVersion ?? process.env.npm_package_version ?? null,
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
  };
}

async function call(path: string, body: Record<string, unknown>): Promise<LicenseCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${licenseServerUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // The rejection band. Everything here is a deliberate statement by the
    // server about this license, so it is safe to act on.
    if (res.status === 401 || res.status === 403 || res.status === 402) {
      const parsed = await res.json().catch(() => ({}));
      return {
        outcome: 'rejected',
        code: typeof parsed.error === 'string' ? parsed.error : 'rejected',
        message: typeof parsed.message === 'string' ? parsed.message : 'This license is not active.',
      };
    }

    // Anything else non-OK is our problem, not the user's.
    if (!res.ok) return { outcome: 'unreachable' };

    const parsed = await res.json().catch(() => null) as
      | { lease?: string; activationId?: string; plan?: string; seat?: { used: number; limit: number } }
      | null;
    if (!parsed?.lease) return { outcome: 'unreachable' };
    return {
      outcome: 'ok',
      lease: parsed.lease,
      activationId: parsed.activationId,
      plan: parsed.plan,
      seat: parsed.seat,
    };
  } catch {
    // Abort, DNS, TLS, offline — all indistinguishable and all benign.
    return { outcome: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** First contact: binds this install to a seat and returns a lease. */
export async function activateLicense(
  licenseKey: string,
  opts: { appVersion?: string; pairId?: string | null; product?: string } = {},
): Promise<LicenseCallResult> {
  return call('/v1/activate', {
    licenseKey,
    product: opts.product ?? 'clementine',
    pairId: opts.pairId ?? null,
    hostnameHint: os.hostname().slice(0, 64),
    ...installFacts(opts.appVersion),
  });
}

/** Renewal. Cheap, frequent, and allowed to fail quietly. */
export async function renewLease(
  licenseKey: string,
  opts: { activationId?: string; appVersion?: string; pairId?: string | null } = {},
): Promise<LicenseCallResult> {
  return call('/v1/lease', {
    licenseKey,
    activationId: opts.activationId,
    pairId: opts.pairId ?? null,
    ...installFacts(opts.appVersion),
  });
}

/** Frees the seat so the user can move machines without contacting support. */
export async function deactivateLicense(licenseKey: string): Promise<LicenseCallResult> {
  return call('/v1/deactivate', { licenseKey, machineId: getMachineId() });
}

/**
 * Validates a key WITHOUT consuming a seat — used when the user pastes a key,
 * before it is saved. A real activation here would strand a phantom seat if
 * the save then failed.
 */
export async function probeLicenseKey(licenseKey: string): Promise<{ result: 'valid' | 'invalid' | 'unknown'; message?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${licenseServerUrl()}/v1/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseKey, dryRun: true, product: 'clementine' }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const parsed = await res.json().catch(() => ({})) as { message?: string };
      return { result: 'invalid', message: parsed.message ?? 'That key was not recognized.' };
    }
    if (res.ok) {
      const parsed = await res.json().catch(() => ({})) as { plan?: string; seat?: { used: number; limit: number } };
      return {
        result: 'valid',
        message: parsed.plan ? `${parsed.plan} · ${parsed.seat?.used ?? 0}/${parsed.seat?.limit ?? 1} seats used` : undefined,
      };
    }
    return { result: 'unknown', message: "Couldn't reach the license server — saved anyway." };
  } catch {
    // Can't reach the server: save it through rather than block the user.
    return { result: 'unknown', message: "Couldn't reach the license server — saved anyway." };
  } finally {
    clearTimeout(timer);
  }
}
