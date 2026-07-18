/**
 * Verifies whether Cloudflare Access is actually enforcing on a hostname.
 *
 * The state this replaces was `{ acknowledged: true, enabled: true }` — two
 * booleans a user set by ticking "I've enabled Access". Nothing ever checked.
 * A user who ticked without doing the work believed they had a second line of
 * defense and did not.
 *
 * The probe is deliberately the same request an anonymous attacker would make:
 * fetch the mobile surface from outside with no credentials and see who
 * answers. If Cloudflare intercepts, Access is enforcing. If our own JSON comes
 * back, it is not — whatever the checkbox says.
 */
import { readMobileAccess, updateMobileAccess, type MobileAccessStoreOptions } from '../runtime/mobile-access-state.js';

export type AccessProbeEvidence =
  | 'redirect-to-cloudflareaccess'
  | 'access-jwt-required'
  | 'origin-served'
  | 'probe-failed';

export interface AccessProbeResult {
  hostname: string;
  enforcing: boolean;
  checkedAt: string;
  evidence: AccessProbeEvidence;
  detail?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

export async function probeCloudflareAccess(
  hostname: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number },
): Promise<AccessProbeResult> {
  const now = opts?.now?.() ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  const clean = hostname.trim().toLowerCase();
  if (!clean) {
    return { hostname: clean, enforcing: false, checkedAt, evidence: 'probe-failed', detail: 'no hostname' };
  }

  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(`https://${clean}/m/auth/status`, {
      method: 'GET',
      // Manual: a 302 to the Access login page IS the signal. Following it
      // would just land on Cloudflare's HTML and lose the evidence.
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    const location = res.headers.get('location') ?? '';
    if (res.status >= 300 && res.status < 400 && /cloudflareaccess\.com/i.test(location)) {
      return { hostname: clean, enforcing: true, checkedAt, evidence: 'redirect-to-cloudflareaccess' };
    }

    const hasAccessHeader = [...res.headers.keys()].some((key) => key.toLowerCase().startsWith('cf-access'));
    if (res.status === 401 || res.status === 403) {
      if (hasAccessHeader || /cloudflareaccess\.com/i.test(location)) {
        return { hostname: clean, enforcing: true, checkedAt, evidence: 'access-jwt-required' };
      }
    }

    if (res.status === 200) {
      // Confirm it is OUR body and not a Cloudflare interstitial that happens
      // to be a 200, so we do not report "not enforcing" for the wrong reason.
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const ours = Boolean(body && typeof body === 'object' && 'pinConfigured' in (body as object));
      return {
        hostname: clean,
        enforcing: false,
        checkedAt,
        evidence: ours ? 'origin-served' : 'probe-failed',
        detail: ours
          ? 'The mobile surface answered directly, so Cloudflare Access is not enforcing.'
          : 'Unrecognized 200 response; could not determine enforcement.',
      };
    }

    return {
      hostname: clean,
      enforcing: false,
      checkedAt,
      evidence: 'probe-failed',
      detail: `Unexpected status ${res.status}`,
    };
  } catch (err) {
    return {
      hostname: clean,
      enforcing: false,
      checkedAt,
      evidence: 'probe-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes and reconciles the stored acknowledgement with reality.
 *
 * A `probe-failed` result must NEVER downgrade a previously-verified true: a
 * flaky network is not evidence that Access was switched off, and flapping the
 * badge on every transient failure would train users to ignore it.
 */
export async function refreshCloudflareAccessVerification(
  hostname: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } & MobileAccessStoreOptions,
): Promise<AccessProbeResult> {
  const result = await probeCloudflareAccess(hostname, opts);
  const storeOpts = opts?.stateDir ? { stateDir: opts.stateDir } : undefined;
  const existing = readMobileAccess(storeOpts).cloudflareAccess;

  if (result.evidence === 'probe-failed' && existing?.verified?.enforcing) {
    return { ...result, enforcing: true, detail: `${result.detail ?? ''} (keeping last verified state)`.trim() };
  }

  await updateMobileAccess((current) => {
    const ack = current.cloudflareAccess;
    if (!ack || ack.hostname.trim().toLowerCase() !== result.hostname) return current;
    return {
      ...current,
      cloudflareAccess: {
        ...ack,
        // The user's claim is corrected by observation, not trusted over it.
        enabled: result.evidence === 'probe-failed' ? ack.enabled : result.enforcing,
        verified: {
          enforcing: result.enforcing,
          checkedAt: result.checkedAt,
          evidence: result.evidence,
        },
      },
    };
  }, storeOpts).catch(() => undefined);

  return result;
}
