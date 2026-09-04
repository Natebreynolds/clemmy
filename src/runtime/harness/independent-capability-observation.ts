/**
 * Crossing-time observation is a separate store from the trusted manifest.
 * Reservation reads this store; it does not copy fields off the binding
 * and does not rewrite a stored timestamp.
 *
 * origin=independent is produced only by invoking a registered observer.
 * Caller-declared independence or pack-authored fields cannot authorize.
 */
import { createHash } from 'node:crypto';
import { loadShippedImplementations, shippedImplementationDigest } from './shipped-implementation-identity.js';

export type CapabilityObservationOrigin = 'independent' | 'pack_attested';

export const INDEPENDENT_OBSERVATION_FRESHNESS_MS = 60_000;

export interface IndependentCapabilityObservation {
  operationId: string;
  accountId: string;
  definitionFingerprint: string;
  providerVersion: string;
  operationVersion: string;
  observedAt: number;
  origin: CapabilityObservationOrigin;
  observationId?: string;
  observerImplementationId?: string;
  observedBytesDigest?: string;
}

export interface IndependentObservationRegistration {
  operationId: string;
  accountId: string;
  definitionFingerprint: string;
  providerVersion: string;
  operationVersion: string;
  observedAt: number;
  origin: CapabilityObservationOrigin;
  observe?: () => Omit<IndependentCapabilityObservation, 'origin' | 'observationId'>;
}

interface StoredObservation {
  snapshot: IndependentCapabilityObservation;
  observe?: IndependentObservationRegistration['observe'];
}

const observations = new Map<string, StoredObservation>();

function keyOf(operationId: string, accountId: string): string {
  return `${operationId}\0${accountId}`;
}

export function observedBytesDigestOf(
  observation: Pick<
    IndependentCapabilityObservation,
    | 'operationId'
    | 'accountId'
    | 'definitionFingerprint'
    | 'providerVersion'
    | 'operationVersion'
    | 'observedAt'
  >,
): string {
  return createHash('sha256').update(JSON.stringify({
    operationId: observation.operationId,
    accountId: observation.accountId,
    definitionFingerprint: observation.definitionFingerprint,
    providerVersion: observation.providerVersion,
    operationVersion: observation.operationVersion,
    observedAt: observation.observedAt,
  }), 'utf8').digest('hex');
}

/**
 * Immutable observed identity: what was observed, never when.
 *
 * Admission and the crossing observe the capability at different instants, so
 * requiring the whole evidence to match would make an authority unusable by its
 * own reservation. Identity is what must be stable; the instant is freshness
 * evidence, checked separately by `observationIsFresh`.
 *
 * `observedAt`, `observationId` and `observedBytesDigest` all derive from the
 * instant and are deliberately excluded.
 */
export function observedIdentityDigestOf(
  observation: Pick<
    IndependentCapabilityObservation,
    | 'operationId'
    | 'accountId'
    | 'definitionFingerprint'
    | 'providerVersion'
    | 'operationVersion'
    | 'observerImplementationId'
  >,
): string {
  return createHash('sha256').update(JSON.stringify({
    domain: 'observed-capability-identity',
    version: 1,
    operationId: observation.operationId,
    accountId: observation.accountId,
    definitionFingerprint: observation.definitionFingerprint,
    providerVersion: observation.providerVersion,
    operationVersion: observation.operationVersion,
    observerImplementationId: observation.observerImplementationId ?? null,
  }), 'utf8').digest('hex');
}

/**
 * Exact identity parity between a frozen observation and a fresh one.
 * Origin is included: a pack-attested echo can never satisfy an independent
 * admission.
 */
export function observedIdentityMatches(
  frozen: Pick<IndependentCapabilityObservation,
    'operationId' | 'accountId' | 'definitionFingerprint' | 'providerVersion'
    | 'operationVersion' | 'observerImplementationId' | 'origin'>,
  live: Pick<IndependentCapabilityObservation,
    'operationId' | 'accountId' | 'definitionFingerprint' | 'providerVersion'
    | 'operationVersion' | 'observerImplementationId' | 'origin'>,
): boolean {
  return frozen.origin === live.origin
    && observedIdentityDigestOf(frozen) === observedIdentityDigestOf(live);
}

