import { createHash } from 'node:crypto';
import { SHIPPED_OBSERVER_SUPPORT_MARK } from './observer-support.js';
import type { IndependentCapabilityObservation } from '../independent-capability-observation.js';
import { requireAttestedTransport } from './attested-transport.js';

void SHIPPED_OBSERVER_SUPPORT_MARK;

function observationIdOf(
  observation: Pick<IndependentCapabilityObservation, 'operationId' | 'accountId' | 'observedAt'>,
): string {
  return `obs:${observation.operationId}:${observation.accountId}:${observation.observedAt}`;
}

function observedBytesDigestOf(
  observation: Pick<IndependentCapabilityObservation, 'operationId' | 'accountId' | 'definitionFingerprint' | 'providerVersion' | 'operationVersion' | 'observedAt'>,
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

export function applyIndependentObserver(
  live: Omit<IndependentCapabilityObservation, 'origin' | 'observationId' | 'observerImplementationId' | 'observedBytesDigest'>,
  expected: Pick<IndependentCapabilityObservation, 'operationId' | 'accountId' | 'definitionFingerprint' | 'providerVersion' | 'operationVersion'>,
  observerImplementationId: string,
): IndependentCapabilityObservation | null {
  if (
    typeof live.operationId !== 'string'
    || live.operationId !== expected.operationId
    || live.accountId !== expected.accountId
    || live.definitionFingerprint !== expected.definitionFingerprint
    || live.providerVersion !== expected.providerVersion
    || live.operationVersion !== expected.operationVersion
    || !Number.isFinite(live.observedAt)
    || live.observedAt <= 0
  ) {
    return null;
  }
  return {
    operationId: live.operationId,
    accountId: live.accountId,
    definitionFingerprint: live.definitionFingerprint,
    providerVersion: live.providerVersion,
    operationVersion: live.operationVersion,
    observedAt: live.observedAt,
    origin: 'independent',
    observationId: observationIdOf(live),
    observerImplementationId,
    observedBytesDigest: observedBytesDigestOf(live),
  };
}

export function observeIndependently(
  expected: Pick<IndependentCapabilityObservation, 'operationId' | 'accountId' | 'definitionFingerprint' | 'providerVersion' | 'operationVersion'>,
  observerImplementationId: string,
): IndependentCapabilityObservation | null {
  const live = requireAttestedTransport().observe({
    operationId: expected.operationId,
    accountId: expected.accountId,
  });
  if (!live) return null;
  return applyIndependentObserver(live, expected, observerImplementationId);
}