export function shippedObserverImplementationId(): string {
  return shippedImplementationDigest('observer');
}

export function observerImplementationIdOf(_observe?: () => unknown): string {
  return shippedObserverImplementationId();
}

export function observationDigestOf(
  observation: Pick<
    IndependentCapabilityObservation,
    | 'operationId'
    | 'accountId'
    | 'definitionFingerprint'
    | 'providerVersion'
    | 'operationVersion'
    | 'origin'
    | 'observedAt'
    | 'observationId'
    | 'observerImplementationId'
    | 'observedBytesDigest'
  >,
): string {
  return createHash('sha256').update(JSON.stringify({
    observationId: observation.observationId ?? observationIdOf(observation),
    observedAt: observation.observedAt,
    origin: observation.origin,
    operationId: observation.operationId,
    accountId: observation.accountId,
    definitionFingerprint: observation.definitionFingerprint,
    providerVersion: observation.providerVersion,
    operationVersion: observation.operationVersion,
    observerImplementationId: observation.observerImplementationId ?? null,
    observedBytesDigest: observation.observedBytesDigest ?? observedBytesDigestOf(observation),
  }), 'utf8').digest('hex');
}

export function observationIdOf(
  observation: Pick<IndependentCapabilityObservation, 'operationId' | 'accountId' | 'observedAt'>,
): string {
  return `obs:${observation.operationId}:${observation.accountId}:${observation.observedAt}`;
}

export function registerIndependentCapabilityObservation(
  observation: IndependentObservationRegistration,
): { ok: true } | { ok: false; reason: 'identity_exists' | 'observer_required' } {
  const requestedOrigin = observation.origin ?? 'pack_attested';
  if (requestedOrigin === 'independent') {
    try {
      shippedObserverImplementationId();
    } catch {
      return { ok: false, reason: 'observer_required' };
    }
  }
  const key = keyOf(observation.operationId, observation.accountId);
  const prior = observations.get(key);
  if (
    prior
    && (
      prior.snapshot.definitionFingerprint !== observation.definitionFingerprint
      || prior.snapshot.providerVersion !== observation.providerVersion
      || prior.snapshot.operationVersion !== observation.operationVersion
    )
  ) {
    return { ok: false, reason: 'identity_exists' };
  }
  const origin = requestedOrigin === 'independent' ? 'independent' : 'pack_attested';
  if (prior?.snapshot.origin === 'independent' && origin === 'pack_attested') {
    return { ok: true };
  }
  let observerImplementationId: string | undefined;
  if (observation.observe) {
    try {
      observerImplementationId = shippedObserverImplementationId();
    } catch {
      return { ok: false, reason: 'observer_required' };
    }
  }
  const snapshot: IndependentCapabilityObservation = {
    operationId: observation.operationId,
    accountId: observation.accountId,
    definitionFingerprint: observation.definitionFingerprint,
    providerVersion: observation.providerVersion,
    operationVersion: observation.operationVersion,
    observedAt: observation.observedAt,
    origin,
    observationId: observationIdOf(observation),
    ...(observerImplementationId ? { observerImplementationId } : {}),
    observedBytesDigest: observedBytesDigestOf(observation),
  };
  observations.set(key, {
    snapshot,
    ...(origin === 'independent' && observation.observe ? { observe: observation.observe } : {}),
  });
  return { ok: true };
}

/**
 * Compare-and-set a provider observation after its exact manifest lineage has
 * advanced.
 *
 * Ordinary registration intentionally rejects a changed identity for the same
 * operation+account. Definition drift needs one narrower path: a caller that
 * already holds the exact prior snapshot may replace it with a freshly
 * re-observable independent identity. The CAS prevents a stale/concurrent
 * publisher from overwriting newer provider bytes, and the observer must
 * reproduce the proposed identity before anything is stored.
 */
export function compareAndSetIndependentCapabilityObservation(input: {
  expected: IndependentCapabilityObservation;
  next: IndependentObservationRegistration & { origin: 'independent'; observe: NonNullable<IndependentObservationRegistration['observe']> };
}): { ok: true } | {
  ok: false;
  reason: 'identity_missing' | 'identity_changed' | 'lineage_mismatch' | 'observer_required';
} {
  if (
    input.expected.operationId !== input.next.operationId
    || input.expected.accountId !== input.next.accountId
  ) return { ok: false, reason: 'lineage_mismatch' };
  const key = keyOf(input.expected.operationId, input.expected.accountId);
  const prior = observations.get(key);
  if (!prior) return { ok: false, reason: 'identity_missing' };
  if (observationDigestOf(prior.snapshot) !== observationDigestOf(input.expected)) {
    return { ok: false, reason: 'identity_changed' };
  }
  let observerImplementationId: string;
  try {
    observerImplementationId = shippedObserverImplementationId();
  } catch {
    return { ok: false, reason: 'observer_required' };
  }
  let live: ReturnType<NonNullable<IndependentObservationRegistration['observe']>>;
  try {
    live = input.next.observe();
  } catch {
    return { ok: false, reason: 'observer_required' };
  }
  if (
    live.operationId !== input.next.operationId
    || live.accountId !== input.next.accountId
    || live.definitionFingerprint !== input.next.definitionFingerprint
    || live.providerVersion !== input.next.providerVersion
    || live.operationVersion !== input.next.operationVersion
  ) return { ok: false, reason: 'lineage_mismatch' };
  const snapshot: IndependentCapabilityObservation = {
    operationId: input.next.operationId,
    accountId: input.next.accountId,
    definitionFingerprint: input.next.definitionFingerprint,
    providerVersion: input.next.providerVersion,
    operationVersion: input.next.operationVersion,
    observedAt: live.observedAt,
    origin: 'independent',
    observationId: observationIdOf(live),
    observerImplementationId,
    observedBytesDigest: observedBytesDigestOf(live),
  };
  observations.set(key, { snapshot, observe: input.next.observe });
  return { ok: true };
}

/** Read the registered snapshot without invoking, refreshing, or restamping
 * its observer. Materializers use this only to reject an identity conflict
 * before installing any other authority-bearing surface. */
export function peekIndependentCapabilityObservation(
  operationId: string,
  accountId: string,
): IndependentCapabilityObservation | null {
  const prior = observations.get(keyOf(operationId, accountId));
  return prior ? { ...prior.snapshot } : null;
}

export function independentlyObserveCapability(
  operationId: string,
  accountId: string,
): IndependentCapabilityObservation | null {
  const prior = observations.get(keyOf(operationId, accountId));
  if (!prior) return null;
  if (prior.snapshot.origin !== 'independent') {
    return { ...prior.snapshot, origin: 'pack_attested' };
  }
  let observerImplementationId: string;
  try {
    observerImplementationId = shippedObserverImplementationId();
  } catch {
    return null;
  }
  try {
    const shipped = loadShippedImplementations();
    // Re-observe from the live source. Reading the registration snapshot back
    // would make observation an echo of what was registered; the observer must
    // report what the capability says now, so drift and staleness are real.
    // A restart-adopted observation has no synchronous re-observer. Once that
    // frozen transport snapshot is stale, do not deposit it back into the
    // transport before an async refresh: doing so can overwrite a newer remote
    // observation with the exact stale belief we are trying to verify. The
    // read-only call kernel may contact the attested transport once and then
    // retry this synchronous last-edge observation.
    if (!prior.observe && !observationIsFresh(prior.snapshot)) return null;
    const live = prior.observe ? prior.observe() : prior.snapshot;
    shipped.registerIsolatedObservation({
      operationId: live.operationId,
      accountId: live.accountId,
      definitionFingerprint: live.definitionFingerprint,
      providerVersion: live.providerVersion,
      operationVersion: live.operationVersion,
      observedAt: live.observedAt,
    });
    const observed = shipped.observeIndependently(prior.snapshot, observerImplementationId);
    if (observed) return observed;
  } catch {
    return prior.snapshot.origin === 'independent' ? null : { ...prior.snapshot, origin: 'pack_attested' };
  }
  return prior.snapshot.origin === 'independent'
    ? null
    : { ...prior.snapshot, origin: 'pack_attested' };
}

export function observationIsFresh(
  observation: IndependentCapabilityObservation,
  now = Date.now(),
): boolean {
  return observation.origin === 'independent'
    && Number.isFinite(observation.observedAt)
    && now - observation.observedAt >= 0
    && now - observation.observedAt <= INDEPENDENT_OBSERVATION_FRESHNESS_MS;
}

/**
 * Contact the provider through the attested transport and store what it
 * reports, so the crossing can read a real observation synchronously.
 *
 * Every real provider read is async and the crossing runs inside a SQLite
 * transaction, so refresh must happen out of band; the crossing then enforces
 * freshness. The observation is still produced by the attested observer — this
 * only gives that observer live bytes to verify. Returns null, honestly, when
 * the provider cannot be observed.
 */
export async function refreshIndependentCapabilityObservation(input: {
  operationId: string;
  accountId: string;
  definitionFingerprint: string;
  providerVersion: string;
  operationVersion: string;
}): Promise<IndependentCapabilityObservation | null> {
  let observerImplementationId: string;
  try {
    observerImplementationId = shippedObserverImplementationId();
  } catch {
    return null;
  }
  let shipped: ReturnType<typeof loadShippedImplementations>;
  try {
    shipped = loadShippedImplementations();
  } catch {
    return null;
  }
  const live = await shipped.refreshTransportObservation({
    operationId: input.operationId,
    accountId: input.accountId,
  });
  if (!live) {
    // Nothing observed. Drop any prior belief rather than let it age out
    // silently into a crossing.
    observations.delete(keyOf(input.operationId, input.accountId));
    return null;
  }
  const observed = shipped.observeIndependently(input, observerImplementationId);
  if (!observed || observed.origin !== 'independent') {
    observations.delete(keyOf(input.operationId, input.accountId));
    return null;
  }
  observations.set(keyOf(observed.operationId, observed.accountId), { snapshot: observed });
  return observed;
}

/**
 * Adopt what the attested transport already reports for this capability.
 *
 * Used by restart, which reconstructs ports but is handed no provisioning
 * input. This is not a manifest echo: the observation is produced by the
 * attested observer reading transport bytes and is only adopted when it matches
 * the expected identity. A transport with nothing observed yields null, and the
 * capability stays unready.
 */
export function adoptObservedCapabilityIdentity(
  expected: {
    operationId: string;
    accountId: string;
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
  },
  /**
   * Live re-observer for later crossings. Without it the adopted snapshot is
   * the only thing admission can re-read, so every crossing more than
   * INDEPENDENT_OBSERVATION_FRESHNESS_MS after acquisition refused with
   * live_observation_stale (every Friday-dashboard SOQL step, 2026-09-02).
   */
  observe?: IndependentObservationRegistration['observe'],
): IndependentCapabilityObservation | null {
  let observerImplementationId: string;
  try {
    observerImplementationId = shippedObserverImplementationId();
  } catch {
    return null;
  }
  let observed: IndependentCapabilityObservation | null;
  try {
    observed = loadShippedImplementations().observeIndependently(expected, observerImplementationId);
  } catch {
    return null;
  }
  if (!observed || observed.origin !== 'independent') return null;
  observations.set(
    keyOf(observed.operationId, observed.accountId),
    observe ? { snapshot: observed, observe } : { snapshot: observed },
  );
  return observed;
}

export function clearIndependentCapabilityObservations(): void {
  observations.clear();
}
